import type { Prisma, PrismaClient } from '@prisma/client';

import { embeddingText, type SemanticIndex } from './semantic-index.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Item-to-item similarity at or above which a new proposal is flagged as a
 * possible duplicate. Calibrated on production (INV-927): the median item's
 * nearest neighbour sits at 0.944; pairs from 0.96 up are the same topic or
 * plain duplicates (INV-351 / INV-338, both "PyBacktest 回测引擎").
 */
export const DUPLICATE_SIMILARITY = 0.96;
/**
 * A typed bug title against an existing bug's text: a bug's own title scores
 * 0.90–0.96 against its text, the best other bug 0.88–0.91 (INV-927).
 */
export const SIMILAR_BUG_SIMILARITY = 0.92;
/** How long an optional similarity lookup may take before the caller goes on without it. */
export const SIMILARITY_DEADLINE_MS = 2000;

/** The lookup's answer, or `fallback` once `ms` pass (a model still loading, a stuck worker). */
export async function withDeadline<T>(lookup: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([lookup, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface PossibleDuplicate {
  id: string;
  identifier: string;
  title: string;
  similarity: number;
}

/**
 * Readable items closest to a proposal's text, at or above the duplicate
 * threshold. Never fails the caller: a model error means no suggestions.
 */
export async function findPossibleDuplicates(
  prisma: DatabaseClient,
  index: SemanticIndex,
  item: { id: string; title: string; outcome: string | null; scope: string | null; acceptance: string | null; description: string | null },
  readableWhere: Prisma.IssueWhereInput | undefined,
  limit = 3,
): Promise<PossibleDuplicate[]> {
  try {
    const matches = (await withDeadline(index.similarTo(embeddingText(item), 20, new Set([item.id])), SIMILARITY_DEADLINE_MS, []))
      .filter((match) => match.similarity >= DUPLICATE_SIMILARITY);
    return await readableInOrder(prisma, matches, readableWhere, {}, limit);
  } catch (error) {
    console.error('[similar-work] duplicate check failed; proposing without it.', error);
    return [];
  }
}

/** Items among `where` whose text is closest in meaning to `text`, at or above `threshold`. */
export async function findSimilarByMeaning(
  prisma: DatabaseClient,
  index: SemanticIndex,
  text: string,
  where: Prisma.IssueWhereInput,
  threshold: number,
  limit: number,
): Promise<PossibleDuplicate[]> {
  try {
    const matches = (await withDeadline(index.similarTo(text, 50), SIMILARITY_DEADLINE_MS, []))
      .filter((match) => match.similarity >= threshold);
    return await readableInOrder(prisma, matches, undefined, where, limit);
  } catch (error) {
    console.error('[similar-work] similarity search failed; falling back to words.', error);
    return [];
  }
}

async function readableInOrder(
  prisma: DatabaseClient,
  matches: Array<{ id: string; similarity: number }>,
  readableWhere: Prisma.IssueWhereInput | undefined,
  where: Prisma.IssueWhereInput,
  limit: number,
): Promise<PossibleDuplicate[]> {
  if (matches.length === 0) return [];
  const rows = await prisma.issue.findMany({
    where: { AND: [{ id: { in: matches.map((match) => match.id) } }, where, ...(readableWhere ? [readableWhere] : [])] },
    select: { id: true, identifier: true, title: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return matches
    .filter((match) => byId.has(match.id))
    .slice(0, limit)
    .map((match) => ({ ...byId.get(match.id)!, similarity: Math.round(match.similarity * 1000) / 1000 }));
}
