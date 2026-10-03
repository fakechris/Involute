import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAndSeed, DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import type { GraphQLContext } from './auth.ts';
import { proposeDeliveryChange, decideDeliveryChange } from './delivery-change-set.ts';
import { createDeliveryExecution } from './delivery-execution.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { testParentId } from './test-placement.ts';
import { isWorkReadyForClaim, listReadyWork } from './context-service.ts';
import { snapshotContract } from './evidence-contract.ts';
import { reviewWork } from './run-service-review.ts';
import { commitWork } from './claim-service.ts';
import { createWorkLink } from './link-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
const policy = { units: [
  { key: 'a', title: 'Implement A', criteria: [0], paths: ['src/'], actions: ['edit', 'test'], dependsOn: [], checks: [{ workflowId: 42, job: 'tests' }] },
  { key: 'b', title: 'Implement B', criteria: [1], paths: ['src/'], actions: ['edit', 'test'], dependsOn: ['a'], checks: [{ workflowId: 42, job: 'tests' }] },
  { key: 'c', title: 'Implement C', criteria: [2], paths: ['src/'], actions: ['edit', 'test'], dependsOn: ['b'] },
], environments: [] };
async function fixture(candidate = true) {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
  const agent = await prisma.user.create({ data: { name: 'Delivery agent', email: 'delivery@fixture.local', actorKind: 'AGENT', ownerId: human.id } });
  const parentId = await testParentId(prisma, team.id, 'test/delivery');
  const work = await createIssue(prisma, { teamId: team.id, parentId, title: 'Delivery package', repository: 'test/delivery', scope: 'Approved scope', acceptance: 'A outcome\nB outcome\nC outcome', assigneeId: human.id, stateId: ready.id, commitmentStatus: candidate ? 'CANDIDATE' : 'COMMITTED' });
  const context = (viewer: typeof human): GraphQLContext => ({ prisma, viewer, authMode: 'token', isTrustedSystem: true });
  return { team, human, agent, work, ready, humanContext: context(human), agentContext: context(agent) };
}
async function proof(workId: string, key: string, actorId: string) {
  const work = await prisma.issue.findUniqueOrThrow({ where: { id: workId } });
  const snapshot = snapshotContract(work);
  const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: work.teamId, type: 'REVIEW' } });
  await prisma.issue.update({ where: { id: workId }, data: { stateId: review.id } });
  const run = await prisma.workRun.create({ data: { workId, publicId: `RUN-${randomUUID()}`, actorId, status: 'COMPLETED', claimSnapshotId: randomUUID(), contractRevision: snapshot.contractRevision, acceptanceDigest: snapshot.acceptanceDigest, repository: work.repository, commitSha: 'a'.repeat(40), pullRequestNumber: 10 } });
  const evidence = await prisma.workEvidence.create({ data: { workId, runId: run.id, actorId, kind: 'TEST', url: 'https://github.com/test/delivery/actions/runs/42' } });
  await prisma.evidenceVerification.create({ data: { evidenceId: evidence.id, runId: run.id, verifierId: 'github-app', verifierVersion: '1', status: 'VERIFIED', repository: work.repository, commitSha: run.commitSha, contractRevision: snapshot.contractRevision, acceptanceDigest: snapshot.acceptanceDigest, resultDigest: 'fixture-only', result: { covered: [`${key}-0`], source: { prNumber: 10, workflowId: 42 } } } });
  return { run, evidence };
}

describe('delivery packages and candidate change sets', () => {
  it('approves one candidate, instantiates A→B→C idempotently, and releases technical dependencies without business Done', async () => {
    const f = await fixture();
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Approved implementation plan', changes: { policy } });
    await expect(decideDeliveryChange(f.agentContext, { id: set.id, approve: true })).rejects.toThrow(/Only a person/);
    await decideDeliveryChange(f.humanContext, { id: set.id, approve: true });
    const c = await createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'c', expectedGrantRevision: 1 });
    expect((await createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'c', expectedGrantRevision: 1 })).id).toBe(c.id);
    const units = await prisma.issue.findMany({ where: { deliveryRootId: f.work.id }, orderBy: { deliveryUnitKey: 'asc' } });
    expect(units).toHaveLength(3);
    const [a, b] = units;
    expect(await isWorkReadyForClaim(prisma, a!.id)).toBe(true);
    expect(await isWorkReadyForClaim(prisma, b!.id)).toBe(false);
    await prisma.workLink.deleteMany({ where: { fromId: a!.id, toId: b!.id, type: 'BLOCKS' } });
    expect(await isWorkReadyForClaim(prisma, b!.id)).toBe(false);
    const verified = await proof(a!.id, 'a', f.agent.id);
    expect(await isWorkReadyForClaim(prisma, b!.id)).toBe(true);
    expect((await listReadyWork(prisma)).nodes.map((row) => row.id)).toContain(b!.id);
    await prisma.workEvidence.update({ where: { id: verified.evidence.id }, data: { retractedAt: new Date() } });
    expect(await isWorkReadyForClaim(prisma, b!.id)).toBe(false);
    await prisma.workEvidence.update({ where: { id: verified.evidence.id }, data: { retractedAt: null } });
    await proof(b!.id, 'b', f.agent.id);
    expect(await isWorkReadyForClaim(prisma, c.id)).toBe(true);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: a!.id }, include: { state: true } })).state.type).toBe('REVIEW');
  });

  it('refuses independent child contracts, unknown units, stale grants and a changed root contract', async () => {
    const f = await fixture(false);
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Delegate units', changes: { policy } });
    await decideDeliveryChange(f.humanContext, { id: set.id, approve: true });
    await expect(createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'other', expectedGrantRevision: 1 })).rejects.toThrow(/not approved/);
    await expect(createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'a', expectedGrantRevision: 2 })).rejects.toThrow(/revision changed/);
    const a = await createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'a', expectedGrantRevision: 1 });
    await expect(updateIssue(prisma, a.id, { expectedRevision: a.revision, scope: 'New goal' }, { actorKind: 'HUMAN', actorId: f.human.id })).rejects.toThrow(/Inherited execution/);
    await prisma.issue.update({ where: { id: f.work.id }, data: { acceptance: 'Expanded goal' } });
    expect(await isWorkReadyForClaim(prisma, a.id)).toBe(false);
  });

  it('blocks ordinary commitment while authorization is pending and invalidates grants when the business goal changes', async () => {
    const f = await fixture();
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Approve boundary', changes: { policy } });
    await expect(commitWork(prisma, f.work.id, { expectedRevision: f.work.revision, assigneeId: f.human.id }, { actorKind: 'HUMAN', actorId: f.human.id })).rejects.toThrow(/pending delivery/);
    await decideDeliveryChange(f.humanContext, { id: set.id, approve: true });
    const a = await createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'a', expectedGrantRevision: 1 });
    await prisma.issue.update({ where: { id: f.work.id }, data: { outcome: 'Different business outcome' } });
    expect(await isWorkReadyForClaim(prisma, a.id)).toBe(false);
  });

  it('accepts all implementation units with one package decision, and rolls back incomplete delivery', async () => {
    const f = await fixture();
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Approve package', changes: { policy } });
    await decideDeliveryChange(f.humanContext, { id: set.id, approve: true });
    await createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'c', expectedGrantRevision: 1 });
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.team.id, type: 'REVIEW' } });
    const root = await prisma.issue.update({ where: { id: f.work.id }, data: { stateId: review.id } });
    const actor = { actorKind: 'HUMAN' as const, actorId: f.human.id };
    await expect(reviewWork(prisma, root.id, { expectedRevision: root.revision, decision: 'ACCEPTED' }, actor)).rejects.toThrow(/not ready/);
    expect(await prisma.workReviewDecision.count({ where: { workId: root.id } })).toBe(0);
    const tasks = await prisma.issue.findMany({ where: { deliveryRootId: root.id } });
    for (const task of tasks) await proof(task.id, task.deliveryUnitKey!, f.agent.id);
    await reviewWork(prisma, root.id, { expectedRevision: root.revision, decision: 'ACCEPTED' }, actor);
    const accepted = await prisma.issue.findMany({ where: { id: { in: [root.id, ...tasks.map((task) => task.id)] } }, include: { state: true } });
    expect(accepted.every((work) => work.state.type === 'COMPLETED')).toBe(true);
    expect(await prisma.workReviewDecision.count({ where: { workId: { in: tasks.map((task) => task.id) }, reviewerId: f.human.id, decision: 'ACCEPTED' } })).toBe(3);
  });

  it('returns every unit for changes and invalidates previous CI proof after a package rejection', async () => {
    const f = await fixture();
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Approve package', changes: { policy } });
    await decideDeliveryChange(f.humanContext, { id: set.id, approve: true });
    await createDeliveryExecution(f.agentContext, { workId: f.work.id, unitKey: 'c', expectedGrantRevision: 1 });
    const tasks = await prisma.issue.findMany({ where: { deliveryRootId: f.work.id }, orderBy: { deliveryUnitKey: 'asc' } });
    for (const task of tasks) await proof(task.id, task.deliveryUnitKey!, f.agent.id);
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.team.id, type: 'REVIEW' } });
    const root = await prisma.issue.update({ where: { id: f.work.id }, data: { stateId: review.id } });
    await reviewWork(prisma, root.id, { expectedRevision: root.revision, decision: 'REJECTED', reason: 'The outcome needs correction.' }, { actorKind: 'HUMAN', actorId: f.human.id });
    expect(await isWorkReadyForClaim(prisma, tasks[0]!.id)).toBe(true);
    expect(await isWorkReadyForClaim(prisma, tasks[1]!.id)).toBe(false);
    expect(await prisma.workReviewDecision.count({ where: { workId: { in: tasks.map((task) => task.id) }, decision: 'REJECTED' } })).toBe(3);
    expect(await prisma.workRun.count({ where: { workId: { in: tasks.map((task) => task.id) }, executionRevokedAt: null } })).toBe(0);
  });

  it('rolls back all merge and contract changes on any revision conflict', async () => {
    const f = await fixture(false);
    const source = await createIssue(prisma, { teamId: f.team.id, parentId: f.work.parentId, title: 'Source', repository: f.work.repository, acceptance: 'Old scope' });
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Combine scope', changes: { contract: { scope: 'Combined scope' }, mergeSourceIds: [source.id] } });
    await prisma.issue.update({ where: { id: source.id }, data: { revision: { increment: 1 } } });
    await expect(decideDeliveryChange(f.humanContext, { id: set.id, approve: true })).rejects.toThrow(/conflicts/);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: f.work.id } })).scope).toBe('Approved scope');
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: source.id } })).supersededById).toBeNull();
    expect((await prisma.deliveryChangeSet.findUniqueOrThrow({ where: { id: set.id } })).status).toBe('PENDING');
  });

  it('preserves source evidence and rewires dependencies on an approved consolidation', async () => {
    const f = await fixture(false);
    const create = (title: string) => createIssue(prisma, { teamId: f.team.id, parentId: f.work.parentId, title, repository: f.work.repository, acceptance: 'Existing scope' });
    const source = await create('Source'); const next = await create('Next');
    await createWorkLink(prisma, { fromId: source.id, toId: next.id, type: 'BLOCKS' });
    const evidence = await prisma.workEvidence.create({ data: { workId: source.id, kind: 'ARTIFACT', url: 'https://example.com/retained-proof' } });
    const set = await proposeDeliveryChange(f.agentContext, { workId: f.work.id, expectedRevision: f.work.revision, reason: 'Combine duplicate scope', changes: { mergeSourceIds: [source.id] } });
    await decideDeliveryChange(f.humanContext, { id: set.id, approve: true });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: source.id } })).supersededById).toBe(f.work.id);
    expect(await prisma.workLink.count({ where: { fromId: f.work.id, toId: next.id, type: 'BLOCKS' } })).toBe(1);
    expect(await prisma.workEvidence.findUnique({ where: { id: evidence.id } })).toMatchObject({ workId: source.id, supersededByWorkId: f.work.id });
  });
});
