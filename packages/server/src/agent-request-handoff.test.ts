import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { expireOverdueAgentRequests } from './agent-request-expiry.ts';
import { DEADLINE_FAILURE_REASON } from './agent-request-expiry.ts';
import { MAX_HANDOFF_HOPS } from './agent-request-handoff.ts';
import { answerAgentRequest, claimAgentRequest } from './agent-request-service.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('successor hand-off (INV-589)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('hands an overdue request to the declared successor as a NEW request on the same thread', async () => {
    const { admin, issue, mia, request, rootCommentId } = await overdueRequest(prisma);
    const kai = await agent(prisma, 'kai', admin.id);
    await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: kai.id } });

    await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(1);

    const old = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(old.state).toBe('FAILED');
    // The reason stays what was observed; the hand-off is on the link, not the reason.
    expect(old.failureReason).toBe(DEADLINE_FAILURE_REASON);
    expect(old.rootRequestId).toBe(request.id);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.state).toBe('SUBMITTED');
    expect(next.targetActorId).toBe(kai.id);
    expect(next.rootCommentId).toBe(rootCommentId);      // same thread
    expect(next.rootRequestId).toBe(request.id);
    expect(next.hopCount).toBe(1);
    expect(next.workId).toBe(issue.id);
    expect(next.claimedBy).toBeNull();                    // successor takes it like any other request

    const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: rootCommentId } });
    expect(notice.body).toContain('Handed to @kai (its declared successor)');
    expect(notice.body).toContain('in their own name');
  });

  it('falls back to the owner, then to team owners, when there is no eligible successor', async () => {
    const { admin, request } = await overdueRequest(prisma);   // mia's owner is admin

    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.targetActorId).toBe(admin.id);
    const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: next.rootCommentId } });
    expect(notice.body).toContain('(its owner)');
  });

  it('a cyclic successor chain still escalates to a human within the hop limit', async () => {
    // A.successor = B, B.successor = A — "every actor has an owner" never
    // reaches the owner here. The visited set and hop limit must.
    const { admin, mia: a, request } = await overdueRequest(prisma);
    const b = await agent(prisma, 'b', admin.id);
    await prisma.user.update({ where: { id: a.id }, data: { successorActorId: b.id } });
    await prisma.user.update({ where: { id: b.id }, data: { successorActorId: a.id } });

    let current = request.id;
    const targets: string[] = [];
    for (let hop = 0; hop < MAX_HANDOFF_HOPS + 2; hop += 1) {
      await prisma.agentRequest.update({ where: { id: current }, data: { deadlineAt: new Date(Date.now() - 1000) } });
      const n = await expireOverdueAgentRequests(prisma);
      if (n === 0) break;
      const next = await prisma.agentRequest.findFirst({ where: { handedOffFromId: current } });
      if (!next) break;
      targets.push(next.targetActorId);
      current = next.id;
    }

    // A → B (hop 1), B → A is visited so it goes to owner (hop 2): a human.
    expect(targets[0]).toBe(b.id);
    expect(targets[targets.length - 1]).toBe(admin.id);
    expect(targets.length).toBeLessThanOrEqual(MAX_HANDOFF_HOPS);
    const last = await prisma.agentRequest.findUniqueOrThrow({ where: { id: current } });
    const lastTarget = await prisma.user.findUniqueOrThrow({ where: { id: last.targetActorId } });
    expect(lastTarget.actorKind).toBe('HUMAN');
  });

  it('skips a successor with no credential on the team, and says so in the notice', async () => {
    const { admin, mia, request } = await overdueRequest(prisma);
    const outsider = await agent(prisma, 'outsider', admin.id, { member: false });
    await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: outsider.id } });

    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.targetActorId).toBe(admin.id);
    const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: next.rootCommentId } });
    expect(notice.body).toContain('no credential on this team');
  });

  it('skips a human who can only view the team: they could receive but never answer', async () => {
    const { admin, mia, request } = await overdueRequest(prisma);
    const viewer = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'viewer@humans.test.local', name: 'Viewer' } });
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    await prisma.teamMembership.create({ data: { role: 'VIEWER', teamId: team.id, userId: viewer.id } });
    await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: viewer.id } });

    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.targetActorId).toBe(admin.id);
    const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: next.rootCommentId } });
    expect(notice.body).toContain('cannot write on this team');
  });

  it('skips an agent whose credential on the team lacks the answer scope', async () => {
    const { admin, mia, request } = await overdueRequest(prisma);
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const reader = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'reader@agents.test.local', handle: 'reader', name: 'Reader', ownerId: admin.id } });
    await prisma.agentCredential.create({ data: { name: 'ro', scopes: ['read'], teamId: team.id, tokenHash: 'h-'.padEnd(24, 'r'), userId: reader.id } });
    await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: reader.id } });

    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.targetActorId).toBe(admin.id);
    const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: next.rootCommentId } });
    expect(notice.body).toContain('claim and answer scopes');
  });

  it('skips a SERVICE or deactivated successor', async () => {
    const { admin, mia, request } = await overdueRequest(prisma);
    const service = await prisma.user.create({
      data: { actorKind: 'SERVICE', email: 'svc@services.test.local', handle: 'svc', name: 'Svc', ownerId: admin.id },
    });
    await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: service.id } });

    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.targetActorId).toBe(admin.id);
  });

  it('is atomic and idempotent: one sweep, one hand-off; a second sweep does nothing', async () => {
    const { request } = await overdueRequest(prisma);

    await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(1);
    await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(0);

    await expect(prisma.agentRequest.count({ where: { handedOffFromId: request.id } })).resolves.toBe(1);
    await expect(prisma.eventOutbox.count({ where: { type: 'agent.request_handed_off' } })).resolves.toBe(1);
  });

  it('a late answer from the previous holder loses: its request is terminal', async () => {
    const { mia, request } = await overdueRequest(prisma, { claimFirst: true });
    const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, new Date(Date.now() - 5000));
    await prisma.agentRequest.update({ where: { id: request.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });

    await expireOverdueAgentRequests(prisma);

    await expect(answerAgentRequest(prisma, {
      actorId: mia.id, body: 'too late', claimToken: held.claimToken, id: request.id,
    })).rejects.toThrow(/terminal/);
  });

  it('the successor answers the new request in its own name; the old one cannot be answered', async () => {
    const { admin, mia, request } = await overdueRequest(prisma);
    const kai = await agent(prisma, 'kai', admin.id);
    await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: kai.id } });
    await expireOverdueAgentRequests(prisma);
    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });

    const held = await claimAgentRequest(prisma, { actorId: kai.id, id: next.id });
    const answered = await answerAgentRequest(prisma, {
      actorId: kai.id, body: 'Answering for @mia from the record.', claimToken: held.claimToken, id: next.id,
    });

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: answered.commentId } });
    expect(comment.userId).toBe(kai.id);                 // its own name, never mia's
    expect(comment.parentCommentId).toBe(request.rootCommentId);

    // mia cannot answer the old one even with a fresh claim attempt.
    await expect(claimAgentRequest(prisma, { actorId: mia.id, id: request.id })).rejects.toThrow(/not claimable/);
  });

  it('a human reached after the chain deadline gets a real window, not a request already expired', async () => {
    const { request } = await overdueRequest(prisma);
    // The chain's total budget is already spent.
    await prisma.agentRequest.update({ where: { id: request.id }, data: { chainDeadlineAt: new Date(Date.now() - 1000) } });

    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    const target = await prisma.user.findUniqueOrThrow({ where: { id: next.targetActorId } });
    expect(target.actorKind).toBe('HUMAN');
    expect(next.deadlineAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    // and a second sweep does not immediately fail it
    await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(0);
  });

  it('records the hand-off on the audit trail', async () => {
    const { request } = await overdueRequest(prisma);
    await expireOverdueAgentRequests(prisma);
    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });

    const audits = await prisma.workAudit.findMany({
      where: { surface: { in: ['agent_request.expired', 'agent_request.handed-off'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => [a.surface, a.sourceMessageId])).toEqual([
      ['agent_request.expired', request.id],
      ['agent_request.handed-off', next.id],
    ]);
  });

  it('when nobody is eligible, the old request stays failed and the notice is an explicit dead end', async () => {
    const { admin, request } = await overdueRequest(prisma);
    // Remove every path: owner deactivated, no other team owners.
    await prisma.user.update({ where: { id: admin.id }, data: { deactivatedAt: new Date() } });

    await expireOverdueAgentRequests(prisma);

    await expect(prisma.agentRequest.count({ where: { handedOffFromId: request.id } })).resolves.toBe(0);
    const old = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(old.state).toBe('FAILED');
    const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: request.rootCommentId } });
    expect(notice.body).toMatch(/No successor is declared|no human contact/);
  });
});

async function agent(client: PrismaClient, handle: string, ownerId: string, opts: { member?: boolean } = {}): Promise<User> {
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const user = await client.user.create({
    data: { actorKind: 'AGENT', email: `${handle}@agents.test.local`, handle, name: handle, ownerId },
  });
  if (opts.member !== false) {
    // An agent is part of a team by credential (INV-592); answering needs the
    // claim and answer scopes on it (INV-596 follow-up).
    await client.agentCredential.create({
      data: { name: handle, scopes: ['read', 'claim', 'answer'], teamId: team.id, tokenHash: `h-${handle}`.padEnd(24, 'x'), userId: user.id },
    });
  }
  return user;
}

async function overdueRequest(
  client: PrismaClient,
  opts: { claimFirst?: boolean } = {},
): Promise<{ admin: User; issue: Issue; mia: User; request: { id: string; rootCommentId: string }; rootCommentId: string }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
  const mia = await agent(client, 'mia', admin.id);
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await client.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
  const issue = await client.issue.create({ data: { identifier: 'INV-940', stateId: state.id, teamId: team.id, title: 'Hand-off host' } });
  const comment = await createComment(client, { body: '@mia why did you decide that?', issueId: issue.id }, admin.id);
  const request = await client.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
  if (!opts.claimFirst) {
    await client.agentRequest.update({ where: { id: request.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });
  }
  return { admin, issue, mia, request, rootCommentId: comment.id };
}
