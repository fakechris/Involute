/**
 * CLI verify command — compares imported data against the export source directory.
 *
 * Usage: involute import verify --file <export-dir>
 *
 * Reads the export directory and queries the database to compare counts and data
 * integrity per entity type (teams, workflow states, labels, users, issues, comments).
 * Reports pass/fail for each entity type.
 */

import type { Command } from 'commander';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDatabaseUrl, fileExists, loadEnv, readJsonFile } from './shared.js';

interface VerifyOptions {
  file: string;
}

export interface EntityVerification {
  entity: string;
  exportCount: number;
  dbCount: number;
  passed: boolean;
  details?: string | undefined;
}

export interface VerificationResult {
  entities: EntityVerification[];
  allPassed: boolean;
}

interface CommentVerificationStats {
  exportCount: number;
  mappedCount: number;
  dbCount: number;
}

interface ScopedEntityVerificationStats {
  exportCount: number;
  mappedCount: number;
  dbCount: number;
}

interface ExportedIssueForVerify {
  id: string;
  identifier: string;
  updatedAt?: string;
  parent: { id: string } | null;
}

interface ExportedCommentForVerify {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string } | null;
}

function isWithinOneSecond(actual: Date, expected: string): boolean {
  return Math.abs(actual.getTime() - new Date(expected).getTime()) < 1_000;
}

function commentUpdatedAtMatchesAllowedImportSemantics(params: {
  actualUpdatedAt: Date;
  exportedUpdatedAt: string;
  exportedCreatedAt: string;
  issueUpdatedAt: string;
}): boolean {
  const { actualUpdatedAt, exportedUpdatedAt, exportedCreatedAt, issueUpdatedAt } = params;

  return (
    isWithinOneSecond(actualUpdatedAt, exportedUpdatedAt) ||
    isWithinOneSecond(actualUpdatedAt, exportedCreatedAt) ||
    isWithinOneSecond(actualUpdatedAt, issueUpdatedAt)
  );
}

async function verifyComments(
  prisma: InstanceType<(typeof import('@prisma/client'))['PrismaClient']>,
  exportDir: string,
): Promise<EntityVerification> {
  const issuesFile = join(exportDir, 'issues.json');
  const issuesFileExists = await fileExists(issuesFile);

  if (!issuesFileExists) {
    return {
      entity: 'Comments',
      exportCount: 0,
      dbCount: 0,
      passed: true,
    };
  }

  const exportIssues = await readJsonFile<ExportedIssueForVerify[]>(issuesFile);
  const exportCommentsByIssueId = new Map<string, ExportedCommentForVerify[]>();
  const allExportComments: Array<{ issueId: string; comment: ExportedCommentForVerify; issueUpdatedAt: string }> = [];

  if (exportIssues.length > 0) {
    const commentsDir = join(exportDir, 'comments');

    for (const issue of exportIssues) {
      const commentsFile = join(commentsDir, `${issue.id}.json`);
      const exists = await fileExists(commentsFile);

      if (!exists) {
        continue;
      }

      const comments = await readJsonFile<ExportedCommentForVerify[]>(commentsFile);
      exportCommentsByIssueId.set(issue.id, comments);

      for (const comment of comments) {
        allExportComments.push({ issueId: issue.id, comment, issueUpdatedAt: issue.updatedAt ?? comment.updatedAt });
      }
    }
  }

  const exportCommentCount = allExportComments.length;

  if (exportCommentCount === 0) {
    return {
      entity: 'Comments',
      exportCount: 0,
      dbCount: 0,
      passed: true,
    };
  }

  const commentMappings = await prisma.legacyLinearMapping.findMany({
    where: {
      entityType: 'comment',
      oldId: { in: allExportComments.map(({ comment }) => comment.id) },
    },
  });

  const issueMappings = await prisma.legacyLinearMapping.findMany({
    where: {
      entityType: 'issue',
      oldId: { in: exportIssues.map((issue) => issue.id) },
    },
  });

  const userIds = allExportComments
    .map(({ comment }) => comment.user?.id)
    .filter((userId): userId is string => typeof userId === 'string');
  const userMappings = userIds.length === 0
    ? []
    : await prisma.legacyLinearMapping.findMany({
        where: {
          entityType: 'user',
          oldId: { in: userIds },
        },
      });

  const issueIdByOldId = new Map(issueMappings.map((mapping) => [mapping.oldId, mapping.newId]));
  const userIdByOldId = new Map(userMappings.map((mapping) => [mapping.oldId, mapping.newId]));
  const commentMappingByOldId = new Map(commentMappings.map((mapping) => [mapping.oldId, mapping]));
  const mappedNewIds = commentMappings.map((mapping) => mapping.newId);

  const dbComments = mappedNewIds.length === 0
    ? []
    : await prisma.comment.findMany({
        where: { id: { in: mappedNewIds } },
        select: {
          id: true,
          body: true,
          createdAt: true,
          updatedAt: true,
          issueId: true,
          userId: true,
        },
      });
  const dbCommentById = new Map(dbComments.map((comment) => [comment.id, comment]));

  const stats: CommentVerificationStats = {
    exportCount: exportCommentCount,
    mappedCount: commentMappings.length,
    dbCount: 0,
  };

  let missingMappings = 0;
  let missingDatabaseRows = 0;
  let contentMismatches = 0;
  let timestampMismatches = 0;
  let issueLinkMismatches = 0;
  let authorMismatches = 0;

  for (const { issueId, comment, issueUpdatedAt } of allExportComments) {
    const mapping = commentMappingByOldId.get(comment.id);

    if (!mapping) {
      missingMappings += 1;
      continue;
    }

    const dbComment = dbCommentById.get(mapping.newId);

    if (!dbComment) {
      missingDatabaseRows += 1;
      continue;
    }

    const expectedIssueId = issueIdByOldId.get(issueId);
    const expectedUserId = comment.user ? userIdByOldId.get(comment.user.id) : undefined;
    let matches = true;

    if (dbComment.body !== comment.body) {
      contentMismatches += 1;
      matches = false;
    }

    const createdAtMatches = isWithinOneSecond(dbComment.createdAt, comment.createdAt);
    const updatedAtMatches = commentUpdatedAtMatchesAllowedImportSemantics({
      actualUpdatedAt: dbComment.updatedAt,
      exportedUpdatedAt: comment.updatedAt,
      exportedCreatedAt: comment.createdAt,
      issueUpdatedAt,
    });

    if (!createdAtMatches || !updatedAtMatches) {
      timestampMismatches += 1;
      matches = false;
    }

    if (!expectedIssueId || dbComment.issueId !== expectedIssueId) {
      issueLinkMismatches += 1;
      matches = false;
    }

    if (comment.user) {
      if (!expectedUserId || dbComment.userId !== expectedUserId) {
        authorMismatches += 1;
        matches = false;
      }
    }

    if (matches) {
      stats.dbCount += 1;
    }
  }

  const passed =
    missingMappings === 0 &&
    missingDatabaseRows === 0 &&
    contentMismatches === 0 &&
    timestampMismatches === 0 &&
    issueLinkMismatches === 0 &&
    authorMismatches === 0;

  if (passed) {
    return {
      entity: 'Comments',
      exportCount: stats.exportCount,
      dbCount: stats.dbCount,
      passed: true,
    };
  }

  const details: string[] = [];

  if (missingMappings > 0) {
    details.push(`${String(missingMappings)} export comments have no import mapping`);
  }

  if (missingDatabaseRows > 0) {
    details.push(`${String(missingDatabaseRows)} mapped comments missing from database`);
  }

  if (contentMismatches > 0) {
    details.push(`${String(contentMismatches)} mapped comments have mismatched body content`);
  }

  if (timestampMismatches > 0) {
    details.push(`${String(timestampMismatches)} mapped comments have mismatched timestamps`);
  }

  if (issueLinkMismatches > 0) {
    details.push(`${String(issueLinkMismatches)} mapped comments reference the wrong imported issue`);
  }

  if (authorMismatches > 0) {
    details.push(`${String(authorMismatches)} mapped comments reference the wrong imported author`);
  }

  return {
    entity: 'Comments',
    exportCount: stats.exportCount,
    dbCount: stats.dbCount,
    passed: false,
    details: details.join('; '),
  };
}

async function verifyIssues(
  prisma: InstanceType<(typeof import('@prisma/client'))['PrismaClient']>,
  exportIssues: ExportedIssueForVerify[],
): Promise<EntityVerification> {
  if (exportIssues.length === 0) {
    return {
      entity: 'Issues',
      exportCount: 0,
      dbCount: 0,
      passed: true,
    };
  }

  const issueMappings = await prisma.legacyLinearMapping.findMany({
    where: {
      entityType: 'issue',
      oldId: { in: exportIssues.map((issue) => issue.id) },
    },
  });

  const issueMappingByOldId = new Map(issueMappings.map((mapping) => [mapping.oldId, mapping]));
  const mappedIssueIds = issueMappings.map((mapping) => mapping.newId);
  const dbIssues = mappedIssueIds.length === 0
    ? []
    : await prisma.issue.findMany({
        where: { id: { in: mappedIssueIds } },
        select: { id: true, identifier: true, parentId: true },
      });
  const dbIssueById = new Map(dbIssues.map((issue) => [issue.id, issue]));
  const expectedIssueIdByOldId = new Map(issueMappings.map((mapping) => [mapping.oldId, mapping.newId]));

  let missingMappings = 0;
  let missingDatabaseRows = 0;
  let identifierMismatches = 0;
  let relationshipMismatches = 0;
  let validCount = 0;

  for (const exportIssue of exportIssues) {
    const mapping = issueMappingByOldId.get(exportIssue.id);

    if (!mapping) {
      missingMappings += 1;
      continue;
    }

    const dbIssue = dbIssueById.get(mapping.newId);

    if (!dbIssue) {
      missingDatabaseRows += 1;
      continue;
    }

    let matches = true;

    if (dbIssue.identifier !== exportIssue.identifier) {
      identifierMismatches += 1;
      matches = false;
    }

    const expectedParentId = exportIssue.parent ? expectedIssueIdByOldId.get(exportIssue.parent.id) : null;

    if ((expectedParentId ?? null) !== (dbIssue.parentId ?? null)) {
      relationshipMismatches += 1;
      matches = false;
    }

    if (matches) {
      validCount += 1;
    }
  }

  const passed =
    missingMappings === 0 &&
    missingDatabaseRows === 0 &&
    identifierMismatches === 0 &&
    relationshipMismatches === 0;

  if (passed) {
    return {
      entity: 'Issues',
      exportCount: exportIssues.length,
      dbCount: validCount,
      passed: true,
    };
  }

  const details: string[] = [];

  if (missingMappings > 0) {
    details.push(`${String(missingMappings)} export issues have no import mapping`);
  }

  if (missingDatabaseRows > 0) {
    details.push(`${String(missingDatabaseRows)} mapped issues missing from database`);
  }

  if (identifierMismatches > 0) {
    details.push(`${String(identifierMismatches)} mapped issues have mismatched identifiers`);
  }

  if (relationshipMismatches > 0) {
    details.push(`${String(relationshipMismatches)} mapped issues have mismatched parent relationships`);
  }

  return {
    entity: 'Issues',
    exportCount: exportIssues.length,
    dbCount: validCount,
    passed: false,
    details: details.join('; '),
  };
}

async function verifyMappedEntities(params: {
  prisma: InstanceType<(typeof import('@prisma/client'))['PrismaClient']>;
  entityLabel: string;
  entityType: 'team' | 'workflow_state' | 'label' | 'user';
  exportIds: string[];
  countExistingRows: (mappedNewIds: string[]) => Promise<number>;
}): Promise<EntityVerification> {
  const { prisma, entityLabel, entityType, exportIds, countExistingRows } = params;

  if (exportIds.length === 0) {
    return {
      entity: entityLabel,
      exportCount: 0,
      dbCount: 0,
      passed: true,
    };
  }

  const mappings = await prisma.legacyLinearMapping.findMany({
    where: {
      entityType,
      oldId: { in: exportIds },
    },
  });

  const mappedNewIds = mappings.map((mapping) => mapping.newId);
  const dbCount = mappedNewIds.length === 0 ? 0 : await countExistingRows(mappedNewIds);
  const stats: ScopedEntityVerificationStats = {
    exportCount: exportIds.length,
    mappedCount: mappings.length,
    dbCount,
  };

  const missingMappings = stats.exportCount - stats.mappedCount;
  const missingDatabaseRows = stats.mappedCount - stats.dbCount;
  const passed = missingMappings === 0 && missingDatabaseRows === 0;

  if (passed) {
    return {
      entity: entityLabel,
      exportCount: stats.exportCount,
      dbCount: stats.dbCount,
      passed: true,
    };
  }

  const details: string[] = [];

  if (missingMappings > 0) {
    details.push(`${String(missingMappings)} export ${entityLabel.toLowerCase()} have no import mapping`);
  }

  if (missingDatabaseRows > 0) {
    details.push(`${String(missingDatabaseRows)} export ${entityLabel.toLowerCase()} missing mapped database rows`);
  }

  return {
    entity: entityLabel,
    exportCount: stats.exportCount,
    dbCount: stats.dbCount,
    passed: false,
    details: details.join('; '),
  };
}

async function verifyWorkflowStates(
  prisma: InstanceType<(typeof import('@prisma/client'))['PrismaClient']>,
  exportStates: Array<{ id: string; team: { id: string } }>,
): Promise<EntityVerification> {
  if (exportStates.length === 0) {
    return {
      entity: 'Workflow States',
      exportCount: 0,
      dbCount: 0,
      passed: true,
    };
  }

  const [stateMappings, teamMappings] = await Promise.all([
    prisma.legacyLinearMapping.findMany({
      where: {
        entityType: 'workflow_state',
        oldId: { in: exportStates.map((state) => state.id) },
      },
    }),
    prisma.legacyLinearMapping.findMany({
      where: {
        entityType: 'team',
        oldId: { in: exportStates.map((state) => state.team.id) },
      },
    }),
  ]);

  const teamIdByOldId = new Map(teamMappings.map((mapping) => [mapping.oldId, mapping.newId]));
  const stateMappingByOldId = new Map(stateMappings.map((mapping) => [mapping.oldId, mapping.newId]));
  const mappedStateIds = stateMappings.map((mapping) => mapping.newId);

  const dbStates = mappedStateIds.length === 0
    ? []
    : await prisma.workflowState.findMany({
        where: { id: { in: mappedStateIds } },
        select: { id: true, teamId: true },
      });

  const dbStateById = new Map(dbStates.map((state) => [state.id, state]));
  let missingMappings = 0;
  let missingDatabaseRows = 0;
  let wrongTeamCount = 0;
  let validCount = 0;

  for (const exportState of exportStates) {
    const mappedStateId = stateMappingByOldId.get(exportState.id);

    if (!mappedStateId) {
      missingMappings += 1;
      continue;
    }

    const dbState = dbStateById.get(mappedStateId);

    if (!dbState) {
      missingDatabaseRows += 1;
      continue;
    }

    const mappedTeamId = teamIdByOldId.get(exportState.team.id);

    if (!mappedTeamId || dbState.teamId !== mappedTeamId) {
      wrongTeamCount += 1;
      continue;
    }

    validCount += 1;
  }

  const passed = missingMappings === 0 && missingDatabaseRows === 0 && wrongTeamCount === 0;

  if (passed) {
    return {
      entity: 'Workflow States',
      exportCount: exportStates.length,
      dbCount: validCount,
      passed: true,
    };
  }

  const details: string[] = [];

  if (missingMappings > 0) {
    details.push(`${String(missingMappings)} export workflow states have no import mapping`);
  }

  if (missingDatabaseRows > 0) {
    details.push(`${String(missingDatabaseRows)} export workflow states missing mapped database rows`);
  }

  if (wrongTeamCount > 0) {
    details.push(`${String(wrongTeamCount)} export workflow states mapped to the wrong team`);
  }

  return {
    entity: 'Workflow States',
    exportCount: exportStates.length,
    dbCount: validCount,
    passed: false,
    details: details.join('; '),
  };
}

/**
 * Run the verification pipeline — extracted for testability.
 */
export async function runVerify(options: VerifyOptions): Promise<VerificationResult> {
  const exportDir = resolve(options.file);

  // Validate export directory exists
  const dirExists = await fileExists(exportDir);

  if (!dirExists) {
    throw new Error(`Export directory not found: ${exportDir}`);
  }

  // Load environment for database connection
  loadEnv();
  ensureDatabaseUrl();

  // Dynamic import to avoid loading Prisma at module-level
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();

    const entities: EntityVerification[] = [];

    // --- Verify teams ---
    const teamsFile = join(exportDir, 'teams.json');

    if (await fileExists(teamsFile)) {
      const exportTeams = await readJsonFile<Array<{ id: string; key: string; name: string }>>(teamsFile);
      entities.push(
        await verifyMappedEntities({
          prisma,
          entityLabel: 'Teams',
          entityType: 'team',
          exportIds: exportTeams.map((team) => team.id),
          countExistingRows: async (mappedNewIds) =>
            prisma.team.count({
              where: { id: { in: mappedNewIds } },
            }),
        }),
      );
    }

    // --- Verify workflow states ---
    const statesFile = join(exportDir, 'workflow_states.json');

    if (await fileExists(statesFile)) {
      const exportStates = await readJsonFile<Array<{ id: string; name: string; team: { id: string } }>>(statesFile);
      entities.push(await verifyWorkflowStates(prisma, exportStates));
    }

    // --- Verify labels ---
    const labelsFile = join(exportDir, 'labels.json');

    if (await fileExists(labelsFile)) {
      const exportLabels = await readJsonFile<Array<{ id: string; name: string }>>(labelsFile);
      entities.push(
        await verifyMappedEntities({
          prisma,
          entityLabel: 'Labels',
          entityType: 'label',
          exportIds: exportLabels.map((label) => label.id),
          countExistingRows: async (mappedNewIds) =>
            prisma.issueLabel.count({
              where: { id: { in: mappedNewIds } },
            }),
        }),
      );
    }

    // --- Verify users ---
    const usersFile = join(exportDir, 'users.json');

    if (await fileExists(usersFile)) {
      const exportUsers = await readJsonFile<Array<{ id: string; email: string; name: string }>>(usersFile);
      entities.push(
        await verifyMappedEntities({
          prisma,
          entityLabel: 'Users',
          entityType: 'user',
          exportIds: exportUsers.map((user) => user.id),
          countExistingRows: async (mappedNewIds) =>
            prisma.user.count({
              where: { id: { in: mappedNewIds } },
            }),
        }),
      );
    }

    // --- Verify issues ---
    const issuesFile = join(exportDir, 'issues.json');

    if (await fileExists(issuesFile)) {
      const exportIssues = await readJsonFile<ExportedIssueForVerify[]>(issuesFile);
      entities.push(await verifyIssues(prisma, exportIssues));
    }

    entities.push(await verifyComments(prisma, exportDir));

    const allPassed = entities.every((e) => e.passed);

    return { entities, allPassed };
  } catch (error) {
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      throw new Error(
        'Could not connect to the database. Ensure PostgreSQL is running and DATABASE_URL is correct.',
      );
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Register the `verify` subcommand on the import command.
 */
export function registerVerifyCommand(importCmd: Command): void {
  importCmd
    .command('verify')
    .description('Verify imported data against the export source directory')
    .requiredOption('--file <export-dir>', 'Path to the export directory')
    .action(async (opts: VerifyOptions) => {
      try {
        const log = (msg: string): void => {
          process.stdout.write(msg + '\n');
        };

        const result = await runVerify(opts);

        log('');
        log('Verification Results:');
        log('─'.repeat(60));

        for (const entity of result.entities) {
          const status = entity.passed ? '✓ PASS' : '✗ FAIL';
          const countInfo = `(export: ${String(entity.exportCount)}, db: ${String(entity.dbCount)})`;
          log(`  ${status}  ${entity.entity} ${countInfo}`);

          if (entity.details) {
            log(`         ${entity.details}`);
          }
        }

        log('─'.repeat(60));

        if (result.allPassed) {
          log('All checks passed! Import data matches export source.');
        } else {
          log('Some checks failed. Review discrepancies above.');
          process.exitCode = 1;
        }

        log('');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
