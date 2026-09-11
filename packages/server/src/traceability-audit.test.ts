import type { Issue, PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { createIssue } from './issue-service.js';
import { buildIdentifierPattern } from './github-repo-routes.ts';
import type { MergedPullRequest } from './traceability-audit.ts';
import {
  auditMergedPrTraceability,
  resolveAuditDays,
} from './traceability-audit.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const NOW = new Date('2026-09-10T12:00:00.000Z');

const INV_ROUTE = {
  repository: 'fakechris/Involute',
  teamKey: 'INV',
  identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
} as const;

function buildMergedPr(overrides: Partial<MergedPullRequest> & { number: number }): MergedPullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? 'feat: something',
    html_url: overrides.html_url ?? `https://github.com/fakechris/Involute/pull/${overrides.number}`,
    merged_at: overrides.merged_at ?? '2026-09-09T10:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-09-09T10:30:00.000Z',
    head: overrides.head ?? { ref: 'feature-branch' },
  };
}

describe('merged-PR traceability audit (INV-449)', () => {
  let team: Team;
  let human: User;

  beforeAll(async () => {
    await prisma.$connect();
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.workEvidence.deleteMany();
    await prisma.issue.deleteMany();

    let currentTeam = await prisma.team.findUnique({ where: { key: DEFAULT_TEAM_KEY } });
    if (!currentTeam) {
      await seedDatabase(prisma);
      currentTeam = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    }
    team = currentTeam;
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  async function createCommittedIssue(title: string): Promise<Issue> {
    return createIssue(prisma, { teamId: team.id, title });
  }

  it('flags merged PRs without any resolvable reference as no-identifier', async () => {
    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async () => [buildMergedPr({ number: 11, title: 'quick fix', head: { ref: 'hotfix-typo' } })],
    });

    expect(result.scannedPrCount).toBe(1);
    expect(result.anomalies).toEqual([
      {
        repository: 'fakechris/Involute',
        prNumber: 11,
        prTitle: 'quick fix',
        prUrl: 'https://github.com/fakechris/Involute/pull/11',
        identifier: null,
        reason: 'no-identifier',
      },
    ]);
    expect(result.repoErrors).toEqual([]);
  });

  it('flags references to nonexistent issues as unknown-identifier', async () => {
    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async () => [
        buildMergedPr({ number: 12, title: 'feat: [INV-9999] ghost', head: { ref: 'feat/INV-9999-ghost' } }),
      ],
    });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ identifier: 'INV-9999', reason: 'unknown-identifier' });
  });

  it('flags issues belonging to another team than the route as team-mismatch', async () => {
    const issue = await createCommittedIssue('Mismatch audit target');
    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [
        {
          repository: 'fakechris/Involute',
          teamKey: 'OTHER',
          identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
        },
      ],
      listMergedPrs: async () => [
        buildMergedPr({ number: 13, title: `feat: [${issue.identifier}] x`, head: { ref: `feat/${issue.identifier}-x` } }),
      ],
    });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ identifier: issue.identifier, reason: 'team-mismatch' });
  });

  it('flags merged PRs that never got tracked back as evidence as no-evidence', async () => {
    const issue = await createCommittedIssue('Evidence audit target');
    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async () => [
        buildMergedPr({ number: 14, title: `feat: [${issue.identifier}] x`, head: { ref: `feat/${issue.identifier}-x` } }),
      ],
    });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ identifier: issue.identifier, reason: 'no-evidence' });
  });

  it('reports no anomaly when the issue carries matching PR evidence', async () => {
    const issue = await createCommittedIssue('Clean audit target');
    await prisma.workEvidence.create({
      data: {
        workId: issue.id,
        kind: 'PR',
        url: 'https://github.com/fakechris/Involute/pull/15',
        summary: 'GitHub PR #15: clean (Merged in abc1234)',
      },
    });

    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async () => [
        buildMergedPr({ number: 15, title: `feat: [${issue.identifier}] clean`, head: { ref: `feat/${issue.identifier}-clean` } }),
      ],
    });

    expect(result.scannedPrCount).toBe(1);
    expect(result.anomalies).toEqual([]);
    expect(result.repoErrors).toEqual([]);
  });

  it('does not let evidence for PR #123 clear the no-evidence anomaly for PR #12', async () => {
    const issue = await createCommittedIssue('Digit boundary audit target');
    await prisma.workEvidence.create({
      data: {
        workId: issue.id,
        kind: 'PR',
        url: 'https://github.com/fakechris/Involute/pull/123',
        summary: 'GitHub PR #123: unrelated',
      },
    });

    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async () => [
        buildMergedPr({ number: 12, title: `feat: [${issue.identifier}] x`, head: { ref: `feat/${issue.identifier}-x` } }),
      ],
    });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({ identifier: issue.identifier, reason: 'no-evidence' });
  });

  it('clamps the lookback window to 1..90 days and defaults to 7', async () => {
    expect(resolveAuditDays(undefined)).toBe(7);
    expect(resolveAuditDays(null)).toBe(7);
    expect(resolveAuditDays(0)).toBe(1);
    expect(resolveAuditDays(-5)).toBe(1);
    expect(resolveAuditDays(500)).toBe(90);
    expect(resolveAuditDays(14)).toBe(14);

    const seenSinceDates: Date[] = [];
    const clamped = await auditMergedPrTraceability({
      prisma,
      days: 500,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async (_repo, sinceDate) => {
        seenSinceDates.push(sinceDate);
        return [];
      },
    });
    expect(clamped.days).toBe(90);
    expect(seenSinceDates[0]?.toISOString()).toBe(
      new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const defaulted = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [INV_ROUTE],
      listMergedPrs: async () => [],
    });
    expect(defaulted.days).toBe(7);
  });

  it('captures a failing repo in repoErrors and still audits the others', async () => {    const issue = await createCommittedIssue('Isolation audit target');
    await prisma.workEvidence.create({
      data: {
        workId: issue.id,
        kind: 'PR',
        url: 'https://github.com/fakechris/Involute/pull/16',
        summary: 'GitHub PR #16',
      },
    });

    const result = await auditMergedPrTraceability({
      prisma,
      now: NOW,
      repos: [
        {
          repository: 'fakechris/broken',
          teamKey: 'INV',
          identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
        },
        {
          repository: 'fakechris/Involute',
          teamKey: 'INV',
          identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
        },
      ],
      listMergedPrs: async (repo) => {
        if (repo === 'fakechris/broken') {
          throw new Error('GitHub API error 403: rate limit exceeded');
        }
        return [
          buildMergedPr({ number: 16, title: `feat: [${issue.identifier}] ok`, head: { ref: `feat/${issue.identifier}-ok` } }),
        ];
      },
    });

    expect(result.repoErrors).toEqual([
      { repository: 'fakechris/broken', message: 'GitHub API error 403: rate limit exceeded' },
    ]);
    expect(result.scannedPrCount).toBe(1);
    expect(result.anomalies).toEqual([]);
  });

  describe('alias references (INV-459)', () => {
    const LUMENBOX_ROUTE = {
      repository: 'fakechris/lumenbox',
      teamKey: 'INV',
      identifierPattern: buildIdentifierPattern(['INV', 'LUM']),
      alias: 'LUM',
    } as const;

    function aliasRefFor(issue: { identifier: string }): string {
      return `LUM-${issue.identifier.split('-')[1]}`;
    }

    it('treats an alias reference with correct membership as legal (no anomaly)', async () => {
      const issue = await createCommittedIssue('Alias member target');
      await prisma.issue.update({
        where: { id: issue.id },
        data: { repository: 'fakechris/lumenbox' },
      });
      await prisma.workEvidence.create({
        data: {
          workId: issue.id,
          kind: 'PR',
          url: 'https://github.com/fakechris/lumenbox/pull/21',
          summary: 'GitHub PR #21',
        },
      });

      const result = await auditMergedPrTraceability({
        prisma,
        now: NOW,
        repos: [LUMENBOX_ROUTE],
        listMergedPrs: async () => [
          buildMergedPr({
            number: 21,
            title: `feat: [${aliasRefFor(issue)}] aliased merge`,
            html_url: 'https://github.com/fakechris/lumenbox/pull/21',
            head: { ref: `feat/${aliasRefFor(issue)}-x` },
          }),
        ],
      });

      expect(result.scannedPrCount).toBe(1);
      expect(result.anomalies).toEqual([]);
      expect(result.repoErrors).toEqual([]);
    });

    it('flags an alias reference with wrong membership as project-mismatch', async () => {
      const issue = await createCommittedIssue('Alias non-member target');
      // repository stays null: the LUM- alias claims lumenbox membership.

      const result = await auditMergedPrTraceability({
        prisma,
        now: NOW,
        repos: [LUMENBOX_ROUTE],
        listMergedPrs: async () => [
          buildMergedPr({
            number: 22,
            title: `feat: [${aliasRefFor(issue)}] fake membership`,
            html_url: 'https://github.com/fakechris/lumenbox/pull/22',
            head: { ref: `feat/${aliasRefFor(issue)}-x` },
          }),
        ],
      });

      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]).toMatchObject({
        repository: 'fakechris/lumenbox',
        prNumber: 22,
        identifier: issue.identifier,
        reason: 'project-mismatch',
      });
    });
  });
});
