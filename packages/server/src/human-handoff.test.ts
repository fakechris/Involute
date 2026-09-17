import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { expireOverdueAgentRequests } from './agent-request-expiry.ts';
import {
  HUMAN_ANSWER_NOT_TARGET_MESSAGE,
  HUMAN_ANSWER_OVERRIDE_REASON_REQUIRED_MESSAGE,
  REQUEST_ALREADY_TERMINAL_MESSAGE,
  answerAgentRequestAsHuman,
} from './agent-request-service.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * INV-596. Reproduced by the review: a request handed to a human owner
 * produced no notification for the owner; the owner replied in the thread;
 * the request stayed SUBMITTED and then failed on its deadline. A hand-off
 * to a person that no person could complete.
 */
describe('human hand-off completion (INV-596)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('the person handed the request is notified; the asker gets the status update', async () => {
    const { owner, asker, request } = await overdueToOwner(prisma);
    await expireOverdueAgentRequests(prisma);

    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
    expect(next.targetActorId).toBe(owner.id);

    const toOwner = await prisma.notification.findMany({ where: { userId: owner.id, type: 'agent.request_handed_off' } });
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]!.payload).toMatchObject({ requestId: next.id, fromRequestId: request.id });

    const toAsker = await prisma.notification.findMany({ where: { userId: asker.id, type: 'agent.request_expired' } });
    expect(toAsker).toHaveLength(1);
    expect(toAsker[0]!.payload).toMatchObject({ handedOffToRequestId: next.id });
  });

  it('the target answers: comment in the thread, answeredCommentId, COMPLETED, audit and event, atomically', async () => {
    const { owner, request } = await overdueToOwner(prisma);
    await expireOverdueAgentRequests(prisma);
    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });

    const answered = await answerAgentRequestAsHuman(prisma, { body: 'Here is the answer.', by: human(owner), id: next.id });

    const fresh = await prisma.agentRequest.findUniqueOrThrow({ where: { id: next.id } });
    expect(fresh.state).toBe('COMPLETED');
    expect(fresh.answeredCommentId).toBe(answered.commentId);
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: answered.commentId } });
    expect(comment.parentCommentId).toBe(next.rootCommentId);
    expect(comment.userId).toBe(owner.id);
    await expect(prisma.workAudit.count({ where: { sourceMessageId: next.id, surface: 'agent_request.answered', actorId: owner.id } })).resolves.toBe(1);
    await expect(prisma.eventOutbox.count({ where: { type: 'agent.request_answered' } })).resolves.toBe(1);

    // and the next sweep has nothing to fail
    await prisma.agentRequest.update({ where: { id: next.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });
    await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(0);
  });

  it('an ordinary thread reply does not complete the request', async () => {
    const { owner, request } = await overdueToOwner(prisma);
    await expireOverdueAgentRequests(prisma);
    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });

    await createComment(prisma, { body: 'thinking about it', issueId: next.workId, parentCommentId: next.rootCommentId }, owner.id);

    const fresh = await prisma.agentRequest.findUniqueOrThrow({ where: { id: next.id } });
    expect(fresh.state).toBe('SUBMITTED');
    expect(fresh.answeredCommentId).toBeNull();
  });

  it('someone who is not the target is refused; an ADMIN may override with a recorded reason', async () => {
    const { admin, asker, request } = await overdueToOwner(prisma);
    await expireOverdueAgentRequests(prisma);
    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });

    await expect(answerAgentRequestAsHuman(prisma, { body: 'me', by: human(asker), id: next.id }))
      .rejects.toThrow(HUMAN_ANSWER_NOT_TARGET_MESSAGE);
    await expect(answerAgentRequestAsHuman(prisma, { body: 'me', by: human(admin), id: next.id }))
      .rejects.toThrow(HUMAN_ANSWER_OVERRIDE_REASON_REQUIRED_MESSAGE);

    await answerAgentRequestAsHuman(prisma, { body: 'owner is away', by: human(admin), id: next.id, overrideReason: 'owner on leave' });
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { sourceMessageId: next.id, surface: 'agent_request.answered' } });
    expect(audit.actorId).toBe(admin.id);
    expect(audit.reason).toContain('override: owner on leave');
  });

  it('a late or repeated submission is refused by the state CAS', async () => {
    const { owner, request } = await overdueToOwner(prisma);
    await expireOverdueAgentRequests(prisma);
    const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });

    await answerAgentRequestAsHuman(prisma, { body: 'first', by: human(owner), id: next.id });
    await expect(answerAgentRequestAsHuman(prisma, { body: 'second', by: human(owner), id: next.id }))
      .rejects.toThrow(REQUEST_ALREADY_TERMINAL_MESSAGE);
    await expect(prisma.comment.count({ where: { parentCommentId: next.rootCommentId, userId: owner.id } })).resolves.toBe(1);
  });
});

function human(user: User): { actorId: string; actorKind: 'HUMAN'; globalRole: 'ADMIN' | 'USER' } {
  return { actorId: user.id, actorKind: 'HUMAN', globalRole: user.globalRole };
}

async function overdueToOwner(client: PrismaClient): Promise<{ admin: User; asker: User; owner: User; request: { id: string } }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const owner = await client.user.create({ data: { actorKind: 'HUMAN', email: 'owner@humans.test.local', globalRole: 'USER', name: 'Owner' } });
  const asker = await client.user.create({ data: { actorKind: 'HUMAN', email: 'asker@humans.test.local', globalRole: 'USER', name: 'Asker' } });
  await client.teamMembership.createMany({ data: [
    { role: 'EDITOR', teamId: team.id, userId: owner.id },
    { role: 'EDITOR', teamId: team.id, userId: asker.id },
  ] });
  const mia = await client.user.create({ data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: owner.id } });
  await client.agentCredential.create({ data: { name: 'c', teamId: team.id, tokenHash: 'h-'.padEnd(24, 'x'), userId: mia.id } });
  const state = await client.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
  const issue = await client.issue.create({ data: { identifier: 'INV-970', stateId: state.id, teamId: team.id, title: 'Handed to a person' } });
  await createComment(client, { body: '@mia why?', issueId: issue.id }, asker.id);
  const request = await client.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
  await client.agentRequest.update({ where: { id: request.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });
  return { admin, asker, owner, request };
}
