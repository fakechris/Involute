import { randomUUID } from 'node:crypto';
import { PrismaClient, type WorkflowStateType } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { loadBugMetrics } from './bug-metrics.js';
import { sweepBugAutoAccept } from './bug-auto-accept.js';
import type { GitHubVerifierOptions } from './github-evidence-verifier.js';
import { compileIqlToIssueWhere, parseIqlOrThrow } from './iql-compile.js';
import { createIssue, updateIssue } from './issue-service.js';
import { createWorkLink } from './link-service.js';
import { isReopen } from './work-reopen.js';
import { writeActorFromViewer } from './work-service.js';

// INV-1120: every terminal → open move is a reopen, counted whatever the surface.
loadProjectEnvironment();
const prisma = new PrismaClient();
const repo = 'test/reopen';
const sha = 'c'.repeat(40);

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

function greenGithub(): GitHubVerifierOptions {
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  return {
    repositories: new Set([repo]),
    installationToken: async () => 'token',
    fetch: (async (url: string | URL) => {
      const path = String(url).replace('https://api.github.com', '');
      if (path === `/repos/${repo}/pulls/7`) return respond({ number: 7, merged: true, merge_commit_sha: 'd'.repeat(40), base: { repo: { full_name: repo } }, head: { sha } });
      if (path.startsWith(`/repos/${repo}/commits/${sha}/check-runs`)) return respond({ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  };
}

async function setup() {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const state = async (type: WorkflowStateType) => prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type } });
  const project = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: repo, repository: repo });
  await updateIssue(prisma, project.id, { autoAcceptBugs: true }, writeActorFromViewer(human));
  const label = await prisma.issueLabel.upsert({ where: { name: 'Bug' }, create: { name: 'Bug' }, update: {} });
  const bug = async (title: string, type: WorkflowStateType = 'UNSTARTED') =>
    createIssue(prisma, { teamId: team.id, kind: 'ISSUE', title, repository: repo, parentId: project.id, stateId: (await state(type)).id, labelIds: [label.id], acceptance: 'fixed', assigneeId: human.id });
  const move = async (id: string, type: WorkflowStateType) => updateIssue(
    prisma, id,
    { stateId: (await state(type)).id, ...(type === 'CANCELED' ? { resolution: 'wont_do', reason: 'not worth it' } : {}) },
    writeActorFromViewer(human),
  );
  const reopenCount = async (id: string) => (await prisma.issue.findUniqueOrThrow({ where: { id } })).reopenCount;
  return { team, human, project, bug, move, reopenCount };
}

describe('reopen events and counts (INV-1120)', () => {
  it('treats only Done / Canceled → an open state as a reopen', () => {
    expect(isReopen('COMPLETED', 'UNSTARTED')).toBe(true);
    expect(isReopen('CANCELED', 'REVIEW')).toBe(true);
    expect(isReopen('COMPLETED', 'CANCELED')).toBe(false);
    expect(isReopen('REVIEW', 'STARTED')).toBe(false);
    expect(isReopen('STARTED', 'COMPLETED')).toBe(false);
  });

  it('records each reopen with its audit row and counts it on the work', async () => {
    const s = await setup();
    const item = await s.bug('Crash on save');
    await s.move(item.id, 'STARTED');
    await s.move(item.id, 'COMPLETED');
    expect(await s.reopenCount(item.id)).toBe(0);

    await s.move(item.id, 'UNSTARTED');
    expect(await s.reopenCount(item.id)).toBe(1);
    await s.move(item.id, 'CANCELED');
    await s.move(item.id, 'STARTED');
    expect(await s.reopenCount(item.id)).toBe(2);

    const reopens = await prisma.workReopen.findMany({ where: { workId: item.id }, orderBy: { createdAt: 'asc' }, include: { audit: true } });
    expect(reopens.map((row) => [row.fromStateType, row.toStateType, row.afterAutoAccept])).toEqual([
      ['COMPLETED', 'UNSTARTED', false],
      ['CANCELED', 'STARTED', false],
    ]);
    expect(reopens[0]!.audit).toMatchObject({ workId: item.id, actorId: s.human.id, actorKind: 'HUMAN' });

    // Done → Canceled is still closed: no reopen.
    await s.move(item.id, 'COMPLETED');
    await s.move(item.id, 'CANCELED');
    expect(await s.reopenCount(item.id)).toBe(2);
  });

  it('marks a reopen of an Auto-Accept Gate acceptance and reports both rates in bugSummary metrics', async () => {
    const s = await setup();
    const gated = await s.bug('Wrong totals', 'REVIEW');
    const agent = await prisma.user.create({ data: { name: 'Fixer', email: `fixer-${randomUUID()}@agents.test`, actorKind: 'AGENT', ownerId: s.human.id } });
    await prisma.workRun.create({ data: { workId: gated.id, publicId: `RUN-${randomUUID()}`, actorId: agent.id, status: 'COMPLETED', repository: repo, commitSha: sha, pullRequestNumber: 7, startedAt: new Date(Date.now() - 60_000) } });
    expect(await sweepBugAutoAccept(prisma, greenGithub())).toEqual({ accepted: 1, skipped: 0 });

    const humanClosed = await s.bug('Typo in footer');
    await s.move(humanClosed.id, 'COMPLETED');
    const neverClosed = await s.bug('Slow list');

    // A person reopens the auto-accepted bug: counted separately.
    await s.move(gated.id, 'REVIEW');
    // A person reopens their own close: a reopen, but not after auto-accept.
    await s.move(humanClosed.id, 'STARTED');
    await s.move(humanClosed.id, 'COMPLETED');

    const reopens = await prisma.workReopen.findMany({ where: { workId: { in: [gated.id, humanClosed.id] } } });
    expect(reopens.find((row) => row.workId === gated.id)?.afterAutoAccept).toBe(true);
    expect(reopens.find((row) => row.workId === humanClosed.id)?.afterAutoAccept).toBe(false);

    const metrics = await loadBugMetrics(prisma, { teamId: s.team.id });
    expect(metrics).toMatchObject({
      closedEverCount: 2,
      reopenedCount: 2,
      reopenRate: 1,
      autoAcceptedCount: 1,
      reopenedAfterAutoAcceptCount: 1,
      reopenedAfterAutoAcceptRate: 1,
    });
    expect(neverClosed.id).toBeDefined();
  });

  it('reports null rates before anything was closed or auto-accepted', async () => {
    const s = await setup();
    await s.bug('Open bug');
    const metrics = await loadBugMetrics(prisma, { teamId: s.team.id });
    expect(metrics).toMatchObject({ closedEverCount: 0, reopenedCount: 0, reopenRate: null, autoAcceptedCount: 0, reopenedAfterAutoAcceptCount: 0, reopenedAfterAutoAcceptRate: null });
  });

  it('finds regressions with IQL link:regressed_by', async () => {
    const s = await setup();
    const culprit = await s.bug('Refactor totals');
    const regression = await s.bug('Totals wrong again');
    await s.bug('Unrelated');
    await createWorkLink(prisma, { fromId: regression.id, toId: culprit.id, type: 'REGRESSED_BY', actor: writeActorFromViewer(s.human) });

    const find = async (query: string) => (await prisma.issue.findMany({
      where: { AND: [{ teamId: s.team.id, kind: 'ISSUE' }, compileIqlToIssueWhere(parseIqlOrThrow(query), { viewerId: null }) ?? {}] },
      select: { identifier: true },
    })).map((row) => row.identifier).sort();
    expect(await find(`link:regressed_by:${culprit.identifier}`)).toEqual([regression.identifier]);
    expect(await find('link:regressed_by:none')).not.toContain(regression.identifier);
    expect(await find('link:regressed_by:none')).toContain(culprit.identifier);
  });
});
