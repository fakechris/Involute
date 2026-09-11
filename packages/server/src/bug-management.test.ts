import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { createIssue } from './issue-service.js';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

const BUG_REPORT_MUTATION = /* GraphQL */ `
  mutation BugReport($input: BugReportInput!) {
    bugReport(input: $input) {
      success
      issue {
        id
        identifier
        title
        priority
        repository
        source
        commitmentStatus
        state {
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

const BUG_SUMMARY_QUERY = /* GraphQL */ `
  query BugSummary($teamFilter: TeamFilter) {
    bugSummary(teamFilter: $teamFilter) {
      openCount
      closedCount
      byPriority {
        priority
        count
      }
      byRepository {
        repository
        openCount
        closedCount
      }
      byTypeLabel {
        label
        count
      }
      unclaimedOpenCount
      oldestOpenAgeDays
      avgOpenAgeDays
      createdPerWeek {
        weekStart
        count
      }
    }
  }
`;

let server: StartedServer;

describe('bug management', () => {
  let team: Team;
  let human: User;

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

  async function reportBug(cookie: string, input: Record<string, unknown>) {
    return postGraphQLAs(cookie, BUG_REPORT_MUTATION, {
      input: { teamId: team.id, ...input },
    });
  }

  async function queryBugSummary(cookie: string, teamFilter?: Record<string, unknown>) {
    return postGraphQLAs(cookie, BUG_SUMMARY_QUERY, teamFilter ? { teamFilter } : {});
  }

  describe('bugReport', () => {
    it('creates a COMMITTED bug issue with the bug label, source, and backlog state', async () => {
      const cookie = await login(human);
      const { body } = await reportBug(cookie, {
        title: 'Board crashes on drag',
        description: 'Drop a card on the Done column.',
        priority: 1,
        repository: 'fakechris/Involute',
      });

      expect(body.errors).toBeUndefined();
      expect(body.data.bugReport.success).toBe(true);
      const issue = body.data.bugReport.issue;
      expect(issue.identifier).toMatch(/^INV-\d+$/);
      expect(issue.commitmentStatus).toBe('COMMITTED');
      expect(issue.source).toBe('bug-report');
      expect(issue.priority).toBe(1);
      expect(issue.repository).toBe('fakechris/Involute');
      expect(issue.state.type).toBe('BACKLOG');
      expect(issue.labels.nodes.map((label: { name: string }) => label.name.toLowerCase())).toContain('bug');
    });

    it('reuses the existing Bug label case-insensitively and stays idempotent across reports', async () => {
      const cookie = await login(human);
      const seedBugLabel = await prisma.issueLabel.findFirstOrThrow({
        where: { name: { equals: 'bug', mode: 'insensitive' } },
      });

      const first = await reportBug(cookie, { title: 'First bug' });
      const second = await reportBug(cookie, { title: 'Second bug' });

      expect(first.body.data.bugReport.success).toBe(true);
      expect(second.body.data.bugReport.success).toBe(true);
      const bugLabels = await prisma.issueLabel.findMany({
        where: { name: { equals: 'bug', mode: 'insensitive' } },
      });
      expect(bugLabels).toHaveLength(1);
      expect(bugLabels[0]?.id).toBe(seedBugLabel.id);
      for (const response of [first, second]) {
        const labelIds = response.body.data.bugReport.issue.labels.nodes.map((label: { id: string }) => label.id);
        expect(labelIds).toContain(seedBugLabel.id);
      }
    });

    it('creates the bug label when none exists and attaches caller-supplied labels', async () => {
      const cookie = await login(human);
      await prisma.issueLabel.deleteMany({ where: { name: { equals: 'bug', mode: 'insensitive' } } });
      const extraLabel = await prisma.issueLabel.create({ data: { name: 'ui' } });

      const { body } = await reportBug(cookie, {
        title: 'Misaligned toolbar',
        labelIds: [extraLabel.id],
      });

      expect(body.data.bugReport.success).toBe(true);
      const names = body.data.bugReport.issue.labels.nodes.map((label: { name: string }) => label.name);
      expect(names).toContain('bug');
      expect(names).toContain('ui');
    });

    it('fails cleanly for unknown caller-supplied label ids', async () => {
      const cookie = await login(human);
      const { body } = await reportBug(cookie, {
        title: 'Bad label reference',
        labelIds: ['00000000-0000-0000-0000-000000000000'],
      });

      expect(body.data.bugReport.success).toBe(false);
      expect(body.data.bugReport.issue).toBeNull();
    });

    it('requires authentication', async () => {
      const { body } = await postGraphQLAs('', BUG_REPORT_MUTATION, {
        input: { teamId: team.id, title: 'Anonymous bug' },
      });

      expect(body.data ?? null).toBeNull();
      expect(body.errors?.[0]?.message).toBeTruthy();
    });

    it('emits a bug.reported outbox event and notifies team humans', async () => {
      const cookie = await login(human);
      const { body } = await reportBug(cookie, {
        title: 'Webhook delivery stalls',
        priority: 2,
        repository: 'fakechris/Involute',
      });
      const issue = body.data.bugReport.issue;

      const events = await prisma.eventOutbox.findMany({ where: { type: 'bug.reported' } });
      expect(events).toHaveLength(1);
      const payload = events[0]?.payload as {
        work?: { id?: string; identifier?: string };
        data?: { title?: string; priority?: number; repository?: string };
      };
      expect(payload.work?.id).toBe(issue.id);
      expect(payload.work?.identifier).toBe(issue.identifier);
      expect(payload.data).toMatchObject({
        title: 'Webhook delivery stalls',
        priority: 2,
        repository: 'fakechris/Involute',
      });

      const notifications = await prisma.notification.findMany({
        where: { type: 'bug.reported', userId: human.id },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.workId).toBe(issue.id);
      expect(notifications[0]?.sourceEventId).toBe(events[0]?.id);
    });
  });

  describe('bugSummary', () => {
    async function createBug(options: {
      title: string;
      priority?: number;
      repository?: string | null;
      labelIds?: string[];
      stateName?: string;
      createdAt?: Date;
    }) {
      const state = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, name: options.stateName ?? 'Backlog' },
      });
      const bugLabel = await prisma.issueLabel.findFirstOrThrow({
        where: { name: { equals: 'bug', mode: 'insensitive' } },
      });
      const issue = await createIssue(prisma, {
        labelIds: [bugLabel.id, ...(options.labelIds ?? [])],
        priority: options.priority ?? 0,
        repository: options.repository ?? null,
        source: 'bug-report',
        stateId: state.id,
        teamId: team.id,
        title: options.title,
      });
      if (options.createdAt) {
        return prisma.issue.update({
          where: { id: issue.id },
          data: { createdAt: options.createdAt },
        });
      }
      return issue;
    }

    it('returns zeroed stats with a zero-filled trend when no bugs exist', async () => {
      const cookie = await login(human);
      const { body } = await queryBugSummary(cookie);

      expect(body.errors).toBeUndefined();
      const summary = body.data.bugSummary;
      expect(summary.openCount).toBe(0);
      expect(summary.closedCount).toBe(0);
      expect(summary.byPriority).toEqual([]);
      expect(summary.byRepository).toEqual([]);
      expect(summary.byTypeLabel).toEqual([]);
      expect(summary.unclaimedOpenCount).toBe(0);
      expect(summary.oldestOpenAgeDays).toBeNull();
      expect(summary.avgOpenAgeDays).toBeNull();
      expect(summary.createdPerWeek).toHaveLength(8);
      expect(summary.createdPerWeek.every((week: { count: number }) => week.count === 0)).toBe(true);
    });

    it('counts open and closed bugs and groups by priority, repository, and type label', async () => {
      const cookie = await login(human);
      const uiLabel = await prisma.issueLabel.create({ data: { name: 'ui' } });
      await createBug({ title: 'Open urgent', priority: 1, repository: 'fakechris/Involute', labelIds: [uiLabel.id] });
      await createBug({ title: 'Open medium', priority: 3, repository: 'fakechris/Involute' });
      await createBug({ title: 'Open no repo', priority: 0, labelIds: [uiLabel.id] });
      await createBug({ title: 'Done bug', priority: 2, repository: 'fakechris/lumenbox', stateName: 'Done' });
      await createBug({ title: 'Canceled bug', priority: 4, stateName: 'Canceled' });

      const { body } = await queryBugSummary(cookie);
      const summary = body.data.bugSummary;

      expect(summary.openCount).toBe(3);
      expect(summary.closedCount).toBe(2);
      expect(summary.byPriority).toEqual([
        { priority: 1, count: 1 },
        { priority: 3, count: 1 },
        { priority: 0, count: 1 },
      ]);
      expect(summary.byRepository).toEqual([
        { repository: 'fakechris/Involute', openCount: 2, closedCount: 0 },
        { repository: 'fakechris/lumenbox', openCount: 0, closedCount: 1 },
        { repository: null, openCount: 1, closedCount: 1 },
      ]);
      expect(summary.byTypeLabel).toEqual([{ label: 'ui', count: 2 }]);
    });

    it('excludes candidates and non-bug issues from the counts', async () => {
      const cookie = await login(human);
      const bugLabel = await prisma.issueLabel.findFirstOrThrow({
        where: { name: { equals: 'bug', mode: 'insensitive' } },
      });
      const backlogState = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, name: 'Backlog' },
      });
      await prisma.issue.create({
        data: {
          identifier: 'INV-901',
          title: 'Candidate with bug label',
          commitmentStatus: 'CANDIDATE',
          stateId: backlogState.id,
          teamId: team.id,
          labels: { connect: [{ id: bugLabel.id }] },
        },
      });
      await createIssue(prisma, { teamId: team.id, title: 'Plain issue without labels' });
      await createBug({ title: 'Real bug' });

      const { body } = await queryBugSummary(cookie);
      expect(body.data.bugSummary.openCount).toBe(1);
    });

    it('tracks unclaimed open bugs using active claim leases', async () => {
      const cookie = await login(human);
      const claimedBug = await createBug({ title: 'Claimed bug' });
      const expiredClaimBug = await createBug({ title: 'Expired claim bug' });
      await createBug({ title: 'Never claimed bug' });
      await prisma.workClaim.create({
        data: {
          actorId: human.id,
          workId: claimedBug.id,
          leaseUntil: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await prisma.workClaim.create({
        data: {
          actorId: human.id,
          workId: expiredClaimBug.id,
          leaseUntil: new Date(Date.now() - 60 * 1000),
        },
      });

      const { body } = await queryBugSummary(cookie);
      expect(body.data.bugSummary.openCount).toBe(3);
      expect(body.data.bugSummary.unclaimedOpenCount).toBe(2);
    });

    it('reports oldest and average open age in days', async () => {
      const cookie = await login(human);
      const now = Date.now();
      await createBug({ title: 'Old bug', createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000) });
      await createBug({ title: 'Recent bug', createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000) });

      const { body } = await queryBugSummary(cookie);
      const summary = body.data.bugSummary;

      expect(summary.oldestOpenAgeDays).toBeGreaterThanOrEqual(10);
      expect(summary.oldestOpenAgeDays).toBeLessThan(10.2);
      expect(summary.avgOpenAgeDays).toBeGreaterThanOrEqual(6);
      expect(summary.avgOpenAgeDays).toBeLessThan(6.2);
    });

    it('builds an 8-week zero-filled creation trend', async () => {
      const cookie = await login(human);
      const now = new Date();
      const day = now.getUTCDay();
      const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      thisMonday.setUTCDate(thisMonday.getUTCDate() - ((day + 6) % 7));
      const lastMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
      await createBug({ title: 'This week bug', createdAt: now });
      await createBug({ title: 'Last week bug', createdAt: new Date(lastMonday.getTime() + 3600 * 1000) });
      // Outside the 8-week window; must not be counted.
      await createBug({ title: 'Ancient bug', createdAt: new Date(thisMonday.getTime() - 9 * 7 * 24 * 60 * 60 * 1000), stateName: 'Done' });

      const { body } = await queryBugSummary(cookie);
      const trend = body.data.bugSummary.createdPerWeek as Array<{ weekStart: string; count: number }>;

      expect(trend).toHaveLength(8);
      const byWeek = new Map(trend.map((week) => [week.weekStart, week.count]));
      expect(byWeek.get(thisMonday.toISOString().slice(0, 10))).toBe(1);
      expect(byWeek.get(lastMonday.toISOString().slice(0, 10))).toBe(1);
      expect(trend.reduce((sum, week) => sum + week.count, 0)).toBe(2);
    });

    it('applies the team filter and hides unreadable teams from non-members', async () => {
      const cookie = await login(human);
      const otherTeam = await prisma.team.create({
        data: { key: 'SON', name: 'Sonata' },
      });
      const otherBacklog = await prisma.workflowState.create({
        data: { name: 'Backlog', position: 0, teamId: otherTeam.id, type: 'BACKLOG' },
      });
      const bugLabel = await prisma.issueLabel.findFirstOrThrow({
        where: { name: { equals: 'bug', mode: 'insensitive' } },
      });
      await prisma.issue.create({
        data: {
          identifier: 'SON-1',
          title: 'Other team bug',
          commitmentStatus: 'COMMITTED',
          stateId: otherBacklog.id,
          teamId: otherTeam.id,
          labels: { connect: [{ id: bugLabel.id }] },
        },
      });
      await createBug({ title: 'Involute bug' });

      const allTeams = await queryBugSummary(cookie);
      expect(allTeams.body.data.bugSummary.openCount).toBe(2);

      const filtered = await queryBugSummary(cookie, { key: { eq: DEFAULT_TEAM_KEY } });
      expect(filtered.body.data.bugSummary.openCount).toBe(1);

      const outsider = await prisma.user.create({
        data: { actorKind: 'HUMAN', email: 'outsider@example.com', name: 'Outsider' },
      });
      const outsiderSummary = await queryBugSummary(await login(outsider));
      expect(outsiderSummary.body.data.bugSummary.openCount).toBe(0);
    });
  });
});
