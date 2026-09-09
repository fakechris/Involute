import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { commitWork, proposeWork } from './claim-service.ts';
import type { GitHubApiClient, GitHubSyncPullRequest } from './github-sync.ts';
import {
  reconcileAllConfiguredRepos,
  reconcileRepoPullRequests,
} from './github-sync.ts';
import { DEFAULT_REPO_ROUTES } from './github-repo-routes.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

class MockGitHubApiClient implements GitHubApiClient {
  public prs: GitHubSyncPullRequest[] = [];
  public fetchCalls: Array<{ repository: string; since: Date }> = [];

  async fetchPullRequestsSince(
    repository: string,
    since: Date,
  ): Promise<GitHubSyncPullRequest[]> {
    this.fetchCalls.push({ repository, since });
    const sinceMs = since.getTime();
    return this.prs.filter(
      (pr) => new Date(pr.updated_at).getTime() >= sinceMs,
    );
  }
}

describe('GitHub Reconciliation Sync Engine (Phase 3)', () => {
  let team: Team;
  let human: User;
  const involuteRoute = DEFAULT_REPO_ROUTES[0]; // fakechris/Involute -> INV

  beforeAll(async () => {
    await prisma.$connect();
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.syncDeadLetter.deleteMany();
    await prisma.syncWatermark.deleteMany();
    await prisma.webhookEventLog.deleteMany();
    await prisma.workEvidence.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.workAudit.deleteMany();
    await prisma.issue.deleteMany();

    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  async function createTestIssue(title: string) {
    const candidate = await proposeWork(
      prisma,
      { teamId: team.id, title },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    return commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'Acceptance criteria',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
  }

  it('advances watermark cursor cleanly when no updates found', async () => {
    const mockClient = new MockGitHubApiClient();
    const initialWatermark = new Date('2026-09-08T00:00:00.000Z');

    const result = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: initialWatermark,
    });

    expect(result.totalFetched).toBe(0);
    expect(result.processedCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.watermarkAfter.getTime()).toBeGreaterThan(initialWatermark.getTime());

    const savedWatermark = await prisma.syncWatermark.findUniqueOrThrow({
      where: { key: `github_sync_${involuteRoute.repository}` },
    });
    expect(savedWatermark.watermark.toISOString()).toBe(result.watermarkAfter.toISOString());
  });

  it('pulls open PR and advances issue to REVIEW with evidence and watermark progression', async () => {
    const issue = await createTestIssue('Sync open PR test');
    const mockClient = new MockGitHubApiClient();

    const prTime = '2026-09-09T10:00:00.000Z';
    mockClient.prs = [
      {
        id: 1001,
        number: 10,
        title: `feat: [${issue.identifier}] implement reconciliation`,
        html_url: 'https://github.com/fakechris/Involute/pull/10',
        state: 'open',
        merged_at: null,
        head: { ref: `feat/${issue.identifier}-sync` },
        updated_at: prTime,
      },
    ];

    const result = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
    });

    expect(result.totalFetched).toBe(1);
    expect(result.processedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.watermarkAfter.toISOString()).toBe(prTime);

    // Verify issue state transitioned to REVIEW
    const updatedIssue = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      include: { state: true, evidence: true },
    });
    expect(updatedIssue.state.type).toBe('REVIEW');
    expect(updatedIssue.evidence).toHaveLength(1);
    expect(updatedIssue.evidence[0].url).toBe('https://github.com/fakechris/Involute/pull/10');
  });

  it('processes merged PR and advances issue to COMPLETED', async () => {
    const issue = await createTestIssue('Sync merged PR test');
    const mockClient = new MockGitHubApiClient();

    const mergeTime = '2026-09-09T12:00:00.000Z';
    mockClient.prs = [
      {
        id: 1002,
        number: 11,
        title: `feat: [${issue.identifier}] merged deliverable`,
        html_url: 'https://github.com/fakechris/Involute/pull/11',
        state: 'closed',
        merged_at: mergeTime,
        merge_commit_sha: '1234567890abcdef',
        head: { ref: `feat/${issue.identifier}-merged` },
        updated_at: mergeTime,
      },
    ];

    const result = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
    });

    expect(result.processedCount).toBe(1);
    expect(result.watermarkAfter.toISOString()).toBe(mergeTime);

    const updatedIssue = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      include: { state: true, evidence: true },
    });
    expect(updatedIssue.state.type).toBe('COMPLETED');
    expect(updatedIssue.evidence[0].summary).toContain('Merged in 1234567');
  });

  it('idempotent replay: re-syncing same PRs is a clean no-op with zero errors', async () => {
    const issue = await createTestIssue('Idempotent replay test');
    const mockClient = new MockGitHubApiClient();

    const prTime = '2026-09-09T13:00:00.000Z';
    mockClient.prs = [
      {
        id: 1003,
        number: 12,
        title: `feat: [${issue.identifier}] replay test`,
        html_url: 'https://github.com/fakechris/Involute/pull/12',
        state: 'open',
        merged_at: null,
        head: { ref: `feat/${issue.identifier}-replay` },
        updated_at: prTime,
      },
    ];

    // First sync
    const firstResult = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
    });
    expect(firstResult.processedCount).toBe(1);

    // Second sync with identical PRs (e.g. updated:>= overlap)
    const secondResult = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date(prTime),
    });
    expect(secondResult.processedCount).toBe(1);
    expect(secondResult.errorCount).toBe(0);

    const evidenceCount = await prisma.workEvidence.count({ where: { workId: issue.id } });
    expect(evidenceCount).toBe(1); // No duplicate evidence rows
  });

  it('poisoned PR is quarantined in SyncDeadLetter and does not block cursor or subsequent PRs', async () => {
    const validIssue = await createTestIssue('Valid issue for sync');
    const mockClient = new MockGitHubApiClient();

    // PR 1 is poisoned (invalid title/branch missing identifier or malformed data that throws)
    // To simulate a processing error, we craft a PR where head ref is malformed or invalid
    // Wait, if an unexpected exception occurs inside processGitHubPrEvent, it is caught.
    // Let's create a client that returns 2 PRs:
    // PR 20: invalid PR referencing nonexistent issue identifier that we know will fail if simulated,
    // or let's spy on processGitHubPrEvent for PR 20 to throw.
    const time1 = '2026-09-09T14:00:00.000Z';
    const time2 = '2026-09-09T14:05:00.000Z';

    mockClient.prs = [
      {
        id: 2001,
        number: 20,
        title: 'bad PR that fails',
        html_url: 'https://github.com/fakechris/Involute/pull/20',
        state: 'open',
        merged_at: null,
        head: { ref: `feat/${validIssue.identifier}-poison` },
        updated_at: time1,
      },
      {
        id: 2002,
        number: 21,
        title: `feat: [${validIssue.identifier}] good PR`,
        html_url: 'https://github.com/fakechris/Involute/pull/21',
        state: 'open',
        merged_at: null,
        head: { ref: `feat/${validIssue.identifier}-good` },
        updated_at: time2,
      },
    ];

    const errorSpy = async (p: PrismaClient, payload: any) => {
      if (payload.pull_request.number === 20) {
        throw new Error('Simulated network/DB poison error for PR 20');
      }
      const { processGitHubPrEvent } = await import('./github-webhook-handler.ts');
      return processGitHubPrEvent(p, payload);
    };

    const result = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
      processPrEvent: errorSpy,
    });

    // PR 20 failed, PR 21 succeeded
    expect(result.errorCount).toBe(1);
    expect(result.processedCount).toBe(1);
    expect(result.deadLetteredRefs).toEqual(['pr#20']);

    // P1-1: Watermark is held at PR 20's timestamp (time1) so it is not orphaned!
    expect(result.watermarkAfter.toISOString()).toBe(time1);

    // Verify SyncDeadLetter recorded PR 20
    const deadLetter = await prisma.syncDeadLetter.findUniqueOrThrow({
      where: {
        repository_itemRef: {
          repository: involuteRoute.repository,
          itemRef: 'pr#20',
        },
      },
    });
    expect(deadLetter.attempts).toBe(1);
    expect(deadLetter.error).toContain('Simulated network/DB poison error');

    // Now run again up to 3 times to verify quarantine threshold
    await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
      maxDeadLetterAttempts: 3,
      processPrEvent: errorSpy,
    });

    await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
      maxDeadLetterAttempts: 3,
      processPrEvent: errorSpy,
    });

    const deadLetter3 = await prisma.syncDeadLetter.findUniqueOrThrow({
      where: {
        repository_itemRef: {
          repository: involuteRoute.repository,
          itemRef: 'pr#20',
        },
      },
    });
    expect(deadLetter3.attempts).toBe(3);

    // On 4th run, attempts >= maxDeadLetterAttempts (3), so PR 20 is quarantined and skipped!
    const quarantinedResult = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: mockClient,
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
      maxDeadLetterAttempts: 3,
      processPrEvent: errorSpy,
    });

    expect(quarantinedResult.skippedDeadLetterCount).toBe(1);
    expect(quarantinedResult.errorCount).toBe(0); // Quarantined items don't count as active errors
    // Now that PR 20 is quarantined, watermark advances past it to time2!
    expect(quarantinedResult.watermarkAfter.toISOString()).toBe(time2);
  });

  it('transient failure in mid-window is retried in next run without forceWatermark and recovers (P1-1 orphan hole closed)', async () => {
    const issueA = await createTestIssue('Transient fail issue A');
    const issueB = await createTestIssue('Good issue B');

    const client = new MockGitHubApiClient();
    const timeA = '2026-09-09T10:00:00.000Z';
    const timeB = '2026-09-09T11:00:00.000Z';

    client.prs = [
      {
        id: 301,
        number: 31,
        title: `feat: [${issueA.identifier}] fix A`,
        html_url: 'https://github.com/fakechris/Involute/pull/31',
        state: 'open',
        merged_at: null,
        head: { ref: `feat/${issueA.identifier}-pr` },
        updated_at: timeA,
      },
      {
        id: 302,
        number: 32,
        title: `feat: [${issueB.identifier}] fix B`,
        html_url: 'https://github.com/fakechris/Involute/pull/32',
        state: 'open',
        merged_at: null,
        head: { ref: `feat/${issueB.identifier}-pr` },
        updated_at: timeB,
      },
    ];

    let failA = true;
    const transientSpy = async (p: PrismaClient, payload: any) => {
      if (payload.pull_request.number === 31 && failA) {
        throw new Error('Transient DB connection error');
      }
      const { processGitHubPrEvent } = await import('./github-webhook-handler.ts');
      return processGitHubPrEvent(p, payload);
    };

    // Run 1: Initial sync from 09:00. PR#31 fails, PR#32 succeeds.
    const run1 = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: client,
      forceWatermark: new Date('2026-09-09T09:00:00.000Z'),
      processPrEvent: transientSpy,
    });

    expect(run1.errorCount).toBe(1);
    expect(run1.processedCount).toBe(1);
    // Watermark must NOT jump to 11:00 (PR#32)! It must stay held at 10:00 (PR#31).
    expect(run1.watermarkAfter.toISOString()).toBe(timeA);

    // Run 2: Production path — NO forceWatermark! Reads watermark from DB (`timeA`).
    // Transient error is now resolved.
    failA = false;
    const run2 = await reconcileRepoPullRequests({
      prisma,
      repoRoute: involuteRoute,
      githubClient: client,
      // No forceWatermark — uses saved watermark from DB
      processPrEvent: transientSpy,
    });

    expect(run2.errorCount).toBe(0);
    // PR#31 was re-fetched and successfully processed!
    const updatedIssueA = await prisma.issue.findUniqueOrThrow({
      where: { id: issueA.id },
      include: { state: true },
    });
    expect(updatedIssueA.state.type).toBe('REVIEW');

    // Dead letter record for PR#31 should be cleared on success
    const remainingDeadLetter = await prisma.syncDeadLetter.findFirst({
      where: { repository: involuteRoute.repository, itemRef: 'pr#31' },
    });
    expect(remainingDeadLetter).toBeNull();

    // Watermark now successfully advances to timeB (11:00)!
    expect(run2.watermarkAfter.toISOString()).toBe(timeB);
  });

  it('DefaultGitHubApiClient paginates backwards in descending order and stops when older than since (P1-2)', async () => {
    const { DefaultGitHubApiClient } = await import('./github-sync.ts');
    const client = new DefaultGitHubApiClient('dummy_token');

    const sinceDate = new Date('2026-09-09T12:00:00.000Z');

    // Mock fetch to return page 1 (100 items from 14:00 down to 12:30) and page 2 (from 12:30 down to 11:00)
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: any) => {
      fetchCount++;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page') ?? '1');

      if (page === 1) {
        // Page 1: 100 items, newest is 14:00, oldest is 12:30 (all >= sinceDate)
        const items = Array.from({ length: 100 }, (_, i) => ({
          id: 1000 + i,
          number: 1000 + i,
          title: `PR ${1000 + i}`,
          html_url: `https://github.com/fakechris/Involute/pull/${1000 + i}`,
          state: 'open',
          merged_at: null,
          head: { ref: `feat/branch-${i}` },
          updated_at: new Date(new Date('2026-09-09T14:00:00.000Z').getTime() - i * 60 * 1000).toISOString(),
        }));
        return new Response(JSON.stringify(items), { status: 200 });
      } else if (page === 2) {
        // Page 2: items from 12:20 down to 11:00 (crosses sinceDate threshold at 12:00)
        const items = Array.from({ length: 50 }, (_, i) => ({
          id: 2000 + i,
          number: 2000 + i,
          title: `PR ${2000 + i}`,
          html_url: `https://github.com/fakechris/Involute/pull/${2000 + i}`,
          state: 'open',
          merged_at: null,
          head: { ref: `feat/branch-${i}` },
          updated_at: new Date(new Date('2026-09-09T12:20:00.000Z').getTime() - i * 60 * 1000).toISOString(),
        }));
        return new Response(JSON.stringify(items), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const results = await client.fetchPullRequestsSince('fakechris/Involute', sinceDate);

      // Fetch stopped at page 2 when it hit an item older than 12:00
      expect(fetchCount).toBe(2);

      // All returned items must be >= sinceDate
      for (const pr of results) {
        expect(new Date(pr.updated_at).getTime()).toBeGreaterThanOrEqual(sinceDate.getTime());
      }

      // Returned items must be sorted ascending (oldest first)
      for (let i = 1; i < results.length; i++) {
        const prev = new Date(results[i - 1].updated_at).getTime();
        const curr = new Date(results[i].updated_at).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reconcileAllConfiguredRepos iterates across all configured repo routes', async () => {
    const mockClient = new MockGitHubApiClient();
    const results = await reconcileAllConfiguredRepos(prisma, mockClient, {
      forceWatermark: new Date('2026-09-09T00:00:00.000Z'),
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    const repos = results.map((r) => r.repository);
    expect(repos).toContain('fakechris/Involute');
    expect(repos).toContain('fakechris/lumenbox');
  });
});
