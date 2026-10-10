import type { Issue, Prisma, PrismaClient } from '@prisma/client';

import { createValidationError, exposeErrorMessages } from './errors.js';
import { REPOSITORY_PATTERN } from './evidence-contract.js';
import { FOUND_IN_SHA_PATTERN } from './found-in.js';
import { compareCommitRange, configuredGitHubVerifier, type GitHubVerifierOptions } from './github-evidence-verifier.js';
import { BUG_GATE_SOURCE } from './bug-auto-accept.js';

/**
 * "Which bugs were fixed between these two deploys?" (INV-1121) — a simple
 * changelog. Involute deploys by SHA and keeps no version numbers (decision
 * INV-1130), and a bug's fix SHA is not stored: it is derived from what GitHub
 * itself reported, never from what an agent wrote:
 *   - a signed `pull_request.merged` webhook (or the sync engine) — its merge commit;
 *   - evidence the verifier saw merged (EvidenceVerification VERIFIED) — the PR head;
 *   - the bug gate's GitHub check (INV-1075) — the run commit and the merge commit.
 * The deploy range is GitHub's compare of from...to. A bug is listed when one
 * of its fix SHAs is in that range. When the range cannot be listed (unknown
 * SHA, reversed range, GitHub unavailable or not configured) the answer says
 * so with `known: false` — never an empty "nothing was fixed".
 */

export interface BugsFixedBetweenInput {
  repository: string;
  fromSha: string;
  toSha: string;
}

export type FixSource = 'MERGE_EVENT' | 'VERIFIED_EVIDENCE' | 'BUG_GATE';

export interface FixedBug {
  issue: Issue;
  /** The fix commit found in the range (full SHA). */
  fixSha: string;
  prNumber: number | null;
  source: FixSource;
}

export interface BugsFixedBetween {
  known: boolean;
  failureCode: string | null;
  message: string | null;
  repository: string;
  fromSha: string;
  toSha: string;
  compareStatus: string | null;
  commitCount: number | null;
  bugs: FixedBug[];
}

const BUG_LABEL = { some: { name: { equals: 'bug', mode: 'insensitive' as const } } };

export const BUGS_FIXED_SHA_INVALID_MESSAGE = 'From and to must be deploy commit SHAs: 7 to 40 hexadecimal characters (an optional "sha-" prefix is accepted).';
export const BUGS_FIXED_REPOSITORY_INVALID_MESSAGE = 'Repository must be owner/name.';
exposeErrorMessages([BUGS_FIXED_SHA_INVALID_MESSAGE, BUGS_FIXED_REPOSITORY_INVALID_MESSAGE]);

const FAILURE_MESSAGES: Record<string, string> = {
  SOURCE_NOT_ALLOWED: 'GitHub verification is not configured for this repository (GITHUB_VERIFICATION_REPOSITORIES), so the deploy range is unknown.',
  VERIFIER_NOT_CONFIGURED: 'GitHub verification has no credentials, so the deploy range is unknown.',
  UNKNOWN_SHA: 'GitHub does not know one of these SHAs in this repository, so the range is unknown.',
  RANGE_REVERSED: 'The "to" SHA is older than the "from" SHA; swap them.',
  RANGE_TOO_LARGE: 'More than 1000 commits lie between these SHAs; pick a shorter range.',
  RATE_OR_PERMISSION_LIMIT: 'GitHub refused the request (rate limit or permission), so the range is unknown; try again later.',
};

function normalizeSha(value: string): string {
  const sha = value.trim().toLowerCase().replace(/^sha-/, '');
  if (!FOUND_IN_SHA_PATTERN.test(sha)) throw createValidationError(BUGS_FIXED_SHA_INVALID_MESSAGE);
  return sha;
}

type Candidate = { sha: string; prNumber: number | null; source: FixSource };

const fullSha = (value: unknown): string | null => (typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null);
const prNumberOf = (value: unknown): number | null => (Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null);
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** Fix SHAs GitHub reported for the readable bugs of a repository, per bug. */
export async function loadFixCandidates(
  prisma: PrismaClient | Prisma.TransactionClient,
  repository: string,
  readableWhere: Prisma.IssueWhereInput | undefined,
): Promise<Map<string, Candidate[]>> {
  const bugWhere: Prisma.IssueWhereInput = { AND: [readableWhere ?? {}, { repository, kind: 'ISSUE', labels: BUG_LABEL }] };
  const candidates = new Map<string, Candidate[]>();
  const add = (workId: string, candidate: Candidate) => {
    const list = candidates.get(workId) ?? [];
    if (!list.some((item) => item.sha === candidate.sha)) list.push(candidate);
    candidates.set(workId, list);
  };

  const merges = await prisma.webhookEventLog.findMany({
    where: { eventType: 'pull_request.merged', issue: bugWhere },
    select: { issueId: true, payload: true },
  });
  for (const merge of merges) {
    const payload = asObject(merge.payload);
    const sha = fullSha(payload.mergeCommitSha);
    if (sha) add(merge.issueId, { sha, prNumber: prNumberOf(payload.prNumber), source: 'MERGE_EVENT' });
  }

  const verified = await prisma.evidenceVerification.findMany({
    where: { status: 'VERIFIED', commitSha: { not: null }, evidence: { retractedAt: null, work: bugWhere } },
    select: { commitSha: true, result: true, evidence: { select: { workId: true } } },
  });
  for (const row of verified) {
    const sha = fullSha(row.commitSha);
    const source = asObject(asObject(row.result).source);
    if (sha) add(row.evidence.workId, { sha, prNumber: prNumberOf(source.prNumber), source: 'VERIFIED_EVIDENCE' });
  }

  const gate = await prisma.workAutoAcceptEvaluation.findMany({
    where: { signals: { path: ['source'], equals: BUG_GATE_SOURCE }, AND: [{ signals: { path: ['status'], equals: 'VERIFIED' } }], work: bugWhere },
    select: { workId: true, signals: true, run: { select: { commitSha: true } } },
  });
  for (const row of gate) {
    const github = asObject(asObject(row.signals).github);
    const prNumber = prNumberOf(github.prNumber);
    const merge = fullSha(github.mergeSha);
    if (merge) add(row.workId, { sha: merge, prNumber, source: 'BUG_GATE' });
    const head = fullSha(row.run?.commitSha);
    if (head) add(row.workId, { sha: head, prNumber, source: 'BUG_GATE' });
  }
  return candidates;
}

export async function bugsFixedBetween(
  prisma: PrismaClient,
  input: BugsFixedBetweenInput,
  readableWhere: Prisma.IssueWhereInput | undefined,
  options: GitHubVerifierOptions = configuredGitHubVerifier(),
): Promise<BugsFixedBetween> {
  const repository = input.repository.trim();
  if (!REPOSITORY_PATTERN.test(repository)) throw createValidationError(BUGS_FIXED_REPOSITORY_INVALID_MESSAGE);
  const fromSha = normalizeSha(input.fromSha);
  const toSha = normalizeSha(input.toSha);
  const base = { repository, fromSha, toSha };

  const range = await compareCommitRange({ repository, base: fromSha, head: toSha }, options);
  if (range.status !== 'VERIFIED') {
    const code = range.failureCode ?? 'GITHUB_UNAVAILABLE';
    return {
      ...base, known: false, failureCode: code, compareStatus: range.compareStatus, commitCount: null, bugs: [],
      message: FAILURE_MESSAGES[code] ?? `GitHub could not list the commits between these SHAs (${code}), so the range is unknown.`,
    };
  }

  const position = new Map(range.commits.map((sha, index) => [sha, index]));
  const candidates = await loadFixCandidates(prisma, repository, readableWhere);
  const matched: Array<{ workId: string; candidate: Candidate; index: number }> = [];
  for (const [workId, list] of candidates) {
    // The earliest fix in the range is the one that shipped the fix.
    const inRange = list
      .map((candidate) => ({ candidate, index: position.get(candidate.sha) }))
      .filter((item): item is { candidate: Candidate; index: number } => item.index !== undefined)
      .sort((a, b) => a.index - b.index);
    if (inRange[0]) matched.push({ workId, ...inRange[0] });
  }
  const issues = new Map((await prisma.issue.findMany({ where: { id: { in: matched.map((item) => item.workId) } } })).map((issue) => [issue.id, issue]));
  const bugs = matched
    .sort((a, b) => a.index - b.index)
    .flatMap(({ workId, candidate }) => {
      const issue = issues.get(workId);
      return issue ? [{ issue, fixSha: candidate.sha, prNumber: candidate.prNumber, source: candidate.source }] : [];
    });
  return { ...base, known: true, failureCode: null, message: null, compareStatus: range.compareStatus, commitCount: range.commits.length, bugs };
}
