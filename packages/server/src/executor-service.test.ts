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
import { reviewWork } from './run-service-review.js';
import { reportRun } from './run-service.js';
import { writeActorFromViewer } from './work-service.js';
import { executorContext, executorUpdate, type ExecutorInput } from './executor-service.js';
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
  const proposal = await proposeDeliveryChange(agentContext, { workId: root.id, expectedRevision: root.revision, reason: 'Explicit executor', changes: { policy: { environments: ['staging'], units: [{ key: 'a', title: 'Implementation', criteria: [0], paths: ['src/'], actions: ['edit', 'test', 'deploy'], executorActorId: agent.id, maxAttempts: 2 }] } } });
  await decideDeliveryChange(humanContext, { id: proposal.id, approve: true });
  const work = await createDeliveryExecution(agentContext, { workId: root.id, unitKey: 'a', expectedGrantRevision: 1 });
  const actor = writeActorFromViewer(agent);
  const claim = await claimWork(prisma, work.id, {}, actor);
  const run = (await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'running', commitSha: sha, pullRequestNumber: 12 }, actor)).run;
  await executorUpdate(humanContext, { workId: work.id, operation: 'dispatch' });
  const current = async () => (await executorContext(agentContext, work.id)).dispatches[0]!;
  async function update(operation: ExecutorInput['operation'], details: Partial<ExecutorInput> = {}, context = agentContext) {
    const row = await current();
    return executorUpdate(context, { workId: work.id, operation, expectedRevision: row.revision, generation: row.generation, claimToken: claim.claimToken!, ...details });
  }
  await update('ack', { runId: run.id });
  return { humanContext, agentContext, actor, root, work, agent, claim, run, current, update };
}
const intent = { key: 'deploy-1', action: 'deploy' as const, environment: 'staging', commitSha: sha, paths: ['src/index.ts'] };
describe('external executor authority and receipts', () => {
  it('rejects unapproved action, environment and paths before issuing an effect', async () => {
    const f = await fixture();
    for (const effect of [{ ...intent, action: 'merge' as const, environment: undefined }, { ...intent, environment: 'production' }, { ...intent, paths: ['src/../secret'] }, { ...intent, paths: ['other/file.ts'] }]) await expect(f.update('prepare_effect', { effect })).rejects.toThrow(/approved/);
    expect(await prisma.executorEffect.count()).toBe(0);
  });
  it('rechecks stop and grant revocation after preparing an external effect', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('stop', {}, f.humanContext);
    await expect(f.update('start_effect', { effectId: effect.id })).rejects.toThrow(/stopped/);
    expect((await f.current()).visibleState).toBe('STOP_REQUESTED');
    await f.update('stop_ack');
    expect((await f.current()).visibleState).toBe('STOPPED');
    await prisma.deliveryPackage.update({ where: { workId: f.root.id }, data: { revokedAt: new Date() } });
    await expect(f.update('prepare_effect', { effect: intent })).rejects.toThrow(/revoked/);
  });
  it('never starts an effect twice and leaves an unknown external result unreplayed', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('start_effect', { effectId: effect.id });
    await expect(f.update('start_effect', { effectId: effect.id })).rejects.toThrow(/unknown result/);
    await prisma.workClaim.update({ where: { id: f.claim.claim.id }, data: { leaseUntil: new Date(0) } });
    await prisma.executorDispatch.update({ where: { id: (await f.current()).id }, data: { leaseUntil: new Date(0) } });
    await expect(f.update('recover', {}, f.humanContext)).rejects.toThrow(/unknown result/);
    expect((await f.current()).visibleState).toBe('UNKNOWN');
  });
  it('binds a receipt to the run and displays a release mismatch without asserting acceptance', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('start_effect', { effectId: effect.id });
    const receipt = { version: 1, repository: 'test/executor', commitSha: sha, pullRequestNumber: 12, environment: 'staging', deployedSha: 'b'.repeat(40), health: 'pass', behavior: 'unknown', evidenceUrls: ['https://example.test/delivery'], observedAt: new Date().toISOString() };
    await expect(f.update('receipt', { idempotencyKey: 'receipt-1', effectId: effect.id, receipt: { ...receipt, commitSha: 'c'.repeat(40) } })).rejects.toThrow(/provenance/);
    await f.update('receipt', { idempotencyKey: 'receipt-1', effectId: effect.id, receipt });
    const row = await f.current();
    expect(row.visibleState).toBe('DELIVERED');
    expect(row.receipts[0]?.assessment).toMatchObject({ versionMatches: false, productionAccepted: false, provenance: 'executor-reported' });
  });
  it('refuses another actor and an old execution token, including for the same agent', async () => {
    const f = await fixture();
    await expect(f.update('checkpoint', { checkpoint: 'saved' }, f.humanContext)).rejects.toThrow(/Only the approved executor/);
    await expect(f.update('checkpoint', { checkpoint: 'saved', claimToken: 'wrong' })).rejects.toThrow(/lease/);
    await prisma.user.update({ where: { id: f.agent.id }, data: { deactivatedAt: new Date() } });
    await expect(f.update('checkpoint', { checkpoint: 'saved' })).rejects.toThrow(/active/);
  });
  it('replays identical receipts without duplicating them and returns work to the same executor', async () => {
    const f = await fixture();
    const receipt = { version: 1, repository: 'test/executor', commitSha: sha, pullRequestNumber: 12, environment: null, deployedSha: null, health: 'unknown', behavior: 'pass', evidenceUrls: [], observedAt: new Date().toISOString() };
    await f.update('receipt', { idempotencyKey: 'stable', receipt });
    await reportRun(prisma, { workId: f.work.id, runId: f.run.id, claimToken: f.claim.claimToken!, status: 'completed' }, f.actor);
    await f.update('receipt', { idempotencyKey: 'stable', receipt });
    expect(await prisma.executorDeliveryReceipt.count()).toBe(1);
    await expect(f.update('receipt', { idempotencyKey: 'stable', receipt: { ...receipt, health: 'fail' } })).rejects.toThrow(/different facts/);
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.work.teamId, type: 'REVIEW' } });
    const root = await prisma.issue.update({ where: { id: f.root.id }, data: { stateId: review.id } });
    await reviewWork(prisma, root.id, { expectedRevision: root.revision, decision: 'REJECTED', reason: 'Improve the release marker' }, writeActorFromViewer(f.humanContext.viewer));
    const row = await f.current();
    expect(row).toMatchObject({ state: 'QUEUED', generation: 2, executorActorId: f.agent.id, feedback: 'Improve the release marker' });
    expect((await prisma.workRun.findUniqueOrThrow({ where: { id: f.run.id } })).executionRevokedAt).not.toBeNull();
    await expect(f.update('checkpoint', { checkpoint: 'old execution' })).rejects.toThrow(/missing, stale or revoked/);
  });
  it('retains an unknown external outcome after a process stop acknowledgement', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('start_effect', { effectId: effect.id });
    await f.update('stop', {}, f.humanContext);
    await f.update('stop_ack');
    expect((await f.current()).visibleState).toBe('UNKNOWN');
  });
  it('refuses a new key while any external effect remains unresolved', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('start_effect', { effectId: effect.id });
    await expect(f.update('prepare_effect', { effect: { ...intent, key: 'try-again' } })).rejects.toThrow(/unknown result/);
  });
  it('records evidence-backed human reconciliation before allowing recovery', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('start_effect', { effectId: effect.id });
    await f.update('stop', {}, f.humanContext);
    await f.update('stop_ack');
    const resolution = { outcome: 'FAILED' as const, reason: 'External audit confirms operation did not complete', evidenceUrl: 'https://example.test/external-audit' };
    await expect(f.update('reconcile', { effectId: effect.id, resolution })).rejects.toThrow(/Only a person/);
    await expect(f.update('reconcile', { effectId: effect.id, resolution }, f.humanContext)).rejects.toThrow(/Release the active/);
    await prisma.workClaim.update({ where: { id: f.claim.claim.id }, data: { leaseUntil: new Date(0) } });
    await f.update('reconcile', { effectId: effect.id, resolution }, f.humanContext);
    expect((await prisma.executorEffect.findUniqueOrThrow({ where: { id: effect.id } })).state).toBe('RECONCILED_FAILED');
    await f.update('recover', {}, f.humanContext);
    expect((await f.current()).generation).toBe(2);
  });
  it('rechecks a merge head after intent preparation', async () => {
    const f = await fixture();
    const grant = await prisma.deliveryPackage.findUniqueOrThrow({ where: { workId: f.root.id } });
    const policy = grant.policy as { units: Array<{ actions: string[] }> };
    policy.units[0]!.actions.push('merge');
    await prisma.deliveryPackage.update({ where: { workId: f.root.id }, data: { policy } });
    const effect = await f.update('prepare_effect', { effect: { ...intent, action: 'merge', environment: undefined } });
    await reportRun(prisma, { workId: f.work.id, runId: f.run.id, claimToken: f.claim.claimToken!, status: 'running', commitSha: 'b'.repeat(40) }, f.actor);
    await expect(f.update('start_effect', { effectId: effect.id })).rejects.toThrow(/bound PR head/);
  });
  it('observes a merge then deploys without an intermediate human decision', async () => {
    const f = await fixture();
    const grant = await prisma.deliveryPackage.findUniqueOrThrow({ where: { workId: f.root.id } });
    const policy = grant.policy as { units: Array<{ actions: string[] }> };
    policy.units[0]!.actions.push('merge');
    await prisma.deliveryPackage.update({ where: { workId: f.root.id }, data: { policy } });
    const merge = await f.update('prepare_effect', { effect: { ...intent, action: 'merge', environment: undefined } });
    await f.update('start_effect', { effectId: merge.id });
    const receipt = { version: 1, repository: 'test/executor', commitSha: sha, pullRequestNumber: 12, mergedSha: 'b'.repeat(40), environment: null, deployedSha: null, health: 'unknown', behavior: 'unknown', evidenceUrls: ['https://example.test/merge'], observedAt: new Date().toISOString() };
    await f.update('receipt', { effectId: merge.id, idempotencyKey: 'merge-observed', final: false, receipt });
    expect((await f.current()).visibleState).toBe('RUNNING');
    expect((await prisma.executorEffect.findUniqueOrThrow({ where: { id: merge.id } })).state).toBe('OBSERVED');
    const deploy = await f.update('prepare_effect', { effect: { ...intent, key: 'release', commitSha: 'b'.repeat(40) } });
    await f.update('start_effect', { effectId: deploy.id });
    await f.update('receipt', { effectId: deploy.id, idempotencyKey: 'final-deployment', receipt: { ...receipt, environment: 'staging', deployedSha: 'b'.repeat(40) } });
    expect((await f.current()).visibleState).toBe('DELIVERED');
  });
  it('refuses injected dispatch bindings, states and human resolutions', async () => {
    const f = await fixture();
    for (const injection of [{ dispatchId: f.root.id }, { generation: 50 }, { state: 'STARTED' }, { resolution: { outcome: 'COMPLETED', actorId: f.humanContext.viewer!.id } }]) {
      await expect(f.update('prepare_effect', { effect: { ...intent, ...injection } })).rejects.toThrow(/Invalid executor effect intent/);
    }
    expect(await prisma.executorEffect.count()).toBe(0);
  });
  it('keeps an unresolved effect in its generation until reconciliation before Return', async () => {
    const f = await fixture();
    const effect = await f.update('prepare_effect', { effect: intent });
    await f.update('start_effect', { effectId: effect.id });
    const receipt = { version: 1, repository: 'test/executor', commitSha: sha, pullRequestNumber: 12, environment: 'staging', deployedSha: 'b'.repeat(40), health: 'fail', behavior: 'unknown', evidenceUrls: ['https://example.test/failure'], observedAt: new Date().toISOString() };
    await f.update('receipt', { effectId: effect.id, idempotencyKey: 'mismatch', receipt });
    await reportRun(prisma, { workId: f.work.id, runId: f.run.id, claimToken: f.claim.claimToken!, status: 'completed' }, f.actor);
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.work.teamId, type: 'REVIEW' } });
    const root = await prisma.issue.update({ where: { id: f.root.id }, data: { stateId: review.id } });
    const decision = { expectedRevision: root.revision, decision: 'REJECTED' as const, reason: 'Redo failed deployment' };
    await expect(reviewWork(prisma, root.id, decision, writeActorFromViewer(f.humanContext.viewer))).rejects.toThrow(/Reconcile unresolved/);
    expect((await f.current()).generation).toBe(1);
    await f.update('reconcile', { effectId: effect.id, resolution: { outcome: 'FAILED', reason: 'External release inspection completed', evidenceUrl: 'https://example.test/reconciliation' } }, f.humanContext);
    await reviewWork(prisma, root.id, decision, writeActorFromViewer(f.humanContext.viewer));
    expect(await f.current()).toMatchObject({ state: 'QUEUED', generation: 2 });
  });
  it('refuses a merge claim without an authorized merge effect', async () => {
    const f = await fixture();
    await expect(f.update('receipt', { idempotencyKey: 'unauthorized-merge', receipt: { version: 1, repository: 'test/executor', commitSha: sha, pullRequestNumber: 12, mergedSha: 'b'.repeat(40), environment: null, deployedSha: null, health: 'unknown', behavior: 'unknown', evidenceUrls: [], observedAt: new Date().toISOString() } })).rejects.toThrow(/intent/);
    expect(await prisma.executorDeliveryReceipt.count()).toBe(0);
  });
  it('keeps a never-started queued dispatch and its remaining budget on Return', async () => {
    const f = await fixture();
    await prisma.workClaim.update({ where: { id: f.claim.claim.id }, data: { leaseUntil: new Date(0) } });
    await prisma.executorDispatch.update({ where: { id: (await f.current()).id }, data: { state: 'QUEUED', runId: null, leaseUntil: null } });
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.work.teamId, type: 'REVIEW' } });
    const root = await prisma.issue.update({ where: { id: f.root.id }, data: { stateId: review.id } });
    await reviewWork(prisma, root.id, { expectedRevision: root.revision, decision: 'REJECTED', reason: 'Clarify before starting' }, writeActorFromViewer(f.humanContext.viewer));
    expect(await f.current()).toMatchObject({ state: 'QUEUED', generation: 1, feedback: 'Clarify before starting' });
  });
  it('isolates an unreadable receipt without losing dispatch context', async () => {
    const f = await fixture();
    await prisma.executorDeliveryReceipt.create({ data: { dispatchId: (await f.current()).id, generation: 1, runId: f.run.id, actorId: f.agent.id, idempotencyKey: 'corrupt-fixture', payload: { version: 999 } } });
    expect((await f.current()).receipts[0]).toMatchObject({ payload: null, assessment: null });
  });
  it('requires the approved executor for the underlying work claim too', async () => {
    const f = await fixture();
    await prisma.workClaim.update({ where: { id: f.claim.claim.id }, data: { leaseUntil: new Date(0) } });
    await expect(claimWork(prisma, f.work.id, {}, writeActorFromViewer(f.humanContext.viewer))).rejects.toThrow(/approved executor/);
  });
});
