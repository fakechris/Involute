import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { Issue, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import type { GraphQLContext } from './auth.ts';
import { commitWork, proposeWork, rejectWork } from './claim-service.ts';
import { acceptContractAmendment, proposeContractAmendment } from './contract-amendment.ts';
import { decideDeliveryChange, proposeDeliveryChange } from './delivery-change-set.ts';
import { createComment, createIssue } from './issue-service.ts';
import { processNotificationEmails } from './notification-email.ts';
import { isActionableNotification, readUnreadNotifications } from './notification-service.ts';
import { reviewWork } from './run-service-review.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();
const REPO = 'test/placement';
const DESCRIPTION = '### 1. 目标与架构定位\n测试。\n\n### 2. 核心功能与交付范围\n测试。\n\n### 3. 验收标准与验证方案\n测试。';

/**
 * INV-1093. A notification that asked for a decision is resolved — read, with
 * who decided and how — for every recipient, in the transaction that makes
 * the decision; the people nobody told before are told.
 */
describe('notifications follow their decisions (INV-1093)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('accepting an amendment resolves every owner\'s notice and tells the proposing agent in agent_inbox', async () => {
    const f = await fixture();
    // No assignee: both team owners are asked.
    const work = await createIssue(prisma, { acceptance: 'old', commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.ready.id, teamId: f.team.id, title: 'Contract' });
    const amendment = await proposeContractAmendment(prisma, { changes: { acceptance: 'new' }, reason: 'Rule moved.', workId: work.id }, asAgent(f.agent));
    await expect(prisma.notification.count({ where: { readAt: null, type: 'contract.amendment_proposed' } })).resolves.toBe(2);

    // The second owner decides; the first owner's notice clears too.
    await acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(f.owner2));

    const notices = await prisma.notification.findMany({ where: { type: 'contract.amendment_proposed' } });
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice).toMatchObject({ resolution: 'accepted', resolvedById: f.owner2.id });
      expect(notice.readAt).not.toBeNull();
      expect(notice.resolvedAt).not.toBeNull();
    }
    const inbox = await readUnreadNotifications(prisma, { first: 10, since: null, teamId: null, userId: f.agent.id });
    expect(inbox.map((row) => row.type)).toEqual(['contract.amendment_accepted']);
    expect(inbox[0]!.payload).toMatchObject({ amendmentId: amendment.id, identifier: work.identifier });
  });

  it('new candidates reach their deciders as one row an hour, resolved once every one is decided', async () => {
    const f = await fixture();
    const proposed: Issue[] = [];
    for (const title of ['one', 'two', 'three']) {
      proposed.push(await proposeWork(prisma, { acceptance: 'a', description: DESCRIPTION, parentId: f.parentId, repository: REPO, teamId: f.team.id, title }, asAgent(f.agent)));
    }
    const batches = await prisma.notification.findMany({ where: { type: 'work.proposed_batch', userId: f.admin.id } });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.payload).toMatchObject({ count: 3 });
    expect(isActionableNotification('work.proposed_batch')).toBe(true);

    await commitWork(prisma, proposed[0]!.id, { assigneeId: f.admin.id, expectedRevision: proposed[0]!.revision }, asPerson(f.admin));
    await rejectWork(prisma, proposed[1]!.id, { expectedRevision: proposed[1]!.revision, reason: 'No.' }, asPerson(f.admin));
    await expect(prisma.notification.findFirstOrThrow({ where: { type: 'work.proposed_batch', userId: f.admin.id } })).resolves.toMatchObject({ resolvedAt: null });

    await commitWork(prisma, proposed[2]!.id, { assigneeId: f.admin.id, expectedRevision: proposed[2]!.revision }, asPerson(f.admin));
    const settled = await prisma.notification.findFirstOrThrow({ where: { type: 'work.proposed_batch', userId: f.admin.id } });
    expect(settled.resolution).toBe('decided');
    expect(settled.readAt).not.toBeNull();

    // An hour later the next proposal opens a new row.
    await prisma.notification.updateMany({ where: { type: 'work.proposed_batch' }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000), readAt: null } });
    await proposeWork(prisma, { acceptance: 'a', description: DESCRIPTION, parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'four' }, asAgent(f.agent));
    await expect(prisma.notification.count({ where: { type: 'work.proposed_batch', userId: f.admin.id } })).resolves.toBe(2);
  });

  it('a delivery change tells its deciders and is resolved when decided', async () => {
    const f = await fixture();
    const work = await createIssue(prisma, { acceptance: 'A', assigneeId: f.admin.id, commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, scope: 's', stateId: f.ready.id, teamId: f.team.id, title: 'Package' });
    const set = await proposeDeliveryChange(context(f.agent), { changes: { policy: { environments: [], units: [{ actions: ['edit'], criteria: [0], dependsOn: [], key: 'a', paths: ['src/'], title: 'A' }] } }, expectedRevision: work.revision, reason: 'Plan', workId: work.id });
    const notice = await prisma.notification.findFirstOrThrow({ where: { type: 'delivery.proposed', userId: f.admin.id } });
    expect(notice.payload).toMatchObject({ changeSetId: set.id });

    await decideDeliveryChange(context(f.admin), { approve: false, id: set.id, note: 'Not now.' });
    await expect(prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).resolves.toMatchObject({ resolution: 'declined', resolvedById: f.admin.id });
  });

  it('a review resolves run.completed; a person\'s comment resolves decision.requested; information stays as it is', async () => {
    const f = await fixture();
    const review = await createIssue(prisma, { acceptance: 'a', assigneeId: f.admin.id, commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.review.id, teamId: f.team.id, title: 'Done?' });
    const running = await createIssue(prisma, { acceptance: 'a', assigneeId: f.admin.id, commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.ready.id, teamId: f.team.id, title: 'Asking' });
    await prisma.notification.createMany({
      data: [
        { sourceEventId: randomUUID(), type: 'run.completed', userId: f.admin.id, workId: review.id },
        { sourceEventId: randomUUID(), type: 'work.committed', userId: f.admin.id, workId: review.id },
        { sourceEventId: randomUUID(), type: 'decision.requested', userId: f.admin.id, workId: running.id },
      ],
    });

    await reviewWork(prisma, review.id, { decision: 'REJECTED', expectedRevision: review.revision, reason: 'Missing test.' }, asPerson(f.admin));
    await expect(prisma.notification.findFirstOrThrow({ where: { type: 'run.completed' } })).resolves.toMatchObject({ resolution: 'returned' });
    await expect(prisma.notification.findFirstOrThrow({ where: { type: 'work.committed' } })).resolves.toMatchObject({ readAt: null, resolvedAt: null });

    // An agent's comment is not an answer; a person's is.
    await createComment(prisma, { body: 'still working', issueId: running.id }, f.agent.id);
    await expect(prisma.notification.findFirstOrThrow({ where: { type: 'decision.requested' } })).resolves.toMatchObject({ resolvedAt: null });
    await createComment(prisma, { body: 'Use v2.', issueId: running.id }, f.admin.id);
    await expect(prisma.notification.findFirstOrThrow({ where: { type: 'decision.requested' } })).resolves.toMatchObject({ resolution: 'answered', resolvedById: f.admin.id });
  });

  it('mails only what is still unread and undecided', async () => {
    const f = await fixture();
    const work = await createIssue(prisma, { acceptance: 'a', assigneeId: f.admin.id, commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.review.id, teamId: f.team.id, title: 'Mail' });
    const stale = new Date(Date.now() - 5 * 60_000);
    await prisma.notification.createMany({
      data: [
        { createdAt: stale, type: 'run.completed', userId: f.admin.id, workId: work.id },
        { createdAt: stale, readAt: stale, resolvedAt: stale, resolution: 'accepted', type: 'contract.amendment_proposed', userId: f.admin.id, workId: work.id },
        { createdAt: stale, readAt: stale, type: 'work.committed', userId: f.admin.id, workId: work.id },
      ],
    });
    const sent: string[] = [];
    await processNotificationEmails(
      prisma,
      { appOrigin: 'http://127.0.0.1:4201', email: { enabled: true, from: 'a@b.test', host: 'smtp.test', password: null, port: 587, user: null } },
      async (mail) => { sent.push(mail.subject); },
    );
    expect(sent).toEqual(['Involute: 1 work item needs your attention']);
  });
});

async function fixture() {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const owner2 = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'owner2@resolution.test', name: 'Owner Two' } });
  await prisma.teamMembership.create({ data: { role: 'OWNER', teamId: team.id, userId: owner2.id } });
  const agent = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'mia@resolution.test', handle: 'mia', name: 'Mia', ownerId: admin.id } });
  const states = await prisma.workflowState.findMany({ where: { teamId: team.id } });
  const byType = (type: string) => states.find((state) => state.type === type)!;
  const parentId = await testParentId(prisma, team.id);
  return { admin, agent, owner2, parentId, ready: byType('UNSTARTED'), review: byType('REVIEW'), team };
}

function context(viewer: User): GraphQLContext {
  return { authMode: 'token', isTrustedSystem: true, prisma, viewer };
}

function asAgent(agent: User) {
  return { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'test' };
}

function asPerson(person: User) {
  return { actorId: person.id, actorKind: 'HUMAN' as const, surface: 'test' };
}
