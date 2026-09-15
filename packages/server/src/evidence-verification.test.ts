import { PrismaClient, type Team, type User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { parseAcceptance, parseGitHubEvidence, snapshotContract } from './evidence-contract.ts';
import { verifyGitHubEvidence, type GitHubVerifierOptions, type VerificationRequest } from './github-evidence-verifier.ts';
import { verifyEvidence } from './evidence-verification.ts';
import { tryAutoAccept } from './auto-accept-gate.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { attachEvidence, reportRun, reviewWork } from './run-service.ts';
import { updateIssue } from './issue-service.ts';

const repository = 'example/project';
const sha = 'a'.repeat(40);
const acceptance = { version: 1 as const, criteria: [
  { id: 'test', required: true, workflowId: 7, job: 'verify' },
] };
const input: VerificationRequest = { repository, commitSha: sha, pullRequestNumber: 4,
  url: `https://github.com/${repository}/actions/runs/8`, acceptance };
type ResponseHook = (path: string, data: Record<string, unknown> | unknown[], count: number) => unknown | Promise<unknown>;

function fixture(hook?: ResponseHook) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const counts = new Map<string, number>();
  const options: GitHubVerifierOptions = { repositories: new Set([repository]), installationToken: async () => 'test-installation-token',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      let data: Record<string, unknown> | unknown[];
      if (path.endsWith('/pulls/4')) data = { id: 40, number: 4, merged: true, head: { sha }, base: { repo: { full_name: repository } } };
      else if (path.endsWith('/actions/runs/8')) data = { id: 8, event: 'push', workflow_id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, repository: { full_name: repository }, updated_at: '2026-09-14T00:00:00Z' };
      else if (path.includes('/commits/')) data = [{ id: 40, number: 4, merged_at: '2026-09-14T00:00:00Z', head: { sha }, base: { repo: { full_name: repository } } }];
      else if (path.includes('/attempts/1/jobs')) data = { total_count: 1, jobs: [{ id: 9, run_id: 8, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] };
      else throw new Error(`unexpected fixture request: ${path}`);
      const value = hook ? await hook(path, data, count) : data;
      return value instanceof Response ? value : Response.json(value);
    }) as typeof fetch };
  return { calls, options };
}

describe('semantic contracts and GitHub API verification', () => {
  it('orders mixed-case criterion IDs by code units before hashing', () => {
    const criteria = ['a', 'Z', 'A', 'z'].map(id => ({ ...acceptance.criteria[0], id }));
    expect(parseAcceptance(JSON.stringify({ version: 1, criteria }))?.criteria.map(x => x.id)).toEqual(['A', 'Z', 'a', 'z']);
  });

  it('uses semantic content versions, ignoring state/revision/JSON key order', () => {
    const work = { acceptance: JSON.stringify(acceptance), repository, scope: 'scope', constraints: 'constraints', revision: 1, stateId: 'ready' };
    expect(snapshotContract({ ...work, revision: 99, stateId: 'review' } as typeof work).contractRevision).toBe(snapshotContract(work).contractRevision);
    expect(snapshotContract({ ...work, scope: 'changed' }).contractRevision).not.toBe(snapshotContract(work).contractRevision);
    expect(snapshotContract({ ...work, acceptance: JSON.stringify({ criteria: acceptance.criteria, version: 1 }) }).contractRevision).toBe(snapshotContract(work).contractRevision);
    expect(parseAcceptance('tests passed')).toBeNull();
    expect(parseAcceptance(JSON.stringify({ version: 1, criteria: [acceptance.criteria[0], acceptance.criteria[0]] }))).toBeNull();
    expect(parseAcceptance(JSON.stringify({ version: 1, criteria: [{ ...acceptance.criteria[0], required: false }] }))).toBeNull();
  });

  it.each(['http://github.com/example/project/pull/4', 'https://github.com.evil.test/example/project/pull/4',
    'https://user@github.com/example/project/pull/4', 'https://github.com/example/project/pull/4?redirect=x',
    'https://github.com/example/project/actions/runs/8/../../pull/4', 'https://127.0.0.1/private'])('rejects noncanonical object URL %s', async url => {
    const f = fixture();
    expect(parseGitHubEvidence(url)).toBeNull();
    expect((await verifyGitHubEvidence({ ...input, url }, f.options)).status).toBe('UNAVAILABLE');
    expect(f.calls).toHaveLength(0);
  });

  it('covers mapped successful jobs and pins host, redirects, SHA and run attempt', async () => {
    const f = fixture();
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.status).toBe('VERIFIED');
    expect(result.covered).toEqual(['test']);
    expect(result.source).toMatchObject({ attempt: 1, workflowId: 7, headSha: sha });
    expect(f.calls.every(call => call.url.startsWith('https://api.github.com/repos/example/project/'))).toBe(true);
    expect(f.calls.every(call => call.init?.redirect === 'error')).toBe(true);
    expect(f.calls.some(call => call.url.includes('/attempts/1/jobs'))).toBe(true);
  });

  it.each(['missing', 'different-pr', 'unmerged', 'wrong-head'])('requires the declared merged PR association: %s', async variant => {
    const f = fixture((path, data) => path.includes('/commits/') ? variant === 'missing' ? [] : [{
      id: 40, number: variant === 'different-pr' ? 5 : 4,
      merged_at: variant === 'unmerged' ? null : '2026-09-14T00:00:00Z',
      head: { sha: variant === 'wrong-head' ? 'b'.repeat(40) : sha }, base: { repo: { full_name: repository } },
    }] : data);
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.covered).toEqual([]);
  });

  it('paginates commit associations and fails closed at the page bound', async () => {
    const other = { id: 50, number: 5 };
    const paged = fixture((path, data) => path.includes('/commits/') && path.endsWith('page=1') ? Array(100).fill(other) : data);
    expect((await verifyGitHubEvidence(input, paged.options)).status).toBe('VERIFIED');
    const capped = fixture((path, data) => path.includes('/commits/') ? Array(100).fill(other) : data);
    expect((await verifyGitHubEvidence(input, capped.options)).status).toBe('UNAVAILABLE');
    expect(capped.calls.filter(call => call.url.includes('/commits/'))).toHaveLength(10);
  });

  it('accepts a push run only with the matching merged-PR commit association', async () => {
    const result = await verifyGitHubEvidence(input, fixture().options);
    expect(result.status).toBe('VERIFIED');
    expect(result.source).toMatchObject({ association: 'github-commit-pulls', prId: 40, associationSha: sha, runEvent: 'push' });
  });

  it('rejects an unmapped failed job even when the workflow reports success', async () => {
    const f = fixture((path, data) => path.includes('/jobs?') ? { total_count: 2, jobs: [
      { id: 9, run_id: 8, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' },
      { id: 10, run_id: 8, head_sha: sha, name: 'security', status: 'completed', conclusion: 'failure' },
    ] } : data);
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.status).toBe('FAILED');
    expect(result.covered).toEqual([]);
  });

  it('records job completion time separately from workflow update time', async () => {
    const f = fixture((path, data) => path.includes('/jobs?') ? { total_count: 1, jobs: [
      { id: 9, run_id: 8, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-09-14T01:00:00Z' },
    ] } : path.endsWith('/actions/runs/8') ? { ...data, updated_at: '2026-09-14T02:00:00Z' } : data);
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.source).toMatchObject({ completedAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T02:00:00Z' });
  });

  it('paginates all jobs without trusting arbitrary next URLs', async () => {
    const f = fixture((path, data) => path.includes('/jobs?') ? { total_count: 101, jobs:
      path.endsWith('page=1') ? Array.from({ length: 100 }, (_, n) => ({ id: n + 10, run_id: 8, head_sha: sha, name: `other-${n}`, status: 'completed', conclusion: 'success' }))
        : [{ id: 110, run_id: 8, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] } : data);
    expect((await verifyGitHubEvidence(input, f.options)).covered).toEqual(['test']);
  });

  it.each([
    ['head', 'STALE'], ['repo', 'FAILED'], ['run', 'FAILED'], ['workflow', 'FAILED'], ['job', 'FAILED'],
    ['failure', 'FAILED'], ['pending', 'PENDING'], ['rerun', 'STALE'], ['permission', 'UNAVAILABLE'], ['page', 'UNAVAILABLE'],
  ])('fails closed on %s', async (variant, expected) => {
    const f = fixture((path, data, count) => {
      if (variant === 'permission') return new Response('', { status: 429 });
      if (path.endsWith('/pulls/4') && variant === 'head') return { ...data, head: { sha: 'b'.repeat(40) } };
      if (path.endsWith('/actions/runs/8')) {
        if (variant === 'repo') return { ...data, repository: { full_name: 'other/project' } };
        if (variant === 'run') return { ...data, id: 99 };
        if (variant === 'workflow') return { ...data, workflow_id: 99 };
        if (variant === 'failure') return { ...data, conclusion: 'failure' };
        if (variant === 'pending') return { ...data, status: 'in_progress' };
        if (variant === 'rerun' && count === 2) return { ...data, run_attempt: 2 };
      }
      if (path.includes('/jobs?') && variant === 'job') return { total_count: 1, jobs: [{ id: 9, run_id: 99, head_sha: sha, name: 'verify' }] };
      if (path.includes('/jobs?') && variant === 'page') return { total_count: 1001, jobs: [] };
      return data;
    });
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.status).toBe(expected);
    expect(result.covered).toEqual([]);
  });

  it('a successful run with skipped or missing required jobs provides no coverage', async () => {
    const f = fixture((path, data) => path.includes('/jobs?') ? { total_count: 1, jobs: [{ id: 9, run_id: 8, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'skipped' }] } : data);
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.status).toBe('VERIFIED');
    expect(result.covered).toEqual([]);
  });

  it('does not leak raw transport or credential errors', async () => {
    const f = fixture();
    f.options.installationToken = async () => { throw new Error('private token: do-not-persist'); };
    const result = await verifyGitHubEvidence(input, f.options);
    expect(result.failureCode).toBe('GITHUB_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('do-not-persist');
  });
});

describe('trusted evidence shadow integration', () => {
  const prisma = new PrismaClient();
  let team: Team;
  let human: User;
  let executor: User;
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.eventOutboxDelivery.deleteMany(); await prisma.eventOutbox.deleteMany(); await prisma.webhookSubscription.deleteMany();
    await prisma.workAutoAcceptEvaluation.deleteMany(); await prisma.workReviewDecision.deleteMany();
    await prisma.workEvidence.deleteMany(); await prisma.workRun.deleteMany(); await prisma.comment.deleteMany();
    await prisma.issue.deleteMany(); await prisma.workflowState.deleteMany(); await prisma.team.deleteMany();
    await prisma.user.deleteMany(); await prisma.legacyLinearMapping.deleteMany(); await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    executor = await prisma.user.create({ data: { name: 'Executor', email: 'verifier-executor@example.test', actorKind: 'AGENT' } });
  });
  const actor = () => ({ actorId: executor.id, actorKind: 'AGENT' as const, surface: 'test' });
  const reviewer = () => ({ actorId: human.id, actorKind: 'HUMAN' as const, surface: 'test' });
  async function setup() {
    const proposed = await proposeWork(prisma, { teamId: team.id, title: 'Verify evidence', repository }, reviewer());
    const committed = await commitWork(prisma, proposed.id, { acceptance: JSON.stringify(acceptance), assigneeId: human.id, expectedRevision: proposed.revision }, reviewer());
    const { claim } = await claimWork(prisma, committed.id, {}, actor());
    const { run } = await reportRun(prisma, { workId: committed.id, status: 'running', commitSha: sha, pullRequestNumber: 4 }, actor());
    const { evidence } = await attachEvidence(prisma, { workId: committed.id, runId: run.id, kind: 'test', url: input.url, summary: 'exit:0' }, actor());
    return { work: committed, run, evidence, claim };
  }

  it('freezes claim/semantic contract, appends observations, and never auto-accepts even CLEAR', async () => {
    const s = await setup();
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, status: 'completed' }, actor());
    const run = await prisma.workRun.findUniqueOrThrow({ where: { id: s.run.id } });
    expect(run.claimId).toBeNull(); expect(run.claimSnapshotId).toBe(s.claim.id);
    const observation = await verifyEvidence(prisma, s.evidence.id, fixture().options);
    expect(observation.status).toBe('VERIFIED');
    const result = await tryAutoAccept(prisma, s.work.id, { runId: run.id });
    expect(result?.grade.tier).toBe('CLEAR'); expect(result?.evaluation.outcome).toBe('SKIPPED');
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: s.work.id }, include: { state: true } })).state.type).toBe('REVIEW');
    expect(await prisma.workReviewDecision.count()).toBe(0);
    expect(await prisma.eventOutbox.count({ where: { type: 'work.accepted' } })).toBe(0);
    expect(await prisma.evidenceVerification.count({ where: { evidenceId: s.evidence.id } })).toBe(2);
    expect((await prisma.workEvidence.findUniqueOrThrow({ where: { id: s.evidence.id } })).summary).toBe('exit:0');
    const current = await prisma.issue.findUniqueOrThrow({ where: { id: s.work.id } });
    await reviewWork(prisma, current.id, { decision: 'ACCEPTED', expectedRevision: current.revision, runId: run.id }, reviewer());
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: s.work.id }, include: { state: true } })).state.type).toBe('COMPLETED');
  });

  it('state/priority edits preserve semantic version; changed contract while fetching is STALE', async () => {
    const s = await setup();
    const current = await prisma.issue.findUniqueOrThrow({ where: { id: s.work.id } });
    await updateIssue(prisma, current.id, { expectedRevision: current.revision, priority: 3 }, reviewer());
    expect(snapshotContract(await prisma.issue.findUniqueOrThrow({ where: { id: current.id } })).contractRevision).toBe(s.run.contractRevision);
    let edited = false;
    const f = fixture(async (_path, data) => {
      if (!edited) {
        edited = true;
        const row = await prisma.issue.findUniqueOrThrow({ where: { id: current.id } });
        await updateIssue(prisma, row.id, { expectedRevision: row.revision, scope: 'new scope' }, reviewer());
      }
      return data;
    });
    expect((await verifyEvidence(prisma, s.evidence.id, f.options)).status).toBe('STALE');
  });

  it('head updates invalidate prior coverage and completed targets cannot be changed', async () => {
    const s = await setup();
    await verifyEvidence(prisma, s.evidence.id, fixture().options);
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, commitSha: 'b'.repeat(40), status: 'completed' }, actor());
    expect((await tryAutoAccept(prisma, s.work.id, { runId: s.run.id }))?.grade.tier).not.toBe('CLEAR');
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, commitSha: sha }, actor());
    expect((await prisma.workRun.findUniqueOrThrow({ where: { id: s.run.id } })).commitSha).toBe('b'.repeat(40));
  });

  it('changing only the PR invalidates coverage for the previous PR at the same SHA', async () => {
    const s = await setup();
    await verifyEvidence(prisma, s.evidence.id, fixture().options);
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, pullRequestNumber: 5, status: 'completed' }, actor());
    expect((await tryAutoAccept(prisma, s.work.id))?.grade.tier).not.toBe('CLEAR');
  });

  it('missing required criteria and unavailable refresh retain Review, preserving all observations', async () => {
    const s = await setup();
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, status: 'completed' }, actor());
    const missing = fixture((path, data) => path.includes('/jobs?') ? { total_count: 0, jobs: [] } : data);
    await verifyEvidence(prisma, s.evidence.id, missing.options);
    expect((await tryAutoAccept(prisma, s.work.id))?.grade.tier).not.toBe('CLEAR');
    await verifyEvidence(prisma, s.evidence.id, fixture().options);
    expect((await tryAutoAccept(prisma, s.work.id))?.grade.tier).toBe('CLEAR');
    await verifyEvidence(prisma, s.evidence.id, fixture(() => new Response('', { status: 429 })).options);
    expect((await tryAutoAccept(prisma, s.work.id))?.grade.tier).not.toBe('CLEAR');
    expect(await prisma.evidenceVerification.count({ where: { evidenceId: s.evidence.id } })).toBe(6);
  });

  it('human rejection during network verification prevents a new evaluation or acceptance', async () => {
    const s = await setup();
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, status: 'completed' }, actor());
    let rejected = false;
    const f = fixture(async (_path, data) => {
      if (!rejected) {
        rejected = true;
        const row = await prisma.issue.findUniqueOrThrow({ where: { id: s.work.id } });
        await reviewWork(prisma, row.id, { decision: 'REJECTED', expectedRevision: row.revision, runId: s.run.id }, reviewer());
      }
      return data;
    });
    await verifyEvidence(prisma, s.evidence.id, f.options);
    expect(await tryAutoAccept(prisma, s.work.id)).toBeNull();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: s.work.id }, include: { state: true } })).state.type).toBe('UNSTARTED');
    expect(await prisma.workReviewDecision.count({ where: { decision: 'ACCEPTED' } })).toBe(0);
  });

  it('a superseding claim invalidates the completed attempt; cross-run attachment is forbidden', async () => {
    const s = await setup();
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, status: 'completed' }, actor());
    await verifyEvidence(prisma, s.evidence.id, fixture().options);
    await prisma.workClaim.create({ data: { workId: s.work.id, actorId: human.id, leaseUntil: new Date(Date.now() + 60000) } });
    expect((await tryAutoAccept(prisma, s.work.id))?.grade.tier).not.toBe('CLEAR');
    await expect(attachEvidence(prisma, { workId: s.work.id, runId: s.run.id, kind: 'test', url: input.url }, reviewer())).rejects.toThrow();
  });

  it('does not backfill historical declarations or legacy run snapshots as trusted', async () => {
    const s = await setup();
    const old = await prisma.workEvidence.create({ data: { workId: s.work.id, runId: s.run.id, kind: 'TEST', url: input.url, summary: 'VERIFIED' } });
    await expect(verifyEvidence(prisma, old.id, fixture().options)).rejects.toThrow('EVIDENCE_NOT_REQUESTED');
    expect(await prisma.evidenceVerification.count({ where: { evidenceId: old.id } })).toBe(0);
  });

  it('serializes verifier workers and rejects an observation after its lease is superseded', async () => {
    const s = await setup();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const f = fixture(async (_path, data) => { started(); await blocked; return data; });
    const first = verifyEvidence(prisma, s.evidence.id, f.options);
    await entered;
    await expect(verifyEvidence(prisma, s.evidence.id, fixture().options)).rejects.toThrow('VERIFICATION_BUSY');
    await prisma.workEvidence.update({ where: { id: s.evidence.id }, data: { verificationLeaseId: null } });
    release();
    await expect(first).rejects.toThrow('VERIFICATION_LEASE_LOST');
    expect(await prisma.evidenceVerification.count({ where: { evidenceId: s.evidence.id, status: 'VERIFIED' } })).toBe(0);
  });

  it('rolls back the shadow evaluation and outbox with the caller transaction', async () => {
    const s = await setup();
    await reportRun(prisma, { workId: s.work.id, runId: s.run.id, status: 'completed' }, actor());
    await verifyEvidence(prisma, s.evidence.id, fixture().options);
    const before = await prisma.workAutoAcceptEvaluation.count();
    const events = await prisma.eventOutbox.count();
    await expect(prisma.$transaction(async tx => {
      expect((await tryAutoAccept(tx, s.work.id))?.grade.tier).toBe('CLEAR');
      throw new Error('CALLER_ROLLBACK');
    })).rejects.toThrow('CALLER_ROLLBACK');
    expect(await prisma.workAutoAcceptEvaluation.count()).toBe(before);
    expect(await prisma.eventOutbox.count()).toBe(events);
  });
});
