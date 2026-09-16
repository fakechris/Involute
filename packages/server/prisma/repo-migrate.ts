import { PrismaClient } from '@prisma/client';

import { migrateRepository } from '../src/repo-migration-service.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

const hasFlag = (args: string[], name: string) => args.includes(`--${name}`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromRepo = readFlag(args, 'from');
  const toRepo = readFlag(args, 'to');
  const teamKey = readFlag(args, 'team');
  const dryRun = hasFlag(args, 'dry-run');

  if (!fromRepo || !toRepo) {
    console.error(`
[Involute Repo Migrate] Error: Missing required --from or --to argument.

Usage:
  pnpm repo:migrate --from <old-owner/repo> --to <new-owner/repo> [--team <teamKey>] [--dry-run]

Example:
  pnpm repo:migrate --from songchuansheng/hyperknow --to fakechris/lumen-learn
`);
    process.exit(1);
  }

  console.log(
    `[Involute Repo Migrate] ${dryRun ? '[DRY RUN] ' : ''}Migrating repository: "${fromRepo}" -> "${toRepo}"...`,
  );

  try {
    const result = await migrateRepository(prisma, {
      dryRun,
      fromRepo,
      teamKey,
      toRepo,
    });

    if (result.dryRun) {
      console.log(`\n[DRY RUN SUMMARY]`);
      console.log(
        `  Found ${result.migratedIssuesCount} issue(s) and ${result.migratedRunsCount} work run(s) with repository "${fromRepo}".`,
      );
      if (result.affectedIssueIdentifiers.length > 0) {
        console.log(`  Affected issues: ${result.affectedIssueIdentifiers.join(', ')}`);
      }
      console.log(`  Run without --dry-run to apply changes.`);
    } else {
      console.log(
        `\n✓ Successfully migrated ${result.migratedIssuesCount} issue(s) and ${result.migratedRunsCount} work run(s) from "${fromRepo}" to "${toRepo}".`,
      );
      if (result.affectedIssueIdentifiers.length > 0) {
        console.log(`  Affected issues: ${result.affectedIssueIdentifiers.join(', ')}`);
      }
      console.log(`✓ Graph hierarchy integrity verified for all migrated items.`);
    }
  } catch (error) {
    console.error(`\n[Involute Repo Migrate] Error:`, (error as Error).message || error);
    process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
