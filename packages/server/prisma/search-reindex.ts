import { PrismaClient } from '@prisma/client';

import { backfillAttachmentText } from '../src/attachment-text.ts';
import { reindexSearchVectors } from '../src/search-reindex.ts';
import { getUploadsDirectory } from '../src/uploads.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

try {
  // Text attachments uploaded before INV-1117 have no text yet: read them from disk first.
  const uploadsDir = getUploadsDirectory();
  const files = await backfillAttachmentText(prisma, uploadsDir);
  console.log(`Read text attachments from ${uploadsDir}: ${files.indexed} indexed, ${files.skipped} skipped.`);
  const counts = await reindexSearchVectors(prisma);
  console.log(`Reindexed search vectors: ${counts.issues} issues, ${counts.comments} comments, ${counts.runs} runs, ${counts.attachments} attachments.`);
} finally {
  await prisma.$disconnect();
}
