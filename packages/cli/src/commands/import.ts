/**
 * CLI import command — imports exported Linear data into Involute database.
 *
 * Usage:
 *   involute import --file <export-dir>           — Run the import pipeline
 *   involute import verify --file <export-dir>     — Verify imported data against export
 */

import type { Command } from 'commander';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { registerVerifyCommand } from './verify.js';
import { ensureDatabaseUrl, loadEnv } from './shared.js';

export interface ImportOptions {
  file: string;
}

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

  // Validate export directory
  await validateExportDir(exportDir);

  // Load environment for database connection
  loadEnv();
  ensureDatabaseUrl();

  log(`Importing data from ${exportDir}...`);
  log('');

  // Dynamic import to avoid loading Prisma at module-level
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

  // Register verify subcommand
  registerVerifyCommand(importCmd);
}
