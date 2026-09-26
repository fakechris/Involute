import type { Prisma, PrismaClient } from '@prisma/client';

import { createValidationError, ISSUE_TYPE_EXCLUSIVE_MESSAGE } from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 50;

/**
 * Label ids for `names`, creating labels that do not exist yet. Matching is
 * case-insensitive, so "Research" and "research" are one label; a concurrent
 * first creation is resolved by reading back the winner (INV-721).
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
    // ON CONFLICT DO NOTHING: losing a concurrent first creation must not
    // abort the caller's transaction (a failed INSERT would, on PostgreSQL).
    await prisma.issueLabel.createMany({ data: [{ name }], skipDuplicates: true });
    const label = await prisma.issueLabel.findFirstOrThrow({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    ids.push(label.id);
  }
  return ids;
}

/**
 * The Type label group (Bug route v1, INV-748/749): Bug, Feature and
 * Improvement are ordinary labels, matched case-insensitively (so the
 * existing "bug" label is Type: Bug), and an item carries at most one.
 */
export const TYPE_LABEL_NAMES = ['Bug', 'Feature', 'Improvement'] as const;
const TYPE_KEYS: ReadonlySet<string> = new Set(TYPE_LABEL_NAMES.map((name) => name.toLowerCase()));

export function isTypeLabel(name: string): boolean {
  return TYPE_KEYS.has(name.trim().toLowerCase());
}

export function assertSingleType(labels: Array<{ name: string }>): void {
  // Counted per label record: "Bug" and "bug" as two labels are two Types too.
  if (labels.filter((label) => isTypeLabel(label.name)).length > 1) throw createValidationError(ISSUE_TYPE_EXCLUSIVE_MESSAGE);
}
