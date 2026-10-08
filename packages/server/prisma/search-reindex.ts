import { PrismaClient } from '@prisma/client';

import { reindexSearchVectors } from '../src/search-reindex.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

try {
  const counts = await reindexSearchVectors(prisma);
  console.log(`Reindexed search vectors: ${counts.issues} issues, ${counts.comments} comments, ${counts.runs} runs.`);
} finally {
  await prisma.$disconnect();
}
