import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAndSeed, DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import type { GraphQLContext } from './auth.js';
import { createIssue } from './issue-service.js';
import { testParentId } from './test-placement.js';
import { proposeDeliveryChange, decideDeliveryChange } from './delivery-change-set.js';
import { createDeliveryExecution } from './delivery-execution.js';
import { claimWork } from './claim-service.js';
import { reportRun } from './run-service.js';
import { writeActorFromViewer } from './work-service.js';
import { executorContext, executorUpdate, type ExecutorInput } from './executor-service.js';

// INV-1025: the last unit's final receipt moves the root to In Review and
// tells the owner; while units are outstanding the root does not move.
loadProjectEnvironment();
const prisma = new PrismaClient();
beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
const sha = 'a'.repeat(40);

async function fixture() {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
  const agent = await prisma.user.create({ data: { name: 'Executor', email: 'executor@fixture.test', actorKind: 'AGENT', ownerId: human.id } });
  const humanContext: GraphQLContext = { prisma, viewer: human, authMode: 'token', isTrustedSystem: true };
  const agentContext: GraphQLContext = { prisma, viewer: agent, authMode: 'token', isTrustedSystem: true };
  const root = await createIssue(prisma, { teamId: team.id, parentId: await testParentId(prisma, team.id, 'test/executor'), title: 'Delivery', repository: 'test/executor', scope: 'Change src only', acceptance: 'Working delivery', assigneeId: human.id, stateId: ready.id, commitmentStatus: 'CANDIDATE' });
  const unit = (key: string) => ({ key, title: `Unit ${key}`, criteria: [0], paths: ['src/'], actions: ['edit', 'test', 'deploy'], executorActorId: agent.id, maxAttempts: 2 });
  const proposal = await proposeDeliveryChange(agentContext, { workId: root.id, expectedRevision: root.revision, reason: 'Two units', changes: { policy: { environments: ['staging'], units: [unit('a'), unit('b')] } } });
  await decideDeliveryChange(humanContext, { id: proposal.id, approve: true });
  const actor = writeActorFromViewer(agent);

  async function deliverUnit(key: string) {
    const work = await createDeliveryExecution(agentContext, { workId: root.id, unitKey: key, expectedGrantRevision: 1 });
    const claim = await claimWork(prisma, work.id, {}, actor);
    const run = (await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'running', commitSha: sha, pullRequestNumber: 12 }, actor)).run;
    await executorUpdate(humanContext, { workId: work.id, operation: 'dispatch' });
    const current = async () => (await executorContext(agentContext, work.id)).dispatches[0]!;
    async function update(operation: ExecutorInput['operation'], details: Partial<ExecutorInput> = {}) {
      const row = await current();
      return executorUpdate(agentContext, { workId: work.id, operation, expectedRevision: row.revision, generation: row.generation, claimToken: claim.claimToken!, ...details });
    }
    await update('ack', { runId: run.id });
    const effect = await update('prepare_effect', { effect: { key: `deploy-${key}`, action: 'deploy' as const, environment: 'staging', commitSha: sha, paths: ['src/index.ts'] } });
    await update('start_effect', { effectId: effect.id });
    const receipt = { version: 1, repository: 'test/executor', commitSha: sha, pullRequestNumber: 12, environment: 'staging', deployedSha: sha, health: 'pass', behavior: 'pass', evidenceUrls: ['https://example.test/delivery'], observedAt: new Date().toISOString() };
    await update('receipt', { idempotencyKey: `receipt-${key}`, effectId: effect.id, receipt });
    expect((await current()).visibleState).toBe('DELIVERED');
    return work;
  }

  const rootState = async () => (await prisma.issue.findUniqueOrThrow({ where: { id: root.id }, include: { state: true } })).state.type;
  const ownerNotices = () => prisma.notification.findMany({ where: { userId: human.id, workId: root.id, type: 'run.completed' } });
  return { root, human, deliverUnit, rootState, ownerNotices };
}

describe('delivery root review (INV-1025)', () => {
  it('moves the root to In Review and tells the owner only once every unit is delivered', async () => {
    const f = await fixture();
    await f.deliverUnit('a');
    expect(await f.rootState()).not.toBe('REVIEW');
    expect(await f.ownerNotices()).toHaveLength(0);

    await f.deliverUnit('b');
    expect(await f.rootState()).toBe('REVIEW');
    const notices = await f.ownerNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ phase: 'deliver' });
    expect(String((notices[0]?.payload as { summary?: string }).summary)).toContain('2 implementation units delivered');
    const event = await prisma.eventOutbox.findFirst({ where: { type: 'run.completed', payload: { path: ['work', 'id'], equals: f.root.id } } });
    expect(event).not.toBeNull();
  });
});
