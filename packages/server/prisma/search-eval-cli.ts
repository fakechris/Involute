import { PrismaClient } from '@prisma/client';

import { evaluateSearch, summarize } from './search-eval.ts';

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Set DATABASE_URL to a migrated local database ending in _test.');
}
const prisma = new PrismaClient();
try {
  const cases = await evaluateSearch(prisma);
  console.log(JSON.stringify({ summary: summarize(cases), cases }, null, 2));
} finally {
  await prisma.$disconnect();
}
