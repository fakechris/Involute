import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAndSeed, DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import type { GraphQLContext } from './auth.js';
import { createIssue } from './issue-service.js';
import { testParentId } from './test-placement.js';
import { proposeDeliveryChange, decideDeliveryChange } from './delivery-change-set.js';
import { createDeliveryExecution } from './delivery-execution.js';
import { readUnreadNotifications } from './notification-service.js';
import { reviewWork } from './run-service-review.js';
loadProjectEnvironment();
const prisma = new PrismaClient();
beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

// INV-993: approving a package creates its units and tells each executor.
describe('units exist and executors are told once a package is approved', () => {
  async function fixture() {
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    const agent = await prisma.user.create({ data: { name: 'Executor', email: 'executor@fixture.test', actorKind: 'AGENT', ownerId: human.id } });
    const other = await prisma.user.create({ data: { name: 'Other executor', email: 'other@fixture.test', actorKind: 'AGENT', ownerId: human.id } });
    const humanContext: GraphQLContext = { prisma, viewer: human, authMode: 'token', isTrustedSystem: true };
    const agentContext: GraphQLContext = { prisma, viewer: agent, authMode: 'token', isTrustedSystem: true };
    const root = await createIssue(prisma, { teamId: team.id, parentId: await testParentId(prisma, team.id, 'test/executor'), title: 'Delivery', repository: 'test/executor', scope: 'Change src only', acceptance: 'Working delivery', assigneeId: human.id, stateId: ready.id, commitmentStatus: 'CANDIDATE' });
    const policy = { environments: ['staging'], units: [
      { key: 'a', title: 'First', criteria: [0], paths: ['src/'], actions: ['edit', 'test'], executorActorId: agent.id, checks: [{ workflowId: 42, job: 'tests' }] },
      { key: 'b', title: 'Second', criteria: [0], paths: ['src/'], actions: ['edit', 'test'], executorActorId: other.id, dependsOn: ['a'] },
      { key: 'c', title: 'Unassigned', criteria: [0], paths: ['docs/'], actions: ['edit'] },
    ] };
    const proposal = await proposeDeliveryChange(agentContext, { workId: root.id, expectedRevision: root.revision, reason: 'Plan', changes: { policy } });
    return { humanContext, agentContext, root, agent, other, proposal };
  }

  it('creates every approved unit with its dispatch and inbox notification', async () => {
    const f = await fixture();
    await decideDeliveryChange(f.humanContext, { id: f.proposal.id, approve: true });

    const units = await prisma.issue.findMany({ where: { deliveryRootId: f.root.id }, orderBy: { deliveryUnitKey: 'asc' } });
    expect(units.map((unit) => unit.deliveryUnitKey)).toEqual(['a', 'b', 'c']);
    const dispatches = await prisma.executorDispatch.findMany({ where: { rootId: f.root.id } });
    expect(dispatches.map((row) => [row.executorActorId, row.state]).sort()).toEqual([[f.agent.id, 'QUEUED'], [f.other.id, 'QUEUED']].sort());

    const inbox = await readUnreadNotifications(prisma, { first: 10, since: null, teamId: null, userId: f.agent.id });
    const dispatched = inbox.filter((row) => row.type === 'executor.dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.work?.identifier).toBe(units[0]!.identifier);
    expect((dispatched[0]!.payload as { dispatchId: string }).dispatchId).toBe(dispatches.find((row) => row.executorActorId === f.agent.id)!.id);
    const otherInbox = await readUnreadNotifications(prisma, { first: 10, since: null, teamId: null, userId: f.other.id });
    expect(otherInbox.filter((row) => row.type === 'executor.dispatched').map((row) => row.work?.identifier)).toEqual([units[1]!.identifier]);
    expect(await prisma.eventOutbox.count({ where: { type: 'executor.dispatched' } })).toBe(2);
  });

  it('keeps manual creation as an idempotent fallback', async () => {
    const f = await fixture();
    await decideDeliveryChange(f.humanContext, { id: f.proposal.id, approve: true });
    const before = await prisma.issue.findFirstOrThrow({ where: { deliveryRootId: f.root.id, deliveryUnitKey: 'a' } });
    const again = await createDeliveryExecution(f.agentContext, { workId: f.root.id, unitKey: 'a', expectedGrantRevision: 1 });
    expect(again.id).toBe(before.id);
    expect(await prisma.issue.count({ where: { deliveryRootId: f.root.id } })).toBe(3);
    expect(await prisma.executorDispatch.count({ where: { rootId: f.root.id } })).toBe(2);
    expect(await prisma.notification.count({ where: { type: 'executor.dispatched' } })).toBe(2);
  });

  // INV-995: returning the package puts the feedback in each unit executor's inbox.
  it('sends a package return to each unit executor with the feedback and unit', async () => {
    const f = await fixture();
    await decideDeliveryChange(f.humanContext, { id: f.proposal.id, approve: true });
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.root.teamId, type: 'REVIEW' } });
    const root = await prisma.issue.update({ where: { id: f.root.id }, data: { stateId: review.id } });
    const human = (await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } })).id;
    await reviewWork(prisma, root.id, { expectedRevision: root.revision, decision: 'REJECTED', reason: 'Unit a misses the edge case.' }, { actorKind: 'HUMAN', actorId: human });

    const units = await prisma.issue.findMany({ where: { deliveryRootId: f.root.id }, orderBy: { deliveryUnitKey: 'asc' } });
    const returned = async (userId: string) => (await readUnreadNotifications(prisma, { first: 20, since: null, teamId: null, userId })).filter((row) => row.type === 'work.review_rejected');
    const toAgent = await returned(f.agent.id);
    expect(toAgent.map((row) => row.work?.identifier)).toEqual([units[0]!.identifier]);
    expect(toAgent[0]!.payload).toMatchObject({ reason: 'Unit a misses the edge case.', unitKey: 'a', packageIdentifier: f.root.identifier });
    expect((await returned(f.other.id)).map((row) => row.work?.identifier)).toEqual([units[1]!.identifier]);
    // The reviewer is not told their own decision; the unit without an executor tells no agent.
    expect(await prisma.notification.count({ where: { type: 'work.review_rejected', userId: human } })).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'work.review_rejected', workId: units[2]!.id } })).toBe(0);
  });
});
