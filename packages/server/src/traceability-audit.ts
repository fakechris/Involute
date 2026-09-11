// packages/server/src/traceability-audit.ts
//
// INV-449: merged-PR traceability audit.
//
// The CI PR lint only regex-matches INV-\d+ offline, so merged history can
// contain PRs whose work reference was fake, unknown, cross-team, or never
// tracked back to the issue as evidence. This audit scans recently merged
// PRs across the configured repo routes and classifies those anomalies.
//
// Dependencies are injected (listMergedPrs, now, repos) so tests run fully
// offline; the default lister talks to the GitHub REST API like
// DefaultGitHubApiClient in github-sync.ts.

import type { PrismaClient } from '@prisma/client';

import type { RepoRoute } from './github-repo-routes.js';
import { listAllRepoRoutes, resolveCanonicalIssueRef } from './github-repo-routes.js';

export const TRACEABILITY_AUDIT_DEFAULT_DAYS = 7;
export const TRACEABILITY_AUDIT_MAX_DAYS = 90;

export interface MergedPullRequest {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  updated_at: string;
  head: {
    ref: string;
  };
}

export type ListMergedPrs = (repoFullName: string, sinceDate: Date) => Promise<MergedPullRequest[]>;

export interface TraceabilityAuditOptions {
  prisma: PrismaClient;
  repos?: readonly RepoRoute[];
  /** Lookback window in days (default 7, clamped to 1..90). */
  days?: number;
  now?: Date;
  listMergedPrs?: ListMergedPrs;
}

export type TraceabilityAnomalyReason =
  | 'no-identifier'
  | 'unknown-identifier'
  | 'team-mismatch'
  | 'project-mismatch'
  | 'no-evidence';

export interface TraceabilityAnomaly {
  repository: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  identifier: string | null;
  reason: TraceabilityAnomalyReason;
}

export interface TraceabilityRepoError {
  repository: string;
  message: string;
}

export interface TraceabilityAuditResult {
  scannedPrCount: number;
  days: number;
  anomalies: TraceabilityAnomaly[];
  repoErrors: TraceabilityRepoError[];
}

export function resolveAuditDays(days?: number | null): number {
  if (days === undefined || days === null || !Number.isFinite(days)) {
    return TRACEABILITY_AUDIT_DEFAULT_DAYS;
  }
  return Math.min(Math.max(Math.floor(days), 1), TRACEABILITY_AUDIT_MAX_DAYS);
}

/**
 * Default GitHub REST lister: paginates closed PRs newest-updated-first until
 * `updated_at` falls before `sinceDate`, then keeps only PRs actually merged
 * inside the window. Auth via GITHUB_TOKEN, mirroring DefaultGitHubApiClient.
 */
export async function defaultListMergedPrs(
  repoFullName: string,
  sinceDate: Date,
): Promise<MergedPullRequest[]> {
  const token = process.env.GITHUB_TOKEN;
  const sinceMs = sinceDate.getTime();
  const merged: MergedPullRequest[] = [];
  const maxPages = 10;
  let page = 1;

  while (page <= maxPages) {
    const url = new URL(`https://api.github.com/repos/${repoFullName}/pulls`);
    url.searchParams.set('state', 'closed');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Involute-Traceability-Audit',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${errorText}`);
    }

    const batch = (await response.json()) as MergedPullRequest[];
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    let reachedOlder = false;
    for (const pr of batch) {
      if (new Date(pr.updated_at).getTime() < sinceMs) {
        // Descending order: everything after this is older than the window.
        reachedOlder = true;
        break;
      }
      if (pr.merged_at && new Date(pr.merged_at).getTime() >= sinceMs) {
        merged.push(pr);
      }
    }

    if (reachedOlder || batch.length < 100) {
      break;
    }
    page++;
  }

  return merged;
}

/**
 * Scan recently merged PRs across the configured repo routes and classify
 * traceability anomalies. A repo whose API call fails is captured in
 * repoErrors instead of failing the whole audit.
 */
export async function auditMergedPrTraceability(
  options: TraceabilityAuditOptions,
): Promise<TraceabilityAuditResult> {
  const { prisma, now = new Date() } = options;
  const days = resolveAuditDays(options.days);
  const sinceDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const listMerged = options.listMergedPrs ?? defaultListMergedPrs;
  const repos = options.repos ?? (await listAllRepoRoutes(prisma));

  const anomalies: TraceabilityAnomaly[] = [];
  const repoErrors: TraceabilityRepoError[] = [];
  let scannedPrCount = 0;

  for (const route of repos) {
    let mergedPrs: MergedPullRequest[];
    try {
      mergedPrs = await listMerged(route.repository, sinceDate);
    } catch (error) {
      repoErrors.push({
        repository: route.repository,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const pr of mergedPrs) {
      scannedPrCount++;
      const base = {
        repository: route.repository,
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
      };

      const ref = resolveCanonicalIssueRef({
        branch: pr.head.ref,
        title: pr.title,
        route,
      });
      if (!ref) {
        anomalies.push({ ...base, identifier: null, reason: 'no-identifier' });
        continue;
      }
      const identifier = ref.identifier;

      const issue = await prisma.issue.findUnique({
        where: { identifier },
        include: { team: true },
      });
      if (!issue) {
        anomalies.push({ ...base, identifier, reason: 'unknown-identifier' });
        continue;
      }

      if (issue.team.key !== route.teamKey) {
        anomalies.push({ ...base, identifier, reason: 'team-mismatch' });
        continue;
      }

      // Alias references are legal when the issue actually belongs to the
      // aliased project; otherwise the membership claim is fake.
      if (
        ref.viaAlias &&
        (issue.repository ?? '').toLowerCase().trim() !== route.repository.toLowerCase().trim()
      ) {
        anomalies.push({ ...base, identifier, reason: 'project-mismatch' });
        continue;
      }

      // The webhook handler attaches evidence with the PR html_url on open
      // and merge. A bare `contains /pull/<n>` would false-match /pull/123
      // when auditing PR #12, so widen then enforce a digit boundary in JS.
      const candidates = await prisma.workEvidence.findMany({
        where: { workId: issue.id, url: { contains: `/pull/` } },
        select: { url: true },
      });
      const evidence = candidates.some((row) =>
        new RegExp(`/pull/${pr.number}(?:\\D|$)`).test(row.url),
      );
      if (!evidence) {
        anomalies.push({ ...base, identifier, reason: 'no-evidence' });
      }
    }
  }

  return { scannedPrCount, days, anomalies, repoErrors };
}
