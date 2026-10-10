import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { Issue, User } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { replyToAgentRequest } from './agent-request-service.ts';
import { type AttentionItem, loadAttention, pageAttention, summarizeAttention } from './attention-service.ts';
import type { GraphQLContext } from './auth.ts';
import { setTriageRotation } from './bug-triage.ts';
import { commitWork } from './claim-service.ts';
import { acceptContractAmendment, proposeContractAmendment } from './contract-amendment.ts';
import { decideDeliveryChange, proposeDeliveryChange } from './delivery-change-set.ts';
import { WEBHOOK_AUTO_DISABLE_THRESHOLD } from './event-outbox.ts';
import { createComment, createIssue, updateIssue } from './issue-service.ts';
import { startServer } from './index.ts';
import { reviewWork } from './run-service-review.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();
const REPO = 'test/placement';

/**
 * INV-1091. A decision is on someone's list while it is open and gone for
 * everyone once it is made; the summary counts exactly the list.
 */
describe('attention: what a person is waiting to decide (INV-1091)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });
  // resetAndSeed keeps webhook subscriptions; other suites list them.
  afterEach(async () => { await prisma.webhookSubscription.deleteMany({ where: { url: { startsWith: 'https://attention-hooks.test/' } } }); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('a candidate waits for the team owner and leaves the list once committed', async () => {
    const f = await fixture();
    const candidate = await createIssue(prisma, { acceptance: 'It works.', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Proposed work' });

    expect(await kindsFor(f.admin)).toEqual([['CANDIDATE_COMMIT', candidate.id]]);
    const [entry] = await loadAttention(prisma, f.admin, undefined);
    expect(entry).toMatchObject({ actions: ['COMMIT', 'REJECT'], groupId: f.parentId, workId: candidate.id });
    // A member who is not the owner decides nothing here.
    expect(await kindsFor(f.member)).toEqual([]);

    await commitWork(prisma, candidate.id, { assigneeId: f.admin.id, expectedRevision: candidate.revision }, asPerson(f.admin));
    expect(await kindsFor(f.admin)).toEqual([]);
  });

  it('a snoozed candidate is not listed or counted until the snooze ends', async () => {
    const f = await fixture();
    const now = new Date();
    await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Later' });
    await prisma.issue.updateMany({ where: { title: 'Later' }, data: { snoozedUntil: new Date(now.getTime() + 60_000) } });

    expect(summarizeAttention(await loadAttention(prisma, f.admin, undefined, {}, now)).total).toBe(0);
    expect(await loadAttention(prisma, f.admin, undefined, {}, new Date(now.getTime() + 120_000))).toHaveLength(1);
  });

  it('a bug candidate goes to this week\'s triager, not to the owner', async () => {
    const f = await fixture();
    await setTriageRotation(prisma, { teamId: f.team.id, userIds: [f.member.id] });
    const bugLabel = await prisma.issueLabel.upsert({ create: { name: 'Bug' }, update: {}, where: { name: 'Bug' } });
    const bug = await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', labelIds: [bugLabel.id], parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Crash' });

    expect(await kindsFor(f.member)).toEqual([['CANDIDATE_COMMIT', bug.id]]);
    expect(await kindsFor(f.admin)).toEqual([]);
    expect((await loadAttention(prisma, f.member, undefined))[0]!.reason).toBe('Bug waiting for triage');
  });

  it('finished work waits for its human assignee and leaves the list once reviewed', async () => {
    const f = await fixture();
    const work = await committed(f, { assigneeId: f.admin.id, stateId: f.review.id, title: 'Finished' });

    expect(await kindsFor(f.admin)).toEqual([['WORK_REVIEW', work.id]]);
    expect(await kindsFor(f.member)).toEqual([]);

    await reviewWork(prisma, work.id, { decision: 'REJECTED', expectedRevision: work.revision, reason: 'Missing a test.' }, asPerson(f.admin));
    expect(await kindsFor(f.admin)).toEqual([]);
  });

  it('a contract amendment waits for the owner, offers only Reject once stale, and leaves the list once decided', async () => {
    const f = await fixture();
    const work = await committed(f, { acceptance: 'old', assigneeId: f.admin.id, title: 'Contract' });
    const amendment = await proposeContractAmendment(prisma, { changes: { acceptance: 'new' }, reason: 'Rule changed in INV-1.', workId: work.id }, asAgent(f.agent));

    const [entry] = await loadAttention(prisma, f.admin, undefined);
    expect(entry).toMatchObject({ actions: ['ACCEPT', 'REJECT'], kind: 'CONTRACT_AMENDMENT', reason: 'Contract change proposed: Rule changed in INV-1.', subjectId: amendment.id, workId: work.id });

    await acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(f.admin));
    expect(await kindsFor(f.admin)).toEqual([]);

    const second = await proposeContractAmendment(prisma, { changes: { acceptance: 'newer' }, reason: 'Again.', workId: work.id }, asAgent(f.agent));
    await updateIssue(prisma, work.id, { acceptance: 'edited by hand' }, asPerson(f.admin));
    const [stale] = await loadAttention(prisma, f.admin, undefined);
    expect(stale).toMatchObject({ actions: ['REJECT'], subjectId: second.id });
  });

  it('a delivery change waits for the owner and leaves the list once decided', async () => {
    const f = await fixture();
    const work = await createIssue(prisma, { acceptance: 'A', assigneeId: f.admin.id, commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, scope: 's', stateId: f.ready.id, teamId: f.team.id, title: 'Package' });
    const set = await proposeDeliveryChange(context(f.agent), { changes: { policy: { environments: [], units: [{ actions: ['edit'], criteria: [0], dependsOn: [], key: 'a', paths: ['src/'], title: 'A' }] } }, expectedRevision: work.revision, reason: 'Plan', workId: work.id });

    // The candidate itself is decided through its change set first.
    expect(await kindsFor(f.admin)).toEqual([['DELIVERY_CHANGE', set.id]]);

    await decideDeliveryChange(context(f.admin), { approve: false, id: set.id, note: 'Not now.' });
    expect((await loadAttention(prisma, f.admin, undefined)).map((entry) => entry.kind)).not.toContain('DELIVERY_CHANGE');
  });

  it('an agent asking back waits for the person who asked, and leaves the list once they reply', async () => {
    const f = await fixture();
    const work = await committed(f, { assigneeId: f.agent.id, title: 'Asked' });
    const root = await prisma.comment.create({ data: { body: '@mia why?', issueId: work.id, userId: f.member.id } });
    const request = await prisma.agentRequest.create({
      data: { body: 'why?', deadlineAt: new Date(Date.now() + 3_600_000), requestedByActorId: f.member.id, rootCommentId: root.id, state: 'INPUT_REQUIRED', targetActorId: f.agent.id, workId: work.id },
    });

    expect(await kindsFor(f.member)).toEqual([['AGENT_REQUEST', request.id]]);
    expect((await loadAttention(prisma, f.member, undefined))[0]!.actions).toEqual(['REPLY']);

    await replyToAgentRequest(prisma, { body: 'Because.', by: { actorId: f.member.id, actorKind: 'HUMAN', globalRole: 'USER' }, id: request.id });
    expect(await kindsFor(f.member)).toEqual([]);
  });

  it('a decision request stays open while its run runs and nobody has answered', async () => {
    const f = await fixture();
    const work = await committed(f, { assigneeId: f.admin.id, stateId: f.progress.id, title: 'Running' });
    const run = await prisma.workRun.create({ data: { actorId: f.agent.id, publicId: `RUN-${randomUUID()}`, status: 'RUNNING', workId: work.id } });
    await prisma.notification.create({ data: { payload: { publicId: run.publicId, summary: 'Use v1 or v2?' }, teamId: f.team.id, type: 'decision.requested', userId: f.admin.id, workId: work.id } });

    const [entry] = await loadAttention(prisma, f.admin, undefined);
    expect(entry).toMatchObject({ actions: ['RESPOND'], kind: 'DECISION_REQUESTED', reason: 'An agent asked for a decision: Use v1 or v2?', subjectId: run.id });

    await createComment(prisma, { body: 'v2.', issueId: work.id }, f.admin.id);
    expect(await kindsFor(f.admin)).toEqual([]);
  });

  it('a webhook switched off by failures waits for administrators only, until re-enabled', async () => {
    const f = await fixture();
    const hook = await prisma.webhookSubscription.create({ data: { consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD, enabled: false, secret: 's', url: 'https://attention-hooks.test/x' } });
    // Switched off by a person: nothing to decide.
    await prisma.webhookSubscription.create({ data: { enabled: false, secret: 's', url: 'https://attention-hooks.test/y' } });

    expect(await kindsFor(f.admin)).toEqual([['OPS', hook.id]]);
    expect(await kindsFor(f.member)).toEqual([]);
    // Operations belong to no team.
    expect(await loadAttention(prisma, f.admin, undefined, { teamKey: DEFAULT_TEAM_KEY })).toEqual([]);

    await prisma.webhookSubscription.update({ where: { id: hook.id }, data: { consecutiveFailures: 0, enabled: true } });
    expect(await kindsFor(f.admin)).toEqual([]);
  });

  it('is served over GraphQL with the work, its group and the summary', async () => {
    const f = await fixture();
    const candidate = await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Over the wire' });
    const server = await startServer({ allowAdminFallback: true, authToken: 'attention-token', port: 0, prisma });
    try {
      const response = await fetch(`${server.url}/graphql`, {
        body: JSON.stringify({ query: '{ attention(first: 10) { nodes { id kind subjectId actions reason since groupKey group { identifier } work { identifier } } pageInfo { hasNextPage endCursor } } attentionSummary { total byKind { kind count } } }' }),
        headers: { authorization: 'Bearer attention-token', 'content-type': 'application/json' },
        method: 'POST',
      });
      const result = (await response.json()) as { data?: { attention: { nodes: Array<Record<string, unknown>> }; attentionSummary: { total: number; byKind: Array<{ kind: string; count: number }> } }; errors?: unknown };
      expect(result.errors).toBeUndefined();
      expect(result.data!.attention.nodes).toEqual([
        expect.objectContaining({ actions: ['COMMIT', 'REJECT'], groupKey: f.parentId, id: `CANDIDATE_COMMIT:${candidate.id}`, kind: 'CANDIDATE_COMMIT', work: { identifier: candidate.identifier } }),
      ]);
      expect(result.data!.attentionSummary.total).toBe(1);
      expect(result.data!.attentionSummary.byKind.find((entry) => entry.kind === 'CANDIDATE_COMMIT')!.count).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('agents have no list; unreadable work is not listed', async () => {
    const f = await fixture();
    await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Proposed' });

    expect(await loadAttention(prisma, f.agent, undefined)).toEqual([]);
    expect(await loadAttention(prisma, null, undefined)).toEqual([]);
    expect(await loadAttention(prisma, f.admin, { id: { in: [] } })).toEqual([]);
  });

  it('the summary counts the list; pages continue after decided items without skipping', async () => {
    const f = await fixture();
    const created: Issue[] = [];
    for (const title of ['one', 'two', 'three']) {
      created.push(await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title }));
    }
    await committed(f, { assigneeId: f.admin.id, stateId: f.review.id, title: 'Finished' });

    const items = await loadAttention(prisma, f.admin, undefined);
    const summary = summarizeAttention(items);
    expect(summary.total).toBe(items.length);
    expect(summary.byKind.find((entry) => entry.kind === 'CANDIDATE_COMMIT')).toMatchObject({ count: 3, oldestSince: created[0]!.createdAt });
    expect(summary.byKind.reduce((sum, entry) => sum + entry.count, 0)).toBe(summary.total);

    const page1 = pageAttention(items, 2, null);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    // The first item is decided between pages; the second page still starts after the last one seen.
    await commitWork(prisma, page1.nodes[0]!.subjectId, { assigneeId: f.admin.id, expectedRevision: 1 }, asPerson(f.admin));
    const page2 = pageAttention(await loadAttention(prisma, f.admin, undefined), 2, page1.pageInfo.endCursor);
    expect([...page1.nodes, ...page2.nodes].map((entry) => entry.id)).toEqual(items.map((entry) => entry.id));
    expect(() => pageAttention(items, 2, 'nonsense')).toThrow('Invalid attention cursor.');
  });
});

async function fixture() {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const member = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'member@attention.test', name: 'Member' } });
  await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: member.id } });
  const agent = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'mia@attention.test', handle: 'mia', name: 'Mia', ownerId: admin.id } });
  const states = await prisma.workflowState.findMany({ where: { teamId: team.id } });
  const byType = (type: string) => states.find((state) => state.type === type)!;
  const parentId = await testParentId(prisma, team.id);
  return { admin, agent, member, parentId, progress: byType('STARTED'), ready: byType('UNSTARTED'), review: byType('REVIEW'), team };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function committed(f: Fixture, data: { acceptance?: string; assigneeId: string; stateId?: string; title: string }): Promise<Issue> {
  return createIssue(prisma, { acceptance: 'It works.', commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.ready.id, teamId: f.team.id, ...data });
}

async function kindsFor(viewer: User): Promise<Array<[AttentionItem['kind'], string]>> {
  return (await loadAttention(prisma, viewer, undefined)).map((entry) => [entry.kind, entry.subjectId]);
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
