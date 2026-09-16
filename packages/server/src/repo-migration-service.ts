import type { PrismaClient } from '@prisma/client';

import { createValidationError } from './errors.js';
import { assertNodeHierarchy, lockWorkGraph } from './graph-integrity.js';
import { INTERNAL_WRITE_ACTOR, recordWorkAudit, selectIssueSnapshot } from './work-service.js';

export interface RepoMigrationOptions {
  fromRepo: string;
  toRepo: string;
  teamKey?: string | null;
  dryRun?: boolean;
}

export interface RepoMigrationResult {
  affectedIssueIdentifiers: string[];
  dryRun: boolean;
  fromRepo: string;
  migratedIssuesCount: number;
  migratedRunsCount: number;
  toRepo: string;
}

/**
 * Atomically migrate all work items and work runs matching fromRepo to toRepo.
 * Verifies graph hierarchy integrity within the same transaction.
 */
export async function migrateRepository(
  prisma: PrismaClient,
  options: RepoMigrationOptions,
): Promise<RepoMigrationResult> {
  const fromRepo = options.fromRepo?.trim();
  const toRepo = options.toRepo?.trim();

  if (!fromRepo || !toRepo) {
    throw createValidationError('Both fromRepo and toRepo must be provided.');
  }

  if (fromRepo === toRepo) {
    throw createValidationError('fromRepo and toRepo must be different.');
  }

  if (options.fromRepo !== fromRepo || options.toRepo !== toRepo) {
    throw createValidationError('Repository values must not have surrounding whitespace.');
  }

  let teamIdFilter: string | undefined;
  if (options.teamKey) {
    const team = await prisma.team.findUnique({
      where: { key: options.teamKey },
      select: { id: true },
    });
    if (!team) {
      throw createValidationError(`Team with key "${options.teamKey}" not found.`);
    }
    teamIdFilter = team.id;
  }

  const issues = await prisma.issue.findMany({
    where: {
      repository: fromRepo,
      ...(teamIdFilter ? { teamId: teamIdFilter } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  const runs = await prisma.workRun.findMany({
    where: {
      repository: fromRepo,
      ...(teamIdFilter ? { work: { teamId: teamIdFilter } } : {}),
    },
    select: { id: true },
  });

  const affectedIssueIdentifiers = issues.map((i) => i.identifier);

  if (options.dryRun) {
    return {
      affectedIssueIdentifiers,
      dryRun: true,
      fromRepo,
      migratedIssuesCount: issues.length,
      migratedRunsCount: runs.length,
      toRepo,
    };
  }

  if (issues.length === 0 && runs.length === 0) {
    return {
      affectedIssueIdentifiers: [],
      dryRun: false,
      fromRepo,
      migratedIssuesCount: 0,
      migratedRunsCount: 0,
      toRepo,
    };
  }

  await prisma.$transaction(async (tx) => {
    // 1. Lock all affected teams to prevent concurrent hierarchy modifications
    const teamIds = Array.from(new Set(issues.map((i) => i.teamId)));
    for (const teamId of teamIds) {
      await lockWorkGraph(tx, teamId);
    }

    // 2. Update issues
    const issueIds = issues.map((i) => i.id);
    await tx.issue.updateMany({
      where: { id: { in: issueIds } },
      data: {
        repository: toRepo,
        revision: { increment: 1 },
      },
    });

    // 3. Update work runs
    const runIds = runs.map((r) => r.id);
    if (runIds.length > 0) {
      await tx.workRun.updateMany({
        where: { id: { in: runIds } },
        data: { repository: toRepo },
      });
    }

    // 4. Record work audit
    for (const issue of issues) {
      await recordWorkAudit(tx, {
        actor: INTERNAL_WRITE_ACTOR,
        after: selectIssueSnapshot({
          ...issue,
          repository: toRepo,
          revision: issue.revision + 1,
        }),
        before: selectIssueSnapshot(issue),
        workId: issue.id,
      });
    }

    // 5. Assert hierarchy integrity for all updated issues
    const updatedIssues = await tx.issue.findMany({
      where: { id: { in: issueIds } },
      select: { id: true, kind: true, parentId: true, repository: true, teamId: true },
    });
    for (const node of updatedIssues) {
      await assertNodeHierarchy(tx, node);
    }
  });

  return {
    affectedIssueIdentifiers,
    dryRun: false,
    fromRepo,
    migratedIssuesCount: issues.length,
    migratedRunsCount: runs.length,
    toRepo,
  };
}
