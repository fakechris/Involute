import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Rebuilds every search vector from its text (INV-926). The database trigger
 * keeps vectors current on each write; this is for after the tokenizer
 * changes (see search-tokens.ts) or to repair. Safe to run any number of
 * times: the same text always yields the same vector.
 */
export async function reindexSearchVectors(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<{ issues: number; comments: number }> {
  const issues = await prisma.$executeRaw`
    UPDATE "Issue" SET "searchVector" = involute_issue_search_vector(
      title, outcome, scope, constraints, acceptance, verification, description
    )
  `;
  const comments = await prisma.$executeRaw`
    UPDATE "Comment" SET "searchVector" = involute_comment_search_vector(body)
  `;
  return { issues, comments };
}
