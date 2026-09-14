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
async function githubJson(fetcher: typeof fetch, path: string, token: string, body?: JsonObject): Promise<JsonObject> {
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
      if (size > 2_000_000) throw new VerificationError('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Service-owned credentials; short-lived GitHub App tokens restricted to one repo. */
export function configuredGitHubVerifier(): GitHubVerifierOptions {
  const repositories = new Set((process.env.GITHUB_VERIFICATION_REPOSITORIES ?? '').split(',').map(x => x.trim()).filter(x => REPOSITORY_PATTERN.test(x)));
  return {
    repositories,
    async installationToken(repository) {
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
      const result = await githubJson(fetch, `/app/installations/${installationId}/access_tokens`, jwt, {
        repositories: [repository.split('/')[1]!], permissions: { actions: 'read', pull_requests: 'read', contents: 'read' },
      });
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
    const get = (path: string) => githubJson(options.fetch ?? fetch, `/repos/${input.repository}${path}`, token);
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
