import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { AUTO_ACCEPT_ACTOR_EMAIL } from './auto-accept-gate.js';
import { BUG_GATE_SOURCE, sweepBugAutoAccept } from './bug-auto-accept.js';
import type { GitHubVerifierOptions } from './github-evidence-verifier.js';
import { createIssue, updateIssue } from './issue-service.js';
import { reviewWork } from './run-service-review.js';
import { writeActorFromViewer } from './work-service.js';

// INV-1075: GitHub, not the agent, decides whether a bug fix landed.
loadProjectEnvironment();
const prisma = new PrismaClient();
const repo = 'test/gate';
const sha = 'a'.repeat(40);

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

type Github = { merged?: boolean; head?: string; checks?: Array<{ status: string; conclusion: string | null }>; status?: number; compare?: string };
function github(state: Github): GitHubVerifierOptions & { calls: string[] } {
  const calls: string[] = [];
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  return {
    calls,
    repositories: new Set([repo]),
    installationToken: async () => 'token',
    fetch: (async (url: string | URL) => {
      const path = String(url).replace('https://api.github.com', '');
      calls.push(path);
      if (state.status) return respond({}, state.status);
      if (path === `/repos/${repo}/pulls/12`) return respond({ number: 12, merged: state.merged ?? true, merge_commit_sha: 'b'.repeat(40), base: { repo: { full_name: repo } }, head: { sha: state.head ?? sha } });
      if (path === `/repos/${repo}`) return respond({ default_branch: 'main' });
      if (path.startsWith(`/repos/${repo}/compare/`)) return respond({ status: state.compare ?? 'behind' });
      if (path.startsWith(`/repos/${repo}/commits/${sha}/check-runs`)) {
        const checks = state.checks ?? [{ status: 'completed', conclusion: 'success' }];
        return respond({ total_count: checks.length, check_runs: checks.map((check, index) => ({ name: `job-${index}`, ...check })) });
      }
      return respond({}, 404);
    }) as typeof fetch,
  };
}

async function fixture(options: { optIn?: boolean; label?: string; pr?: number | null } = {}) {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
  const project = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: repo, repository: repo });
  if (options.optIn !== false) await updateIssue(prisma, project.id, { autoAcceptBugs: true }, writeActorFromViewer(human));
  const label = await prisma.issueLabel.upsert({ where: { name: options.label ?? 'Bug' }, create: { name: options.label ?? 'Bug' }, update: {} });
  const bug = await createIssue(prisma, { teamId: team.id, kind: 'ISSUE', title: 'Broken thing', repository: repo, parentId: project.id, stateId: review.id, labelIds: [label.id], acceptance: 'fixed', assigneeId: human.id });
  const agent = await prisma.user.create({ data: { name: 'Fixer', email: `fixer-${randomUUID()}@agents.test`, actorKind: 'AGENT', ownerId: human.id } });
  const run = await prisma.workRun.create({ data: { workId: bug.id, publicId: `RUN-${randomUUID()}`, actorId: agent.id, status: 'COMPLETED', repository: repo, commitSha: sha, pullRequestNumber: options.pr === undefined ? 12 : options.pr, startedAt: new Date(Date.now() - 60_000) } });
  const stateOf = async () => (await prisma.issue.findUniqueOrThrow({ where: { id: bug.id }, include: { state: true } })).state.type;
  const evaluations = () => prisma.workAutoAcceptEvaluation.findMany({ where: { workId: bug.id, signals: { path: ['source'], equals: BUG_GATE_SOURCE } }, orderBy: { createdAt: 'asc' } });
  return { team, human, project, bug, run, agent, stateOf, evaluations };
}

describe('bug auto-accept gate (INV-1075)', () => {
  it('accepts a bug whose PR GitHub shows merged with green checks, as the Auto-Accept Gate', async () => {
    const f = await fixture();
    const gh = github({});
    expect(await sweepBugAutoAccept(prisma, gh)).toEqual({ accepted: 1, skipped: 0 });
    expect(await f.stateOf()).toBe('COMPLETED');
    const decision = await prisma.workReviewDecision.findFirstOrThrow({ where: { workId: f.bug.id }, include: { reviewer: true } });
    expect(decision.decision).toBe('ACCEPTED');
    expect(decision.reviewer.email).toBe(AUTO_ACCEPT_ACTOR_EMAIL);
    expect(decision.reviewer.actorKind).toBe('SERVICE');
    expect(decision.reason).toContain('PR #12 merged');
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: f.bug.id }, orderBy: { createdAt: 'desc' } });
    expect(audit.actorKind).toBe('SERVICE');
    expect((await f.evaluations()).map((e) => [e.outcome, e.tier])).toEqual([['ACCEPTED', 'CLEAR']]);
    // The agent that did the work hears the outcome.
    expect(await prisma.notification.count({ where: { userId: f.agent.id, type: 'work.accepted' } })).toBe(1);
  });

  it('accepts a fix committed straight to the default branch when its checks are green', async () => {
    const f = await fixture({ pr: null });
    await sweepBugAutoAccept(prisma, github({ compare: 'identical' }));
    expect(await f.stateOf()).toBe('COMPLETED');
  });

  it('leaves the bug in Review and says why when GitHub does not confirm the fix', async () => {
    const cases: Array<[Github, string]> = [
      [{ merged: false }, 'PR_NOT_MERGED'],
      [{ head: 'c'.repeat(40) }, 'HEAD_CHANGED'],
      [{ checks: [] }, 'NO_CHECKS'],
      [{ checks: [{ status: 'completed', conclusion: 'failure' }] }, 'CHECK_FAILED'],
      [{ checks: [{ status: 'in_progress', conclusion: null }] }, 'CHECK_PENDING'],
      [{ status: 429 }, 'RATE_OR_PERMISSION_LIMIT'],
    ];
    for (const [state, code] of cases) {
      await resetAndSeed(prisma);
      const f = await fixture();
      expect(await sweepBugAutoAccept(prisma, github(state))).toEqual({ accepted: 0, skipped: 1 });
      expect(await f.stateOf(), code).toBe('REVIEW');
      const [evaluation] = await f.evaluations();
      expect(evaluation?.outcome, code).toBe('SKIPPED');
      expect(evaluation?.reasons.join(' '), code).toContain(code);
    }
  });

  it('leaves the commit off the default branch, non-bugs, and projects that did not opt in', async () => {
    const offBranch = await fixture({ pr: null });
    await sweepBugAutoAccept(prisma, github({ compare: 'diverged' }));
    expect(await offBranch.stateOf()).toBe('REVIEW');
    expect((await offBranch.evaluations())[0]?.reasons.join(' ')).toContain('COMMIT_NOT_ON_DEFAULT_BRANCH');

    await resetAndSeed(prisma);
    const feature = await fixture({ label: 'Feature' });
    const gh = github({});
    await sweepBugAutoAccept(prisma, gh);
    expect(await feature.stateOf()).toBe('REVIEW');

    await resetAndSeed(prisma);
    const off = await fixture({ optIn: false });
    const quiet = github({});
    expect(await sweepBugAutoAccept(prisma, quiet)).toEqual({ accepted: 0, skipped: 0 });
    expect(await off.stateOf()).toBe('REVIEW');
    expect(quiet.calls).toEqual([]);
  });

  it('does not re-ask GitHub within the retry window, and a person can return an auto-accepted bug', async () => {
    const f = await fixture();
    const gh = github({ merged: false });
    await sweepBugAutoAccept(prisma, gh);
    const asked = gh.calls.length;
    await sweepBugAutoAccept(prisma, gh);
    expect(gh.calls.length).toBe(asked);

    // GitHub catches up after the window: accepted.
    await sweepBugAutoAccept(prisma, github({}), new Date(Date.now() + 11 * 60_000));
    expect(await f.stateOf()).toBe('COMPLETED');

    // Undo: the person moves it back to Review.
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.team.id, type: 'REVIEW' } });
    await updateIssue(prisma, f.bug.id, { stateId: review.id }, writeActorFromViewer(f.human));
    expect(await f.stateOf()).toBe('REVIEW');
    // ...and the gate does not take it back: the person owns it now.
    const later = github({});
    await sweepBugAutoAccept(prisma, later, new Date(Date.now() + 30 * 60_000));
    expect(await f.stateOf()).toBe('REVIEW');
    expect(later.calls).toEqual([]);
    expect((await f.evaluations()).at(-1)?.reasons.join(' ')).toContain('waits for a person');
  });

  it('covers only the opted-in team, even when another team uses the same repository name', async () => {
    const f = await fixture();
    const other = await prisma.team.create({ data: { key: 'OTH', name: 'Other' } });
    const otherReview = await prisma.workflowState.create({ data: { teamId: other.id, name: 'In Review', type: 'REVIEW', position: 3 } });
    await prisma.workflowState.create({ data: { teamId: other.id, name: 'Done', type: 'COMPLETED', position: 4 } });
    const label = await prisma.issueLabel.findUniqueOrThrow({ where: { name: 'Bug' } });
    const foreign = await prisma.issue.create({ data: { teamId: other.id, identifier: 'OTH-1', title: 'Not yours', repository: repo, stateId: otherReview.id, labels: { connect: { id: label.id } } } });
    await prisma.workRun.create({ data: { workId: foreign.id, publicId: `RUN-${randomUUID()}`, status: 'COMPLETED', repository: repo, commitSha: sha, pullRequestNumber: 12 } });
    await sweepBugAutoAccept(prisma, github({}));
    expect(await f.stateOf()).toBe('COMPLETED');
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: foreign.id }, include: { state: true } })).state.type).toBe('REVIEW');
  });

  it('only people turn the switch on, only on a PROJECT, and agents still cannot accept', async () => {
    const f = await fixture({ optIn: false });
    await expect(updateIssue(prisma, f.project.id, { autoAcceptBugs: true }, writeActorFromViewer(f.agent))).rejects.toThrow('Only a person');
    await expect(updateIssue(prisma, f.bug.id, { autoAcceptBugs: true }, writeActorFromViewer(f.human))).rejects.toThrow('PROJECT');
    await expect(reviewWork(prisma, f.bug.id, { decision: 'ACCEPTED', expectedRevision: f.bug.revision }, writeActorFromViewer(f.agent))).rejects.toThrow();
  });
});
