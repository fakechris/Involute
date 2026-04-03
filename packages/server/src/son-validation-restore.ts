import { PrismaClient } from '@prisma/client';

import { runImportPipeline } from './import-pipeline.js';
import { runValidationDataSetup } from './validation-data-setup.js';

export const DEFAULT_SON_EXPORT_DIR =
  '/Users/chris/workspace/Involute/.factory/validation/import/user-testing/tmp/import-export-flow/export';

export interface SonValidationRestoreSummary {
  importResult: Awaited<ReturnType<typeof runImportPipeline>>;
  setupSummary: Awaited<ReturnType<typeof runValidationDataSetup>>;
  sonIssueCount: number;
}

export async function restoreSonValidationDataset(
  prisma: PrismaClient,
  exportDir: string = DEFAULT_SON_EXPORT_DIR,
  onProgress?: (message: string) => void,
): Promise<SonValidationRestoreSummary> {
  onProgress?.(`Restoring SON validation dataset from ${exportDir}...`);

  const importResult = await runImportPipeline(prisma, exportDir, onProgress);
  const setupSummary = await runValidationDataSetup(prisma);
  const sonIssueCount = await prisma.issue.count({
    where: {
      team: {
        key: 'SON',
      },
    },
  });

  onProgress?.(`SON restore complete. ${String(sonIssueCount)} SON issues available.`);

  return {
    importResult,
    setupSummary,
    sonIssueCount,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await import('dotenv').then(({ config }) => {
    config({
      path: new URL('../../../.env', import.meta.url),
    });
  });

  const exportDir = process.argv[2] ?? DEFAULT_SON_EXPORT_DIR;
  const prisma = new PrismaClient();

  restoreSonValidationDataset(prisma, exportDir, console.log)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error: unknown) => {
      console.error('Failed to restore SON validation dataset.');
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
