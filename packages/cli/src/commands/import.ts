/**
 * CLI import command — imports exported Linear data into Involute database.
 *
 * Usage:
 *   involute import --file <export-dir>            — Run the import pipeline
 *   involute import verify --file <export-dir>     — Verify imported data against export
 *   involute import team --token ... --team ...    — Export, import, and verify one Linear team
 */

import type { Command } from 'commander';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runExport } from './export.js';
import { registerVerifyCommand } from './verify.js';
import { runVerify, type VerificationResult } from './verify.js';
import { ensureDatabaseUrl, loadEnv } from './shared.js';

export interface ImportOptions {
  file: string;
}

export interface TeamImportOptions {
  keepExport?: boolean;
  output?: string;
  team: string;
  token: string;
}

export interface TeamImportSummary {
  exportDir: string;
  exportRetained: boolean;
  generatedAt: string;
  team: string;
  verification: VerificationResult;
}

export interface TeamImportResult extends TeamImportSummary {
  summaryPath: string;
}

export const teamImportDependencies = {
  mkdtemp,
  rm,
  runExport,
  runImport,
  runVerify,
  writeFile,
};

/**
 * Validate that the export directory exists and contains required files.
 */
export async function validateExportDir(exportDir: string): Promise<void> {
  try {
    await access(exportDir);
  } catch {
    throw new Error(`Export directory not found: ${exportDir}`);
  }

  const requiredFiles = [
    'teams.json',
    'workflow_states.json',
    'labels.json',
    'users.json',
    'issues.json',
  ];

  for (const file of requiredFiles) {
    try {
      await access(join(exportDir, file));
    } catch {
      throw new Error(`Missing required file in export directory: ${file}`);
    }
  }
}

/**
 * Run the import pipeline — extracted for testability.
 */
export async function runImport(options: ImportOptions): Promise<void> {
  const exportDir = resolve(options.file);

  const log = (msg: string): void => {
    process.stdout.write(msg + '\n');
  };

  await validateExportDir(exportDir);
  loadEnv();
  ensureDatabaseUrl();

  log(`Importing data from ${exportDir}...`);
  log('');

  const { PrismaClient } = await import('@prisma/client');
  const { runImportPipeline } = await import('@involute/server/import-pipeline');

  const prisma = new PrismaClient();

  try {
    await prisma.$connect();

    const result = await runImportPipeline(prisma, exportDir, log);

    log('');
    log('Import Summary:');
    log(`  Teams:              ${String(result.counts.teams)} (${String(result.skipped.teams)} skipped)`);
    log(`  Workflow states:    ${String(result.counts.workflowStates)} (${String(result.skipped.workflowStates)} skipped)`);
    log(`  Labels:             ${String(result.counts.labels)} (${String(result.skipped.labels)} skipped)`);
    log(`  Users:              ${String(result.counts.users)} (${String(result.skipped.users)} skipped)`);
    log(`  Issues:             ${String(result.counts.issues)} (${String(result.skipped.issues)} skipped)`);
    log(`  Comments:           ${String(result.counts.comments)} (${String(result.skipped.comments)} skipped)`);
    log(`  Parent-child links: ${String(result.counts.parentChildBackfills)}`);
    log('');
    log('Import complete!');
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

function formatVerificationResult(result: VerificationResult): string[] {
  const lines = ['Verification Results:', '─'.repeat(60)];

  for (const entity of result.entities) {
    const status = entity.passed ? 'PASS' : 'FAIL';
    const countInfo = `(export: ${String(entity.exportCount)}, db: ${String(entity.dbCount)})`;
    lines.push(`  ${status}  ${entity.entity} ${countInfo}`);

    if (entity.details) {
      lines.push(`        ${entity.details}`);
    }
  }

  lines.push('─'.repeat(60));
  lines.push(
    result.allPassed
      ? 'All checks passed! Import data matches export source.'
      : 'Some checks failed. Review discrepancies above.',
  );

  return lines;
}

export async function runTeamImport(options: TeamImportOptions): Promise<TeamImportResult> {
  const usingProvidedOutput = Boolean(options.output);
  const exportDir = options.output
    ? resolve(options.output)
    : await teamImportDependencies.mkdtemp(
        join(tmpdir(), `involute-team-import-${options.team.toLowerCase()}-`),
      );
  let shouldRetainExport = usingProvidedOutput || Boolean(options.keepExport);

  const log = (message: string): void => {
    process.stdout.write(message + '\n');
  };

  try {
    log(`Starting Linear team import for "${options.team}"...`);
    log(`Working export directory: ${exportDir}`);
    log('');

    log('Step 1/3: Exporting Linear team data');
    await teamImportDependencies.runExport({
      token: options.token,
      team: options.team,
      output: exportDir,
    });
    log('');

    log('Step 2/3: Importing exported data into Involute');
    await teamImportDependencies.runImport({ file: exportDir });
    log('');

    log('Step 3/3: Verifying imported data');
    const verification = await teamImportDependencies.runVerify({ file: exportDir });

    for (const line of formatVerificationResult(verification)) {
      log(line);
    }

    if (!verification.allPassed) {
      shouldRetainExport = true;
      throw new Error(`Team import verification failed for "${options.team}". Export preserved at ${exportDir}.`);
    }

    const summary: TeamImportSummary = {
      exportDir,
      exportRetained: shouldRetainExport,
      generatedAt: new Date().toISOString(),
      team: options.team,
      verification,
    };
    const summaryPath = join(exportDir, 'involute-import-summary.json');

    await teamImportDependencies.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    if (!shouldRetainExport) {
      await teamImportDependencies.rm(exportDir, { recursive: true, force: true });
    }

    log('');
    log(`Team import complete for "${options.team}".`);
    log(
      shouldRetainExport
        ? `Export retained at ${exportDir}.`
        : 'Temporary export artifacts were removed after successful verification.',
    );

    return {
      ...summary,
      exportRetained: shouldRetainExport,
      summaryPath,
    };
  } catch (error) {
    log('');
    log(`Team import aborted. Export preserved at ${exportDir}.`);
    throw error;
  }
}

/**
 * Register the `import` command (with `verify` subcommand) on the Commander program.
 */
export function registerImportCommand(program: Command): void {
  const importCmd = program
    .command('import')
    .description('Import exported Linear data into Involute database')
    .enablePositionalOptions()
    .passThroughOptions()
    .option('--file <export-dir>', 'Path to the export directory')
    .action(async (opts: { file?: string | undefined }) => {
      if (!opts.file) {
        process.stderr.write("Error: required option '--file <export-dir>' not specified\n");
        process.exitCode = 1;
        return;
      }

      try {
        await runImport({ file: opts.file });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });

  importCmd
    .command('team')
    .description('Export, import, and verify a single Linear team end-to-end')
    .requiredOption('--token <linear-token>', 'Linear API token')
    .requiredOption('--team <key>', 'Team key to import (for example SON)')
    .option('--output <export-dir>', 'Retain the exported artifacts at this path')
    .option('--keep-export', 'Retain the export directory after a successful import')
    .action(async (opts: TeamImportOptions) => {
      try {
        await runTeamImport(opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });

  registerVerifyCommand(importCmd);
}
