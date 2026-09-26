import { Prisma, type PrismaClient } from '@prisma/client';

import { createValidationError } from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 50;

/**
 * Label ids for `names`, creating labels that do not exist yet. Matching is
 * case-insensitive, so "Research" and "research" are one label; a concurrent
 * first creation is resolved by re-reading the winner (INV-721).
 */
export async function findOrCreateLabelIds(prisma: DatabaseClient, names: string[]): Promise<string[]> {
  const unique = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (name.length > MAX_LABEL_LENGTH) throw createValidationError(`Label names are at most ${MAX_LABEL_LENGTH} characters.`);
    unique.set(name.toLowerCase(), name);
  }
  if (unique.size > MAX_LABELS) throw createValidationError(`At most ${MAX_LABELS} labels per item.`);
  const ids: string[] = [];
  for (const name of unique.values()) {
    const existing = await prisma.issueLabel.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    try {
      ids.push((await prisma.issueLabel.create({ data: { name }, select: { id: true } })).id);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const winner = await prisma.issueLabel.findFirstOrThrow({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
      ids.push(winner.id);
    }
  }
  return ids;
}
