// packages/server/src/github-sync.ts
//
// Phase 3: Persistent Watermark Cursor Reconciliation Sync Engine
//
// Periodically polls GitHub for updated Pull Requests across configured repositories,
// converting them to standard events and dispatching to the dual-track CAS state machine.
//
// Design principles:
// 1. Watermark query uses `updated:>=<watermark>` (inclusive) to eliminate truncated-second blindspots.
// 2. Physical idempotency and WebhookEventLog deduplication ensure safe duplicate replay.
// 3. Low-watermark safety: watermark cursor never leaps over un-quarantined failures (closing the orphan hole).
// 4. SyncDeadLetter quarantine isolates poisoned PR events after max attempts so the cursor never stalls permanently.
// 5. Paginated descending fetch ensures the newest updates are fetched first, stopping once older than watermark.
// 6. Pluggable GitHubApiClient allows standalone unit/integration testing without network dependencies.

import type { PrismaClient } from '@prisma/client';

import type { RepoRoute } from './github-repo-routes.js';
import { getRepoRoutes } from './github-repo-routes.js';
import { emitOpsAlert } from './ops-alerts.js';
import type { PullRequestPayload } from './github-webhook-handler.js';
import { processGitHubPrEvent } from './github-webhook-handler.js';

export interface GitHubSyncPullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha?: string | null;
  head: {
    ref: string;
  };
  updated_at: string;
}

export interface GitHubApiClient {
  fetchPullRequestsSince(
    repository: string,
    since: Date,
  ): Promise<GitHubSyncPullRequest[]>;
}

/**
 * Default GitHub REST API client using fetch with paginated descending fetch.
 * Fetches newest PRs first and paginates backwards until reaching items older than `since`.
 */
export class DefaultGitHubApiClient implements GitHubApiClient {
  private token?: string;

  constructor(token?: string) {
    this.token = token || process.env.GITHUB_TOKEN;
  }

  async fetchPullRequestsSince(
    repository: string,
    since: Date,
  ): Promise<GitHubSyncPullRequest[]> {
    const sinceMs = since.getTime();
    const collected: GitHubSyncPullRequest[] = [];
    // maxPages = 10 limits each reconciliation cycle to the most recent 1,000 updated PRs.
    // In ordinary operation with periodic 10-minute cycles or 24-hour cold-start windows, 1,000 PRs
    // is well above normal activity. If an extended outage causes >1,000 PRs to be updated,
    // operators can perform segmented catch-up using manual forceWatermark (see AGENTS.md Runbook).
    const maxPages = 10;
    let page = 1;

    while (page <= maxPages) {
      const url = new URL(`https://api.github.com/repos/${repository}/pulls`);
      url.searchParams.set('state', 'all');
      url.searchParams.set('sort', 'updated');
      url.searchParams.set('direction', 'desc'); // Newest updated first
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Involute-Sync-Engine',
      };

      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const response = await fetch(url.toString(), { headers });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error ${response.status}: ${errorText}`);
      }

      const batch = (await response.json()) as GitHubSyncPullRequest[];
      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }

      let reachedOlder = false;
      for (const pr of batch) {
        const prUpdatedMs = new Date(pr.updated_at).getTime();
        if (prUpdatedMs >= sinceMs) {
          collected.push(pr);
        } else {
          // Since results are descending, all remaining items are older than since
          reachedOlder = true;
          break;
        }
      }

      if (reachedOlder || batch.length < 100) {
        break;
      }

      page++;
    }

    // Sort ascending so the state machine applies older events before newer events
    collected.sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
    );

    return collected;
  }
}

export interface ReconcileOptions {
  prisma: PrismaClient;
  repoRoute: RepoRoute;
  githubClient: GitHubApiClient;
  /** Override watermark starting point */
  forceWatermark?: Date;
  /** Fallback lookback hours if no watermark exists in database (default: 24) */
  defaultLookbackHours?: number;
  /** Max consecutive failure attempts before quarantining to dead-letter (default: 3) */
  maxDeadLetterAttempts?: number;
  /** Optional override for event processor (useful for error simulation and testing) */
  processPrEvent?: (prisma: PrismaClient, payload: PullRequestPayload) => Promise<void>;
}

export interface ReconcileResult {
  repository: string;
  watermarkBefore: Date;
  watermarkAfter: Date;
  totalFetched: number;
  processedCount: number;
  skippedDeadLetterCount: number;
  errorCount: number;
  deadLetteredRefs: string[];
}

/**
 * Reconcile a single repository's pull requests against Involute work items.
 */
export async function reconcileRepoPullRequests(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const {
    prisma,
    repoRoute,
    githubClient,
    forceWatermark,
    defaultLookbackHours = 24,
    maxDeadLetterAttempts = 3,
  } = options;

  const watermarkKey = `github_sync_${repoRoute.repository}`;

  // 1. Resolve starting watermark
  let watermarkBefore: Date;
  if (forceWatermark) {
    watermarkBefore = forceWatermark;
  } else {
    const existing = await prisma.syncWatermark.findUnique({
      where: { key: watermarkKey },
    });
    if (existing) {
      watermarkBefore = existing.watermark;
    } else {
      watermarkBefore = new Date(Date.now() - defaultLookbackHours * 3600 * 1000);
    }
  }

  // 2. Fetch updated PRs from GitHub (updated:>=watermark)
  const prs = await githubClient.fetchPullRequestsSince(
    repoRoute.repository,
    watermarkBefore,
  );

  // Sort ascending by updated_at so older events apply first
  prs.sort(
    (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
  );

  // 3. Find active quarantined dead letters
  const activeDeadLetters = await prisma.syncDeadLetter.findMany({
    where: {
      repository: repoRoute.repository,
      attempts: { gte: maxDeadLetterAttempts },
    },
  });
  const quarantinedRefs = new Set(activeDeadLetters.map((d) => d.itemRef));

  let processedCount = 0;
  let skippedDeadLetterCount = 0;
  let errorCount = 0;
  const deadLetteredRefs: string[] = [];
  let latestSuccessTimestamp = watermarkBefore.getTime();
  let earliestUnquarantinedFailureTimestamp: number | null = null;

  const processPr = options.processPrEvent ?? processGitHubPrEvent;

  // 4. Process PRs sequentially
  for (const pr of prs) {
    const itemRef = `pr#${pr.number}`;
    const prUpdatedMs = new Date(pr.updated_at).getTime();

    if (quarantinedRefs.has(itemRef)) {
      skippedDeadLetterCount++;
      console.warn(
        `[github-sync] Skipping quarantined dead-letter PR #${pr.number} on ${repoRoute.repository}`,
      );
      continue;
    }

    const payload: PullRequestPayload = {
      action: pr.state === 'open' ? 'opened' : 'closed',
      pull_request: {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        html_url: pr.html_url,
        merged: Boolean(pr.merged_at),
        head: { ref: pr.head.ref },
        updated_at: pr.updated_at,
        merge_commit_sha: pr.merge_commit_sha,
      },
      repository: {
        full_name: repoRoute.repository,
      },
    };

    try {
      await processPr(prisma, payload);
      processedCount++;

      if (prUpdatedMs > latestSuccessTimestamp) {
        latestSuccessTimestamp = prUpdatedMs;
      }

      // If item was previously marked in dead letter (under max attempts), clear it on success
      await prisma.syncDeadLetter.deleteMany({
        where: {
          repository: repoRoute.repository,
          itemRef,
        },
      });
    } catch (error: unknown) {
      errorCount++;
      deadLetteredRefs.push(itemRef);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const deadLetter = await prisma.syncDeadLetter.upsert({
        where: {
          repository_itemRef: {
            repository: repoRoute.repository,
            itemRef,
          },
        },
        create: {
          repository: repoRoute.repository,
          itemRef,
          error: errorMessage,
          attempts: 1,
          lastFailedAt: new Date(),
        },
        update: {
          error: errorMessage,
          attempts: { increment: 1 },
          lastFailedAt: new Date(),
        },
      });

      // P1-1 Fix: If this failure is not yet quarantined, record its timestamp.
      // The watermark cursor must not leap past it, ensuring it is retried next cycle.
      if (deadLetter.attempts < maxDeadLetterAttempts) {
        if (
          earliestUnquarantinedFailureTimestamp === null ||
          prUpdatedMs < earliestUnquarantinedFailureTimestamp
        ) {
          earliestUnquarantinedFailureTimestamp = prUpdatedMs;
        }
      }

      console.error(
        `[github-sync] Poisoned PR #${pr.number} on ${repoRoute.repository} recorded in dead letter (attempt ${deadLetter.attempts}/${maxDeadLetterAttempts}):`,
        errorMessage,
      );

      if (deadLetter.attempts >= maxDeadLetterAttempts) {
        await emitOpsAlert(
          prisma,
          {
            kind: 'github_sync.dead_letter',
            summary: `GitHub Sync: PR #${pr.number} on ${repoRoute.repository} quarantined after ${deadLetter.attempts} failed attempts`,
            details: {
              repository: repoRoute.repository,
              itemRef,
              prNumber: pr.number,
              attempts: deadLetter.attempts,
              error: errorMessage,
            },
          },
          process.env.OPS_WEBHOOK_URL?.trim() || null,
        );
      }
    }
  }

  // 5. Advance watermark cursor
  // P1-1 Fix: Low Watermark calculation.
  // - If any unquarantined failure occurred, hold cursor at the earliest failure timestamp
  //   so the next cycle re-fetches and retries it.
  // - Otherwise, advance to latestSuccessTimestamp.
  // - If zero PRs were fetched, advance close to current query time (minus 60s safety window).
  let watermarkAfter: Date;
  if (earliestUnquarantinedFailureTimestamp !== null) {
    watermarkAfter = new Date(earliestUnquarantinedFailureTimestamp);
  } else if (latestSuccessTimestamp > watermarkBefore.getTime()) {
    watermarkAfter = new Date(latestSuccessTimestamp);
  } else if (prs.length === 0) {
    watermarkAfter = new Date(Date.now() - 60 * 1000);
  } else {
    watermarkAfter = watermarkBefore;
  }

  await prisma.syncWatermark.upsert({
    where: { key: watermarkKey },
    create: {
      key: watermarkKey,
      watermark: watermarkAfter,
    },
    update: {
      watermark: watermarkAfter,
    },
  });

  return {
    repository: repoRoute.repository,
    watermarkBefore,
    watermarkAfter,
    totalFetched: prs.length,
    processedCount,
    skippedDeadLetterCount,
    errorCount,
    deadLetteredRefs,
  };
}

/**
 * Reconcile all configured repositories in DEFAULT_REPO_ROUTES / GITHUB_REPO_ROUTES.
 */
export async function reconcileAllConfiguredRepos(
  prisma: PrismaClient,
  githubClient: GitHubApiClient,
  options: Partial<ReconcileOptions> = {},
): Promise<ReconcileResult[]> {
  const routes = getRepoRoutes();
  const results: ReconcileResult[] = [];

  for (const route of routes) {
    try {
      const result = await reconcileRepoPullRequests({
        prisma,
        repoRoute: route,
        githubClient,
        ...options,
      });
      results.push(result);
    } catch (error) {
      console.error(`[github-sync] Failed to reconcile repo ${route.repository}:`, error);
    }
  }

  return results;
}

/**
 * Start periodic reconciliation scheduler.
 * Uses a self-scheduling setTimeout loop with isRunning guard to prevent overlapping execution.
 */
export function startGitHubSyncScheduler(
  prisma: PrismaClient,
  options: {
    intervalMs?: number;
    githubClient?: GitHubApiClient;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 10 * 60 * 1000;
  const client = options.githubClient ?? new DefaultGitHubApiClient();
  let isRunning = false;
  let isStopped = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = () => {
    if (isStopped) return;
    timer = setTimeout(async () => {
      if (isRunning || isStopped) {
        scheduleNext();
        return;
      }
      isRunning = true;
      try {
        await reconcileAllConfiguredRepos(prisma, client);
      } catch (error) {
        console.error('[github-sync] Periodic reconciliation run encountered error:', error);
      } finally {
        isRunning = false;
        scheduleNext();
      }
    }, intervalMs);
    timer?.unref?.();
  };

  scheduleNext();

  // Return unregister callback
  return () => {
    isStopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
