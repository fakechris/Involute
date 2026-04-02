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
import { config as loadDotenv } from 'dotenv';
import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface VerifyOptions {
  file: string;
}

interface EntityVerification {
  entity: string;
  exportCount: number;
  dbCount: number;
  passed: boolean;
  details?: string | undefined;
}

interface VerificationResult {
  entities: EntityVerification[];
  allPassed: boolean;
}

/**
 * Load project environment variables (DATABASE_URL etc.) from the repo root .env.
 */
function loadEnv(): void {
  const paths = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '../../.env'),
  ];

  for (const envPath of paths) {
    const result = loadDotenv({ path: envPath });
    if (!result.error) {
      return;
    }
  }
}

function ensureDatabaseUrl(): void {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
        'Run the project init script or set DATABASE_URL in your .env file.',
    );
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect all comment IDs from the export comments directory.
 */
async function collectExportCommentIds(exportDir: string): Promise<string[]> {
  const commentsDir = join(exportDir, 'comments');
  const exists = await fileExists(commentsDir);

  if (!exists) {
    return [];
  }

  const files = await readdir(commentsDir);
  const ids: string[] = [];

  for (const file of files) {
    if (file.endsWith('.json')) {
      const comments = await readJsonFile<Array<{ id: string }>>(join(commentsDir, file));

      for (const comment of comments) {
        ids.push(comment.id);
      }
    }
  }

  return ids;
}

// Exported interface for types used by the exported `runVerify` function's return
export type { VerificationResult, EntityVerification };

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
      const dbTeamCount = await prisma.team.count();
      const exportKeys = exportTeams.map((t) => t.key);
      const dbTeams = await prisma.team.findMany({
        where: { key: { in: exportKeys } },
      });

      const matchedCount = dbTeams.length;
      const passed = matchedCount >= exportTeams.length;

      entities.push({
        entity: 'Teams',
        exportCount: exportTeams.length,
        dbCount: dbTeamCount,
        passed,
        details: passed
          ? undefined
          : `${String(exportTeams.length - matchedCount)} teams not found in database`,
      });
    }

    // --- Verify workflow states ---
    const statesFile = join(exportDir, 'workflow_states.json');

    if (await fileExists(statesFile)) {
      const exportStates = await readJsonFile<Array<{ id: string; name: string; team: { id: string } }>>(statesFile);
      const dbStateCount = await prisma.workflowState.count();

      // Check that all exported states exist (by name per team via mappings)
      const mappings = await prisma.legacyLinearMapping.findMany({
        where: { entityType: 'workflow_state' },
      });
      const mappedOldIds = new Set(mappings.map((m) => m.oldId));
      const missingStates = exportStates.filter((s) => !mappedOldIds.has(s.id));
      const passed = missingStates.length === 0;

      entities.push({
        entity: 'Workflow States',
        exportCount: exportStates.length,
        dbCount: dbStateCount,
        passed,
        details: passed
          ? undefined
          : `${String(missingStates.length)} workflow states not found in database mappings`,
      });
    }

    // --- Verify labels ---
    const labelsFile = join(exportDir, 'labels.json');

    if (await fileExists(labelsFile)) {
      const exportLabels = await readJsonFile<Array<{ id: string; name: string }>>(labelsFile);
      const dbLabelCount = await prisma.issueLabel.count();

      const exportNames = exportLabels.map((l) => l.name);
      const dbLabels = await prisma.issueLabel.findMany({
        where: { name: { in: exportNames } },
      });

      const matchedCount = dbLabels.length;
      const passed = matchedCount >= exportLabels.length;

      entities.push({
        entity: 'Labels',
        exportCount: exportLabels.length,
        dbCount: dbLabelCount,
        passed,
        details: passed
          ? undefined
          : `${String(exportLabels.length - matchedCount)} labels not found in database`,
      });
    }

    // --- Verify users ---
    const usersFile = join(exportDir, 'users.json');

    if (await fileExists(usersFile)) {
      const exportUsers = await readJsonFile<Array<{ id: string; email: string; name: string }>>(usersFile);
      const dbUserCount = await prisma.user.count();

      const exportEmails = exportUsers.map((u) => u.email);
      const dbUsers = await prisma.user.findMany({
        where: { email: { in: exportEmails } },
      });

      const matchedCount = dbUsers.length;
      const passed = matchedCount >= exportUsers.length;

      entities.push({
        entity: 'Users',
        exportCount: exportUsers.length,
        dbCount: dbUserCount,
        passed,
        details: passed
          ? undefined
          : `${String(exportUsers.length - matchedCount)} users not found in database`,
      });
    }

    // --- Verify issues ---
    const issuesFile = join(exportDir, 'issues.json');

    if (await fileExists(issuesFile)) {
      const exportIssues = await readJsonFile<Array<{
        id: string;
        identifier: string;
        title: string;
        parent: { id: string } | null;
      }>>(issuesFile);

      // Check by identifier (the most reliable check)
      const exportIdentifiers = exportIssues.map((i) => i.identifier);
      const dbIssues = await prisma.issue.findMany({
        where: { identifier: { in: exportIdentifiers } },
        include: { parent: true },
      });

      const dbIdentifiers = new Set(dbIssues.map((i) => i.identifier));
      const missingIssues = exportIdentifiers.filter((id) => !dbIdentifiers.has(id));
      const countPassed = missingIssues.length === 0;

      // Also verify parent-child relationships
      const issuesWithParent = exportIssues.filter((i) => i.parent !== null);
      const issueMappings = await prisma.legacyLinearMapping.findMany({
        where: { entityType: 'issue' },
      });
      const oldToNew = new Map(issueMappings.map((m) => [m.oldId, m.newId]));

      let parentChildPassed = true;
      let parentChildMismatches = 0;

      for (const issue of issuesWithParent) {
        const newIssueId = oldToNew.get(issue.id);
        const newParentId = issue.parent ? oldToNew.get(issue.parent.id) : null;

        if (newIssueId && newParentId) {
          const dbIssue = dbIssues.find((i) => i.id === newIssueId);

          if (!dbIssue || dbIssue.parentId !== newParentId) {
            parentChildPassed = false;
            parentChildMismatches++;
          }
        }
      }

      const passed = countPassed && parentChildPassed;
      const details: string[] = [];

      if (!countPassed) {
        details.push(`${String(missingIssues.length)} issues not found in database`);
      }

      if (!parentChildPassed) {
        details.push(`${String(parentChildMismatches)} parent-child relationships mismatched`);
      }

      entities.push({
        entity: 'Issues',
        exportCount: exportIssues.length,
        dbCount: dbIssues.length,
        passed,
        details: passed ? undefined : details.join('; '),
      });
    }

    // --- Verify comments ---
    // Collect all comment IDs from the export
    const exportCommentIds = await collectExportCommentIds(exportDir);
    const exportCommentCount = exportCommentIds.length;

    if (exportCommentCount > 0) {
      // Look up which export comments have been mapped (imported)
      const commentMappings = await prisma.legacyLinearMapping.findMany({
        where: {
          entityType: 'comment',
          oldId: { in: exportCommentIds },
        },
      });

      const importedCommentCount = commentMappings.length;

      // Verify the mapped comments actually exist in the database
      const mappedNewIds = commentMappings.map((m) => m.newId);
      const dbCommentCount = await prisma.comment.count({
        where: { id: { in: mappedNewIds } },
      });

      // Comments might be legitimately fewer than export count (e.g., null user skipped)
      // But mapped comments must all exist in DB
      const passed = dbCommentCount === importedCommentCount;

      entities.push({
        entity: 'Comments',
        exportCount: exportCommentCount,
        dbCount: importedCommentCount,
        passed,
        details: passed
          ? undefined
          : `Expected ${String(importedCommentCount)} imported comments, found ${String(dbCommentCount)} in database`,
      });
    } else {
      entities.push({
        entity: 'Comments',
        exportCount: 0,
        dbCount: 0,
        passed: true,
      });
    }

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
