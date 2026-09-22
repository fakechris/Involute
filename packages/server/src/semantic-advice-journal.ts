import type { Prisma, PrismaClient } from '@prisma/client';
import type { AdviceJournal } from './semantic-advice/types.js';

/** No work/evidence writes. Unique keys dedupe assignment and interaction across processes. */
export function createPrismaAdviceJournal(prisma: PrismaClient): AdviceJournal {
  return {
    async put(key, value) {
      await prisma.semanticAdviceRecord.createMany({
        data: [{ key, payload: value as Prisma.InputJsonValue }], skipDuplicates: true,
      });
      return (await prisma.semanticAdviceRecord.findUniqueOrThrow({ where: { key } })).payload;
    },
    async get(key) {
      return (await prisma.semanticAdviceRecord.findUnique({ where: { key } }))?.payload;
    },
  };
}
