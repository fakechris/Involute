import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { createIssue } from './issue-service.ts';
import { loadPullRequests, pullRequestBatcher, summarizePullRequests } from './pull-requests.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const at = (iso: string) => new Date(iso);
const evidence = (url: string, summary: string | null, created: string, retracted: string | null = null) => ({ url, summary, createdAt: at(created), retractedAt: retracted ? at(retracted) : null });

describe('pull requests of a work item (INV-1703)', () => {
  it('folds the opened and merged deliveries of one PR into one merged entry with its SHA', () => {
    const prs = summarizePullRequests('fakechris/Involute', [], [
      evidence('https://github.com/fakechris/Involute/pull/315', 'GitHub PR #315: docs: record the connection', '2026-11-07T02:00:38Z'),
      evidence('https://github.com/fakechris/Involute/pull/315', 'GitHub PR #315: docs: record the connection (Merged in bf6fdc2)', '2026-11-07T02:14:00Z'),
    ]);
    expect(prs).toEqual([
      { repository: 'fakechris/Involute', number: 315, url: 'https://github.com/fakechris/Involute/pull/315', title: 'docs: record the connection', state: 'MERGED', mergeSha: 'bf6fdc2', updatedAt: at('2026-11-07T02:14:00Z') },
    ]);
  });

  it('keeps a PR open until GitHub says it merged, links a run-only PR, ignores retracted evidence, newest first', () => {
    const prs = summarizePullRequests(
      'fakechris/Involute',
      [{ repository: null, pullRequestNumber: 316, updatedAt: at('2026-11-07T03:00:00Z') }, { repository: 'fakechris/Involute', pullRequestNumber: 315, updatedAt: at('2026-11-07T01:00:00Z') }],
      [
        evidence('https://github.com/fakechris/Involute/pull/315/', 'GitHub PR #315: open one', '2026-11-07T02:00:00Z'),
        evidence('https://github.com/fakechris/Involute/pull/314', 'GitHub PR #314: wrong one', '2026-11-07T02:00:00Z', '2026-11-07T02:05:00Z'),
        evidence('https://acme.sentry.io/issues/1', 'Crash', '2026-11-07T02:00:00Z'),
      ],
    );
    expect(prs.map((pr) => [pr.number, pr.state, pr.title])).toEqual([
      [316, 'LINKED', null],
      [315, 'OPEN', 'open one'],
    ]);
  });

  describe('loaded from the database', () => {
    beforeEach(async () => {
      await resetAndSeed(prisma);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('reads every work asked in one tick together, and returns an empty list for work with no PR', async () => {
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const project = await createIssue(prisma, { teamId: team.id, title: 'acme/app', kind: 'PROJECT', repository: 'acme/app' });
      const withPr = await createIssue(prisma, { teamId: team.id, title: 'Has a PR', parentId: project.id, repository: 'acme/app' });
      const without = await createIssue(prisma, { teamId: team.id, title: 'No PR', parentId: project.id, repository: 'acme/app' });
      await prisma.workEvidence.create({ data: { workId: withPr.id, kind: 'PR', url: 'https://github.com/acme/app/pull/9', summary: 'GitHub PR #9: Fix (Merged in abc1234)' } });

      const loaded = await loadPullRequests(prisma, [{ id: withPr.id, repository: 'acme/app' }, { id: without.id, repository: 'acme/app' }]);
      expect(loaded.get(withPr.id)!.map((pr) => [pr.number, pr.state, pr.mergeSha])).toEqual([[9, 'MERGED', 'abc1234']]);
      expect(loaded.get(without.id)).toEqual([]);

      const batch = pullRequestBatcher(prisma);
      const [a, b] = await Promise.all([batch({ id: withPr.id, repository: 'acme/app' }), batch({ id: without.id, repository: 'acme/app' })]);
      expect(a).toHaveLength(1);
      expect(b).toEqual([]);
    });
  });
});
