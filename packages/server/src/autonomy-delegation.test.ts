import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { issueAgentCredential } from './agent-credentials.js';
import { readAgentInbox } from './agent-request-service.js';
import { setAgentTrust } from './agent-trust.js';
import { DEFAULT_COMPLETION_REPLY, DEFAULT_DISPATCH_BUDGET, delegateToAgent, postCompletionReply } from './autonomy-delegation.js';
import { noteReportBeyondHandoff, parseHandoff, readHandoff } from './agent-request-handoff-card.js';
import { AUTONOMY_GATE_ACTOR } from './autonomy-gate.js';
import { setWorkflowPolicy } from './autonomy-service.js';
import { proposeWork } from './claim-service.js';
import { createComment, createIssue } from './issue-service.js';
import { writeActorFromViewer } from './work-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

// INV-1493 / decision INV-1497: L3 — intake dispatch, explicit budgeted
// delegation, the completion reply.
loadProjectEnvironment();
const prisma = new PrismaClient();

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

const DESCRIPTION = ['### 1. 目标与架构定位', 'x', '### 2. 核心功能与交付范围', 'x', '### 3. 验收标准与验证方案', 'x', '', '### Steps to reproduce', '1. open'].join('\n');

async function agent(name: string, teamKey: string, ownerId: string, trust: 'OBSERVE' | 'L1' | 'L2' | 'L3' = 'L3') {
  const issued = await issueAgentCredential(prisma, { email: `${name}-${Date.now()}@agents.involute.local`, name, handle: `${name}${Date.now() % 10000}`, ownerId, teamKey, scopes: ['read', 'propose'], issuedById: ownerId });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: issued.credential.userId } });
  await setAgentTrust(prisma, { actorId: user.id, level: trust, reason: 'test' }, ownerId);
  return user;
}

async function fixture(level: 2 | 3, intake = true) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const human = writeActorFromViewer(admin, 'test');
  const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/l3', commitmentStatus: 'COMMITTED' }, human);
  await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 3, reason: 'c' }, admin.id);
  await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level, reason: 't', ...(intake && level === 3 ? { intake: { field: 'type', in: ['improvement'] } } : {}) }, admin.id);
  const lead = await agent('lead', team.key, admin.id);
  const helper = await agent('helper', team.key, admin.id);
  const propose = (title: string, extra: Record<string, unknown> = {}) => proposeWork(prisma, {
    teamId: team.id, title, description: DESCRIPTION, acceptance: 'Fixed and covered by a test.', parentId: project.id, priority: 2, labels: ['improvement'], ...extra,
  } as Parameters<typeof proposeWork>[1], writeActorFromViewer(lead, 'mcp'));
  return { admin, team, human, project, lead, helper, propose };
}

describe('L3 intake dispatch (INV-1493)', () => {
  it('L3 with a matching intake rule: the gate commits and hands the item to an L3 agent, who sees it in agent_inbox with a budget', async () => {
    const { team, lead, helper, propose } = await fixture(3);
    const work = await propose('Improve the thing');
    expect(work.commitmentStatus).toBe('COMMITTED');
    const requests = await prisma.agentRequest.findMany({ where: { workId: work.id }, include: { requestedByActor: true } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.requestedByActor.handle).toBe(AUTONOMY_GATE_ACTOR.handle);
    expect(requests[0]!.budgetUnits).toBe(DEFAULT_DISPATCH_BUDGET);
    expect(requests[0]!.rootRequestId).toBe(requests[0]!.id);
    // The first L3 agent by id got it; both are eligible.
    expect([lead.id, helper.id]).toContain(requests[0]!.targetActorId);
    const inbox = await readAgentInbox(prisma, { actorId: requests[0]!.targetActorId, teamId: team.id });
    expect(inbox.items.map((item) => item.workIdentifier)).toEqual([work.identifier]);
  });

  it('L3 without a matching intake, or L2, commits (if L1 rules allow) but dispatches nothing', async () => {
    const { propose } = await fixture(3, false);
    const work = await propose('Improve the thing');
    expect(work.commitmentStatus).toBe('COMMITTED');
    expect(await prisma.agentRequest.count({ where: { workId: work.id } })).toBe(0);
    await resetAndSeed(prisma);
    const l2 = await fixture(2);
    const other = await l2.propose('Another');
    expect(await prisma.agentRequest.count({ where: { workId: other.id } })).toBe(0);
  });
});

describe('explicit agent→agent delegation (INV-1497)', () => {
  it('L3: a delegation from the dispatched agent opens a request to another agent with root, hop and budget; a mention stays a comment', async () => {
    const { team, lead, helper, propose } = await fixture(3);
    const work = await propose('Improve the thing');
    const dispatched = await prisma.agentRequest.findFirstOrThrow({ where: { workId: work.id } });
    const holder = dispatched.targetActorId === lead.id ? lead : helper;
    const other = holder.id === lead.id ? helper : lead;
    // @mention by an agent: comment only, no request (INV-571 rule kept).
    await createComment(prisma, { body: `@${other.handle} can you look?`, issueId: work.id }, holder.id);
    expect(await prisma.agentRequest.count({ where: { workId: work.id } })).toBe(1);

    const delegated = await delegateToAgent(prisma, { by: { actorId: holder.id, actorKind: 'AGENT' }, workId: work.id, target: `@${other.handle}`, body: 'Write the tests', budgetUnits: 30 });
    expect(delegated.rootRequestId).toBe(dispatched.id);
    expect(delegated.hopCount).toBe(1);
    expect(delegated.budgetUnits).toBe(30);
    expect((await prisma.agentRequest.findUniqueOrThrow({ where: { id: dispatched.id } })).budgetUnits).toBe(DEFAULT_DISPATCH_BUDGET - 30);
    const inbox = await readAgentInbox(prisma, { actorId: other.id, teamId: team.id });
    expect(inbox.items.map((item) => item.body)).toContain('Write the tests');
    // Cycle: the helper cannot delegate back to the holder.
    await expect(delegateToAgent(prisma, { by: { actorId: other.id, actorKind: 'AGENT' }, workId: work.id, target: `@${holder.handle}`, body: 'back to you', budgetUnits: 5 })).rejects.toThrow(/already in this delegation chain/);
  });

  it('carries a hand-off card, shows it in the inbox, and notes a report that goes beyond it (INV-1583)', async () => {
    const { team, lead, helper, propose } = await fixture(3);
    const work = await propose('Improve the other thing');
    const dispatched = await prisma.agentRequest.findFirstOrThrow({ where: { workId: work.id } });
    const holder = dispatched.targetActorId === lead.id ? lead : helper;
    const other = holder.id === lead.id ? helper : lead;

    expect(() => parseHandoff({ allowedActions: ['pr', 'deploy'] })).toThrow(/"deploy" is not one of/);
    expect(() => parseHandoff({ baseCommit: 'xyz' })).toThrow(/Git SHA/);
    expect(parseHandoff({})).toBeNull();

    const handoff = parseHandoff({ baseCommit: 'abc1234', inputs: ['INV-12', 'https://example.test/spec'], allowedActions: ['read', 'edit', 'PR'], acceptance: 'Tests pass.' });
    const delegated = await delegateToAgent(prisma, { by: { actorId: holder.id, actorKind: 'AGENT' }, workId: work.id, target: `@${other.handle}`, body: 'Write the tests', budgetUnits: 30, handoff });
    expect(readHandoff(delegated.request.handoff)).toEqual({ baseCommit: 'abc1234', inputs: ['INV-12', 'https://example.test/spec'], allowedActions: ['read', 'edit', 'pr'], acceptance: 'Tests pass.', exceededActions: [] });
    // The hand-off comment and the inbox both carry the card.
    expect(delegated.comment.body).toContain('allowed: read, edit, pr');
    const inbox = await readAgentInbox(prisma, { actorId: other.id, teamId: team.id });
    expect(readHandoff(inbox.items.find((item) => item.id === delegated.request.id)!.handoff)?.acceptance).toBe('Tests pass.');

    // A PR is allowed; a pushed commit without "push" is noted on the request, once.
    expect(await noteReportBeyondHandoff(prisma, { workId: work.id, actorId: other.id, pullRequestNumber: 7 })).toBeNull();
    const warned = await noteReportBeyondHandoff(prisma, { workId: work.id, actorId: other.id, commitSha: 'a'.repeat(40), pullRequestNumber: 7 });
    expect(warned).toMatch(/goes beyond .* \(push\)/);
    await noteReportBeyondHandoff(prisma, { workId: work.id, actorId: other.id, commitSha: 'b'.repeat(40) });
    expect(readHandoff((await prisma.agentRequest.findUniqueOrThrow({ where: { id: delegated.request.id } })).handoff)?.exceededActions).toEqual(['push']);
    // The holder's own report is not judged by the card it wrote.
    expect(await noteReportBeyondHandoff(prisma, { workId: work.id, actorId: holder.id, commitSha: 'c'.repeat(40) })).toBeNull();
  });

  it('refuses without a root, below L3, for a person, with a bad budget, and when the budget is exhausted it asks the owner', async () => {
    const { admin, team, human, project, lead, helper } = await fixture(2);
    // A human-created committed item in an L2 team: no root and no L3.
    const work = await createIssue(prisma, { teamId: team.id, title: 'Manual', kind: 'ISSUE', parentId: project.id, repository: 'test/l3', commitmentStatus: 'COMMITTED', assigneeId: admin.id, acceptance: 'x' }, human);
    await expect(delegateToAgent(prisma, { by: { actorId: admin.id, actorKind: 'HUMAN' }, workId: work.id, target: `@${helper.handle}`, body: 'x', budgetUnits: 5 })).rejects.toThrow(/Only an agent delegates/);
    await expect(delegateToAgent(prisma, { by: { actorId: lead.id, actorKind: 'AGENT' }, workId: work.id, target: `@${helper.handle}`, body: 'x', budgetUnits: 0 })).rejects.toThrow(/positive budget/);
    await expect(delegateToAgent(prisma, { by: { actorId: lead.id, actorKind: 'AGENT' }, workId: work.id, target: `@${helper.handle}`, body: 'x', budgetUnits: 5 })).rejects.toThrow(/needs a root/);
    // Give it a root (a person asks lead), still L2: refused for the level.
    await createComment(prisma, { body: `@${lead.handle} please handle`, issueId: work.id }, admin.id);
    await expect(delegateToAgent(prisma, { by: { actorId: lead.id, actorKind: 'AGENT' }, workId: work.id, target: `@${helper.handle}`, body: 'x', budgetUnits: 5 })).rejects.toThrow(/Delegation needs L3/);
    // Raise the team to L3: a tiny chain budget runs out and the owner is asked in Needs you.
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 3, reason: 'up' }, admin.id);
    const root = await prisma.agentRequest.findFirstOrThrow({ where: { workId: work.id, targetActorId: lead.id } });
    await prisma.agentRequest.update({ where: { id: root.id }, data: { budgetUnits: 3 } });
    const first = await delegateToAgent(prisma, { by: { actorId: lead.id, actorKind: 'AGENT' }, workId: work.id, target: `@${helper.handle}`, body: 'part one', budgetUnits: 10 });
    expect(first.budgetUnits).toBe(3);
    const third = await agent('third', team.key, admin.id);
    await expect(delegateToAgent(prisma, { by: { actorId: lead.id, actorKind: 'AGENT' }, workId: work.id, target: `@${third.handle}`, body: 'part two', budgetUnits: 1 })).rejects.toThrow(/budget is exhausted/);
    const ask = await prisma.agentRequest.findFirst({ where: { workId: work.id, needInfo: true, targetActorId: admin.id } });
    expect(ask?.body).toContain('Budget exhausted');
  });
});

describe('completion reply (INV-1493)', () => {
  it('posts one templated comment as the gate when an L3 item is Done, notifies the filer once, and never repeats', async () => {
    const { admin, team, human, project, lead } = await fixture(3, false);
    const filer = await prisma.user.create({ data: { name: 'Filer', email: `filer-${Date.now()}@example.com`, actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: filer.id, role: 'EDITOR' } });
    const work = await createIssue(prisma, { teamId: team.id, title: 'Ship it', kind: 'ISSUE', parentId: project.id, repository: 'test/l3', commitmentStatus: 'COMMITTED', assigneeId: admin.id, acceptance: 'x' }, writeActorFromViewer(filer, 'web'));
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 3, completionReply: 'Done: {identifier} — {summary} / {verification}', reason: 'template' }, admin.id);
    const run = { id: 'run', actorId: lead.id, summary: 'Shipped the thing', externalUrl: null, pullRequestNumber: 7 };
    const comment = await postCompletionReply(prisma, work, run);
    expect(comment?.body).toContain(`Done: ${work.identifier} — Shipped the thing / a person`);
    expect(await postCompletionReply(prisma, work, run)).toBeNull();
    expect(await prisma.notification.count({ where: { type: 'policy.completed', userId: filer.id, workId: work.id } })).toBe(1);
    // L2: silent.
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 2, reason: 'down' }, admin.id);
    const quiet = await createIssue(prisma, { teamId: team.id, title: 'Quiet', kind: 'ISSUE', parentId: project.id, repository: 'test/l3', commitmentStatus: 'COMMITTED', assigneeId: admin.id, acceptance: 'x' }, human);
    expect(await postCompletionReply(prisma, quiet, run)).toBeNull();
    expect(DEFAULT_COMPLETION_REPLY).toContain('{followups}');
  });
});
