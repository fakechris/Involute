import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { EvidenceVerificationStatus } from '@prisma/client';
import { parseGitHubEvidence, REPOSITORY_PATTERN, SHA_PATTERN, type AcceptanceContract } from './evidence-contract.js';

type JsonObject = Record<string, unknown>;
export interface VerificationRequest {
  url: string;
  repository: string;
  commitSha: string;
  pullRequestNumber: number;
  acceptance: AcceptanceContract;
}
export interface VerificationObservation {
  status: EvidenceVerificationStatus;
  failureCode: string | null;
  externalRunId: string | null;
  covered: string[];
  checks: Array<{ id: number; name: string; conclusion: string | null; completedAt: string | null }>;
  source: JsonObject;
}
export interface GitHubVerifierOptions {
  repositories: ReadonlySet<string>;
  installationToken: (repository: string) => Promise<string>;
  fetch?: typeof fetch;
}

class VerificationError extends Error {
  constructor(readonly code: string, readonly status: EvidenceVerificationStatus = 'UNAVAILABLE') { super(code); }
}
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VerificationError('INVALID_RESPONSE');
  return value as JsonObject;
};
const number = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new VerificationError('INVALID_RESPONSE');
  return Number(value);
};

/** Fixed host/path, bounded body and deadline; redirects and raw errors never escape. */
async function githubJson(fetcher: typeof fetch, path: string, token: string, body?: JsonObject, maxBytes = 2_000_000): Promise<unknown> {
  const response = await fetcher(`https://api.github.com${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new VerificationError(response.status === 429 || response.status === 403 ? 'RATE_OR_PERMISSION_LIMIT' : `HTTP_${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new VerificationError('INVALID_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new VerificationError('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Service-owned credentials; short-lived GitHub App tokens restricted to one repo. */
export function configuredGitHubVerifier(): GitHubVerifierOptions {
  const repositories = new Set((process.env.GITHUB_VERIFICATION_REPOSITORIES ?? '').split(',').map(x => x.trim()).filter(x => REPOSITORY_PATTERN.test(x)));
  return {
    repositories,
    async installationToken(repository) {
      // A read-only fine-grained token is the simple setup; the GitHub App is the scoped one (INV-1075).
      const staticToken = process.env.GITHUB_VERIFICATION_TOKEN;
      if (staticToken && repositories.has(repository)) return staticToken;
      const appId = process.env.GITHUB_VERIFICATION_APP_ID;
      const installationId = process.env.GITHUB_VERIFICATION_INSTALLATION_ID;
      const keyPath = process.env.GITHUB_VERIFICATION_PRIVATE_KEY_PATH;
      if (!appId || !installationId || !/^\d+$/.test(installationId) || !keyPath || !repositories.has(repository)) {
        throw new VerificationError('VERIFIER_NOT_CONFIGURED');
      }
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
      const signer = createSign('RSA-SHA256');
      signer.update(unsigned);
      const jwt = `${unsigned}.${signer.sign(await readFile(keyPath), 'base64url')}`;
      const result = object(await githubJson(fetch, `/app/installations/${installationId}/access_tokens`, jwt, {
        repositories: [repository.split('/')[1]!], permissions: { actions: 'read', pull_requests: 'read', contents: 'read' },
      }));
      if (typeof result.token !== 'string' || !result.token) throw new VerificationError('INVALID_CREDENTIAL_RESPONSE');
      return result.token;
    },
  };
}

/** Public input is only a declaration. All positive facts come from official APIs. */
export async function verifyGitHubEvidence(input: VerificationRequest, options: GitHubVerifierOptions): Promise<VerificationObservation> {
  const result: VerificationObservation = { status: 'UNAVAILABLE', failureCode: null, externalRunId: null, covered: [], checks: [], source: {} };
  try {
    const target = parseGitHubEvidence(input.url);
    if (!target || target.repository !== input.repository || !options.repositories.has(input.repository)) throw new VerificationError('SOURCE_NOT_ALLOWED');
    if (!SHA_PATTERN.test(input.commitSha) || !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) throw new VerificationError('EXECUTION_NOT_BOUND');
    if (target.type === 'pr' && target.id !== input.pullRequestNumber) throw new VerificationError('PR_MISMATCH', 'FAILED');
    const token = await options.installationToken(input.repository);
    if (!token) throw new VerificationError('VERIFIER_NOT_CONFIGURED');
    const getValue = (path: string) => githubJson(options.fetch ?? fetch, `/repos/${input.repository}${path}`, token);
    const get = async (path: string) => object(await getValue(path));
    const checkPr = (pr: JsonObject) => {
      if (pr.number !== input.pullRequestNumber || object(object(pr.base).repo).full_name !== input.repository) throw new VerificationError('PR_MISMATCH', 'FAILED');
      if (object(pr.head).sha !== input.commitSha) throw new VerificationError('HEAD_CHANGED', 'STALE');
      if (pr.merged !== true) throw new VerificationError('PR_NOT_MERGED', 'PENDING');
    };
    const pr = await get(`/pulls/${input.pullRequestNumber}`);
    checkPr(pr);
    result.source = { prNumber: input.pullRequestNumber, headSha: input.commitSha, merged: true };
    if (target.type === 'pr') return { ...result, status: 'VERIFIED' };

    const run = await get(`/actions/runs/${target.id}`);
    const workflowId = number(run.workflow_id);
    const attempt = number(run.run_attempt);
    result.externalRunId = String(target.id);
    if (run.id !== target.id || object(run.repository).full_name !== input.repository || run.head_sha !== input.commitSha) throw new VerificationError('RUN_MISMATCH', 'FAILED');
    if (run.status !== 'completed') throw new VerificationError('RUN_PENDING', 'PENDING');
    if (run.conclusion !== 'success') throw new VerificationError('RUN_FAILED', 'FAILED');
    if (!input.acceptance.criteria.some(item => item.workflowId === workflowId)) throw new VerificationError('WORKFLOW_NOT_MAPPED', 'FAILED');

    // Verify GitHub's commit-to-merged-PR association, not run.pull_requests
    // (which can describe currently open PRs). This is commit-level evidence;
    // it does not attest which PR/event triggered the workflow.
    let associated = false;
    for (let page = 1; page <= 10; page++) {
      const data = await getValue(`/commits/${input.commitSha}/pulls?per_page=100&page=${page}`);
      if (!Array.isArray(data) || data.length > 100) throw new VerificationError('INVALID_PR_ASSOCIATION_PAGE');
      const matches = data.map(object).filter(item => item.number === input.pullRequestNumber);
      if (matches.some(item => item.id === pr.id && typeof item.merged_at === 'string' && Number.isFinite(Date.parse(item.merged_at)) &&
          object(object(item.base).repo).full_name === input.repository && object(item.head).sha === input.commitSha)) {
        associated = true;
        break;
      }
      if (data.length < 100) break;
    }
    if (!associated) throw new VerificationError('PR_COMMIT_ASSOCIATION_UNAVAILABLE');
    result.source = { ...result.source, association: 'github-commit-pulls', prId: number(pr.id),
      associationSha: input.commitSha, runEvent: typeof run.event === 'string' ? run.event : null };

    const jobs: JsonObject[] = [];
    let expectedTotal: number | null = null;
    for (let page = 1; page <= 10; page++) {
      const data = await get(`/actions/runs/${target.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (!Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 || Number(data.total_count) > 1000) throw new VerificationError('INVALID_JOB_PAGE');
      if (expectedTotal !== null && expectedTotal !== data.total_count) throw new VerificationError('JOB_SET_CHANGED');
      expectedTotal = Number(data.total_count);
      jobs.push(...data.jobs.map(object));
      if (jobs.length >= expectedTotal) break;
      if (!data.jobs.length || page === 10) throw new VerificationError('INCOMPLETE_JOB_PAGE');
    }
    if (jobs.length !== expectedTotal || new Set(jobs.map(job => number(job.id))).size !== jobs.length) throw new VerificationError('INVALID_JOB_SET');
    for (const job of jobs) {
      if (job.run_id !== target.id || job.head_sha !== input.commitSha || typeof job.name !== 'string') throw new VerificationError('JOB_MISMATCH', 'FAILED');
      result.checks.push({ id: number(job.id), name: job.name, conclusion: typeof job.conclusion === 'string' ? job.conclusion : null,
        completedAt: typeof job.completed_at === 'string' && Number.isFinite(Date.parse(job.completed_at)) ? job.completed_at : null });
    }
    // A successful run may contain continue-on-error failures outside the mapped jobs.
    if (jobs.some(job => job.conclusion && !['success', 'skipped', 'neutral'].includes(String(job.conclusion)))) throw new VerificationError('CHECK_FAILED', 'FAILED');
    if (jobs.some(job => job.status !== 'completed' || !job.conclusion)) throw new VerificationError('CHECK_PENDING', 'PENDING');
    for (const criterion of input.acceptance.criteria.filter(item => item.workflowId === workflowId)) {
      const matching = jobs.filter(job => job.name === criterion.job);
      if (matching.length && matching.every(job => job.status === 'completed' && job.conclusion === 'success')) result.covered.push(criterion.id);
      else if (matching.some(job => job.conclusion && !['success', 'skipped', 'neutral'].includes(String(job.conclusion)))) throw new VerificationError('CHECK_FAILED', 'FAILED');
    }
    // Reject a new head or rerun that appeared while paginating the check set.
    checkPr(await get(`/pulls/${input.pullRequestNumber}`));
    const fresh = await get(`/actions/runs/${target.id}`);
    if (fresh.id !== run.id || fresh.run_attempt !== attempt || fresh.head_sha !== input.commitSha || fresh.status !== 'completed' || fresh.conclusion !== 'success') throw new VerificationError('RUN_CHANGED', 'STALE');
    const completedTimes = result.checks.flatMap(check => check.completedAt ? [Date.parse(check.completedAt)] : []);
    result.source = { ...result.source, workflowId, attempt, updatedAt: run.updated_at ?? null,
      completedAt: completedTimes.length ? new Date(Math.max(...completedTimes)).toISOString() : null };
    return { ...result, status: 'VERIFIED' };
  } catch (error) {
    return { ...result, covered: [], status: error instanceof VerificationError ? error.status : 'UNAVAILABLE',
      failureCode: error instanceof VerificationError ? error.code : 'GITHUB_UNAVAILABLE' };
  }
}

export interface BugFixRequest {
  repository: string;
  commitSha: string;
  /** When the run named a PR, it must be merged with this head; otherwise the commit must be on the default branch. */
  pullRequestNumber: number | null;
}

export interface BugFixObservation {
  status: EvidenceVerificationStatus;
  failureCode: string | null;
  source: JsonObject;
  checks: Array<{ name: string; conclusion: string | null }>;
}

/**
 * Did GitHub land this fix (INV-1075)? Positive facts only from the API: the
 * PR is merged with the run's head, or the commit is an ancestor of the
 * default branch; and the commit has at least one check run, all completed
 * and none failed. Anything else is a reason to leave the work for a person.
 */
export async function verifyBugFix(input: BugFixRequest, options: GitHubVerifierOptions): Promise<BugFixObservation> {
  const result: BugFixObservation = { status: 'UNAVAILABLE', failureCode: null, source: {}, checks: [] };
  try {
    if (!REPOSITORY_PATTERN.test(input.repository) || !options.repositories.has(input.repository)) throw new VerificationError('SOURCE_NOT_ALLOWED');
    if (!SHA_PATTERN.test(input.commitSha)) throw new VerificationError('EXECUTION_NOT_BOUND');
    const token = await options.installationToken(input.repository);
    if (!token) throw new VerificationError('VERIFIER_NOT_CONFIGURED');
    const get = async (path: string) => object(await githubJson(options.fetch ?? fetch, `/repos/${input.repository}${path}`, token));
    if (input.pullRequestNumber) {
      const pr = await get(`/pulls/${input.pullRequestNumber}`);
      if (pr.number !== input.pullRequestNumber || object(object(pr.base).repo).full_name !== input.repository) throw new VerificationError('PR_MISMATCH', 'FAILED');
      if (object(pr.head).sha !== input.commitSha) throw new VerificationError('HEAD_CHANGED', 'STALE');
      if (pr.merged !== true) throw new VerificationError('PR_NOT_MERGED', 'PENDING');
      result.source = { mode: 'pr', prNumber: input.pullRequestNumber, mergeSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null };
    } else {
      const repo = await get('');
      const branch = typeof repo.default_branch === 'string' ? repo.default_branch : null;
      if (!branch) throw new VerificationError('INVALID_RESPONSE');
      const compare = await get(`/compare/${encodeURIComponent(branch)}...${input.commitSha}`);
      // "behind"/"identical": the commit is already contained in the default branch.
      if (compare.status !== 'behind' && compare.status !== 'identical') throw new VerificationError('COMMIT_NOT_ON_DEFAULT_BRANCH', 'PENDING');
      result.source = { mode: 'branch', defaultBranch: branch };
    }
    const runs = await get(`/commits/${input.commitSha}/check-runs?per_page=100`);
    if (!Array.isArray(runs.check_runs) || !Number.isSafeInteger(runs.total_count)) throw new VerificationError('INVALID_RESPONSE');
    const checkRuns = runs.check_runs.map(object);
    result.checks = checkRuns.map((run) => ({ name: String(run.name ?? ''), conclusion: typeof run.conclusion === 'string' ? run.conclusion : null }));
    if (Number(runs.total_count) === 0) throw new VerificationError('NO_CHECKS', 'FAILED');
    if (Number(runs.total_count) > checkRuns.length) throw new VerificationError('INCOMPLETE_CHECK_PAGE');
    if (checkRuns.some((run) => run.conclusion && !['success', 'skipped', 'neutral'].includes(String(run.conclusion)))) throw new VerificationError('CHECK_FAILED', 'FAILED');
    if (checkRuns.some((run) => run.status !== 'completed' || !run.conclusion)) throw new VerificationError('CHECK_PENDING', 'PENDING');
    if (!checkRuns.some((run) => run.conclusion === 'success')) throw new VerificationError('NO_PASSING_CHECK', 'FAILED');
    return { ...result, status: 'VERIFIED' };
  } catch (error) {
    return { ...result, status: error instanceof VerificationError ? error.status : 'UNAVAILABLE',
      failureCode: error instanceof VerificationError ? error.code : 'GITHUB_UNAVAILABLE' };
  }
}

export interface CommitRangeRequest {
  repository: string;
  /** The older deploy SHA (7–40 hex); commits reachable from it are excluded. */
  base: string;
  /** The newer deploy SHA (7–40 hex); commits reachable from it, and it, are included. */
  head: string;
}

export interface CommitRangeObservation {
  /** VERIFIED when GitHub listed the whole range; anything else means the range is unknown. */
  status: EvidenceVerificationStatus;
  failureCode: string | null;
  /** GitHub's compare status: ahead, identical, diverged (behind is refused as RANGE_REVERSED). */
  compareStatus: string | null;
  /** Full SHAs in head but not in base, oldest first. */
  commits: string[];
}

/** GitHub lists at most this many commits of one range here; longer ranges are refused, never cut. */
export const COMMIT_RANGE_LIMIT = 1000;

/**
 * The commits deployed between two SHAs (INV-1121): GitHub's compare of
 * base...head, every page. An unknown SHA, a reversed range, a range longer
 * than COMMIT_RANGE_LIMIT or any GitHub failure is returned as such — never
 * as an empty range.
 */
export async function compareCommitRange(input: CommitRangeRequest, options: GitHubVerifierOptions): Promise<CommitRangeObservation> {
  const result: CommitRangeObservation = { status: 'UNAVAILABLE', failureCode: null, compareStatus: null, commits: [] };
  try {
    if (!REPOSITORY_PATTERN.test(input.repository) || !options.repositories.has(input.repository)) throw new VerificationError('SOURCE_NOT_ALLOWED');
    const range = /^[a-f0-9]{7,40}$/;
    if (!range.test(input.base) || !range.test(input.head)) throw new VerificationError('INVALID_SHA', 'FAILED');
    const token = await options.installationToken(input.repository);
    if (!token) throw new VerificationError('VERIFIER_NOT_CONFIGURED');
    const commits: string[] = [];
    let total: number | null = null;
    for (let page = 1; page <= COMMIT_RANGE_LIMIT / 100; page++) {
      let data: JsonObject;
      try {
        // The first page also carries the changed files, so it may be large.
        data = object(await githubJson(options.fetch ?? fetch, `/repos/${input.repository}/compare/${input.base}...${input.head}?per_page=100&page=${page}`, token, undefined, 20_000_000));
      } catch (error) {
        // 404: GitHub does not know one of the SHAs (or they share no history).
        if (error instanceof VerificationError && error.code === 'HTTP_404') throw new VerificationError('UNKNOWN_SHA', 'FAILED');
        throw error;
      }
      if (typeof data.status !== 'string' || !Number.isSafeInteger(data.total_commits) || !Array.isArray(data.commits)) throw new VerificationError('INVALID_RESPONSE');
      if (data.status === 'behind') throw new VerificationError('RANGE_REVERSED', 'FAILED');
      if (total !== null && total !== data.total_commits) throw new VerificationError('RANGE_CHANGED');
      total = Number(data.total_commits);
      if (total > COMMIT_RANGE_LIMIT) throw new VerificationError('RANGE_TOO_LARGE', 'FAILED');
      result.compareStatus = data.status;
      for (const commit of data.commits.map(object)) {
        if (typeof commit.sha !== 'string' || !SHA_PATTERN.test(commit.sha)) throw new VerificationError('INVALID_RESPONSE');
        commits.push(commit.sha);
      }
      if (commits.length >= total || data.commits.length === 0) break;
    }
    if (total === null || commits.length !== total) throw new VerificationError('INCOMPLETE_RANGE');
    return { ...result, status: 'VERIFIED', commits };
  } catch (error) {
    return { ...result, commits: [], status: error instanceof VerificationError ? error.status : 'UNAVAILABLE',
      failureCode: error instanceof VerificationError ? error.code : 'GITHUB_UNAVAILABLE' };
  }
}
