import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.js';
import {
  processNotificationEmails,
  sweepStaleNotifications,
} from './notification-email.js';
import { projectWebhookDisabledNotifications, projectWorkNotifications } from './notification-service.js';
import { reportRun, reviewWork } from './run-service.js';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

describe('work notifications', () => {
  let team: Team;
  let human: User;
  let readyState: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.workReviewDecision.deleteMany();
    await prisma.workEvidence.deleteMany();
    await prisma.workRun.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.workLink.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.agentCredential.deleteMany();
    await prisma.session.deleteMany();
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.webhookSubscription.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);

    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    readyState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Ready' },
    });
    server = await startServer({
      allowAdminFallback: true,
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  async function postGraphQLAs(cookie: string, query: string, variables?: Record<string, unknown>) {
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ query, variables }),
    });
    return { body: await response.json() as any, status: response.status };
  }

  async function login(user: User): Promise<string> {
    const session = await createSession(prisma, user.id, 3600);
    return `involute_session=${session.token}`;
  }

  async function createAgentActor(name: string): Promise<User> {
    return prisma.user.create({
      data: {
        actorKind: 'AGENT',
        email: `${name}@agents.example.com`,
        name,
      },
    });
  }

  async function buildCommittedWork(options: { assigneeId?: string | null } = {}) {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Notify me' });
    return commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'notifications flow',
        expectedRevision: candidate.revision,
        ...(options.assigneeId === null ? {} : { assigneeId: options.assigneeId ?? human.id }),
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
  }

  it('notifies the human assignee when an agent run requests a decision', async () => {
    const agent = await createAgentActor('run-agent');
    const committed = await buildCommittedWork();
    await claimWork(prisma, committed.id, {}, { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' });
    await reportRun(
      prisma,
      { decisionRequested: true, status: 'completed', summary: 'PR is up', workId: committed.id },
      { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' },
    );

    const rows = await prisma.notification.findMany({
      where: { type: 'decision.requested', userId: human.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workId).toBe(committed.id);
    expect((rows[0]?.payload as { publicId?: string }).publicId).toBeTruthy();
  });

  it('falls back to team owners when the assignee is an agent', async () => {
    const agent = await createAgentActor('assignee-agent');
    const humanOwner = await prisma.user.create({
      data: { actorKind: 'HUMAN', email: 'human-owner@example.com', name: 'Human Owner' },
    });
    await prisma.teamMembership.create({
      data: { role: 'OWNER', teamId: team.id, userId: humanOwner.id },
    });
    // The kernel only lets humans own claimable work, so this exercises the
    // projection rule directly against a work row whose assignee became an
    // agent (e.g. reassignment through the compatibility API). Both human
    // owners — the seed admin and the new one — are notified.
    const committed = await buildCommittedWork();
    await prisma.issue.update({ where: { id: committed.id }, data: { assigneeId: agent.id } });
    const event = await prisma.eventOutbox.create({
      data: {
        payload: { type: 'decision.requested', work: { id: committed.id, identifier: committed.identifier } },
        type: 'decision.requested',
      },
    });
    await projectWorkNotifications(prisma, {
      eventId: event.id,
      payload: { publicId: 'RUN-9' },
      type: 'decision.requested',
      work: { assigneeId: agent.id, id: committed.id, teamId: team.id },
    });

    const recipients = await prisma.notification.findMany({
      select: { userId: true },
      where: { type: 'decision.requested' },
    });
    expect(recipients.map((row) => row.userId).sort()).toEqual([humanOwner.id, human.id].sort());
  });

  it('does not notify anyone for review outcomes when the run actor is an agent', async () => {
    const agent = await createAgentActor('review-run-agent');
    const committed = await buildCommittedWork();
    await claimWork(prisma, committed.id, {}, { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' });
    await reportRun(
      prisma,
      { decisionRequested: true, status: 'completed', workId: committed.id },
      { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' },
    );
    await reviewWork(
      prisma,
      committed.id,
      { decision: 'ACCEPTED', expectedRevision: committed.revision + 1 },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const reviewRows = await prisma.notification.findMany({
      where: { type: { in: ['work.accepted', 'work.review_rejected'] } },
    });
    expect(reviewRows).toEqual([]);
  });

  it('notifies a human run actor when the review lands', async () => {
    const humanRunner = await prisma.user.create({
      data: { actorKind: 'HUMAN', email: 'runner@example.com', name: 'Runner' },
    });
    await prisma.teamMembership.create({
      data: { role: 'EDITOR', teamId: team.id, userId: humanRunner.id },
    });
    const committed = await buildCommittedWork();
    await claimWork(prisma, committed.id, {}, { actorId: humanRunner.id, actorKind: 'HUMAN', surface: 'web' });
    await reportRun(
      prisma,
      { decisionRequested: true, status: 'completed', workId: committed.id },
      { actorId: humanRunner.id, actorKind: 'HUMAN', surface: 'web' },
    );
    await reviewWork(
      prisma,
      committed.id,
      { decision: 'REJECTED', expectedRevision: committed.revision + 1, reason: 'not done' },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const rows = await prisma.notification.findMany({
      where: { type: 'work.review_rejected', userId: humanRunner.id },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { reason?: string }).reason).toBe('not done');
  });

  it('projects exactly once per event when replayed', async () => {
    const committed = await buildCommittedWork();
    const candidate2 = await proposeWork(prisma, { teamId: team.id, title: 'Replay target' });
    void candidate2;
    const event = await prisma.eventOutbox.create({
      data: {
        payload: { type: 'decision.requested', work: { id: committed.id, identifier: committed.identifier } },
        type: 'decision.requested',
      },
    });

    const input = {
      eventId: event.id,
      payload: { publicId: 'RUN-1' },
      type: 'decision.requested',
      work: committed,
    } as const;
    await projectWorkNotifications(prisma, input);
    await projectWorkNotifications(prisma, input);

    expect(await prisma.notification.count({ where: { sourceEventId: event.id } })).toBe(1);
  });

  it('notifies the webhook creator, not just admins, when a subscription is disabled', async () => {
    const creator = await prisma.user.create({
      data: { actorKind: 'HUMAN', email: 'hook-owner@example.com', name: 'Hook Owner' },
    });
    const event = await prisma.eventOutbox.create({
      data: {
        payload: { type: 'webhook.disabled', subscription: { id: 'sub-1' } },
        type: 'webhook.disabled',
      },
    });
    await projectWebhookDisabledNotifications(prisma, {
      eventId: event.id,
      subscription: {
        consecutiveFailures: 10,
        createdById: creator.id,
        label: 'ops hook',
        url: 'https://hooks.example.test/x',
      },
    });

    const rows = await prisma.notification.findMany({
      where: { sourceEventId: event.id },
      select: { userId: true, type: true },
    });
    expect(rows).toEqual([{ type: 'webhook.disabled', userId: creator.id }]);
  });

  it('serves notifications over GraphQL scoped to the viewer with mark-read', async () => {
    const other = await prisma.user.create({
      data: { actorKind: 'HUMAN', email: 'other-viewer@example.com', name: 'Other' },
    });
    const work = await prisma.issue.create({
      data: {
        commitmentStatus: 'COMMITTED',
        identifier: 'NOTIF-1',
        stateId: readyState.id,
        teamId: team.id,
        title: 'Notifier',
      },
    });
    const mine = await prisma.notification.create({
      data: { type: 'decision.requested', userId: human.id, workId: work.id },
    });
    await prisma.notification.create({
      data: { type: 'decision.requested', userId: other.id, workId: work.id },
    });

    const cookie = await login(human);
    const unread = await postGraphQLAs(cookie, 'query { unreadNotificationCount }');
    expect(unread.body.data.unreadNotificationCount).toBe(1);

    const list = await postGraphQLAs(cookie, 'query { notifications { nodes { id type work { identifier } } } }');
    const nodes = list.body.data.notifications.nodes as Array<{ id: string; work: { identifier: string } | null }>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.work?.identifier).toBe('NOTIF-1');

    // Marking someone else's notification is a 404, not a silent success.
    const foreign = await postGraphQLAs(cookie, 'query { notifications { nodes { id } } }');
    void foreign;
    const otherCookie = await login(other);
    const crossMark = await postGraphQLAs(otherCookie, 'mutation Mark($id: String!) { notificationMarkRead(id: $id) { success } }', { id: mine.id });
    expect(crossMark.body.data.notificationMarkRead.success).toBe(false);

    const marked = await postGraphQLAs(cookie, 'mutation Mark($id: String!) { notificationMarkRead(id: $id) { success } }', { id: mine.id });
    expect(marked.body.data.notificationMarkRead.success).toBe(true);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).toBeTruthy();

    const cleared = await postGraphQLAs(cookie, 'mutation { notificationsMarkAllRead { count success } }');
    expect(cleared.body.data.notificationsMarkAllRead.count).toBe(0);
    expect(await prisma.notification.count({ where: { userId: human.id, readAt: null } })).toBe(0);
  });

  it('emails a per-user digest once SMTP is enabled and respects the preference opt-out', async () => {
    const work = await prisma.issue.create({
      data: {
        commitmentStatus: 'COMMITTED',
        identifier: 'MAIL-1',
        stateId: readyState.id,
        teamId: team.id,
        title: 'Mail me',
      },
    });
    // The batching window only picks up notifications older than two minutes.
    const stale = new Date(Date.now() - 5 * 60_000);
    await prisma.notification.create({
      data: { createdAt: stale, type: 'decision.requested', userId: human.id, workId: work.id },
    });
    await prisma.notification.create({
      data: { createdAt: stale, type: 'run.completed', userId: human.id, workId: work.id },
    });
    const optedOut = await prisma.user.create({
      data: {
        actorKind: 'HUMAN',
        email: 'quiet@example.com',
        name: 'Quiet',
        notificationPrefs: { emailNotifications: false },
      },
    });
    await prisma.notification.create({
      data: { createdAt: stale, type: 'decision.requested', userId: optedOut.id, workId: work.id },
    });

    const runtime = {
      appOrigin: 'http://127.0.0.1:4201',
      email: {
        enabled: true,
        from: 'invol@ute.test',
        host: 'smtp.test',
        password: null,
        port: 587,
        user: null,
      },
    };
    const sent: Array<{ subject: string; to: string }> = [];
    const notified = await processNotificationEmails(prisma, runtime, async (mail) => {
      sent.push({ subject: mail.subject, to: mail.to });
    });

    expect(notified).toBe(1);
    expect(sent).toEqual([
      { subject: 'Involute: 2 work items need your attention', to: DEFAULT_ADMIN_EMAIL },
    ]);
    expect(await prisma.notification.count({ where: { userId: human.id, emailedAt: { not: null } } })).toBe(2);
    expect(await prisma.notification.count({ where: { userId: optedOut.id, emailedAt: { not: null } } })).toBe(0);
  });

  it('sweeps read and unread notifications past their retention window', async () => {
    const work = await prisma.issue.create({
      data: {
        commitmentStatus: 'COMMITTED',
        identifier: 'SWEEP-1',
        stateId: readyState.id,
        teamId: team.id,
        title: 'Sweep me',
      },
    });
    const now = Date.now();
    const readOld = await prisma.notification.create({
      data: {
        createdAt: new Date(now - 200 * 24 * 60 * 60_000),
        readAt: new Date(now - 100 * 24 * 60 * 60_000),
        type: 'decision.requested',
        userId: human.id,
        workId: work.id,
      },
    });
    await prisma.notification.create({
      data: { createdAt: new Date(now - 200 * 24 * 60 * 60_000), type: 'decision.requested', userId: human.id, workId: work.id },
    });
    await prisma.notification.create({
      data: { createdAt: new Date(now - 1000), type: 'decision.requested', userId: human.id, workId: work.id },
    });

    expect(await sweepStaleNotifications(prisma)).toBe(2);
    const remaining = await prisma.notification.findMany({ select: { id: true } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(readOld.id);
  });
});
