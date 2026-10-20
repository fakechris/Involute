/**
 * The legacy identity columns (INV-1288).
 *
 * Before the identity table, a sign-in line had a column of its own on the
 * user row. `googleSubject` is the one that survived. It is still written,
 * because code outside the provider layer still reads it — but the identity
 * table is the source of truth, and a migration copies every legacy row into
 * it.
 *
 * This file is the only place that names a legacy column. Everything else
 * works with the identity table and does not care which line a person came
 * through.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

type LegacyIdentityColumn = 'googleSubject';

/** The column each sign-in line kept before the identity table. */
const LEGACY_IDENTITY_COLUMNS: Readonly<Record<string, LegacyIdentityColumn>> = {
  google: 'googleSubject',
};

/**
 * Write the legacy column for a sign-in line that has one.
 *
 * A line with no legacy column (DingTalk, and anything after it) writes
 * nothing: its identity lives in the identity table alone.
 */
export async function linkLegacyIdentity(
  prisma: PrismaClient,
  providerId: string,
  userId: string,
  subject: string,
): Promise<void> {
  const column = LEGACY_IDENTITY_COLUMNS[providerId];
  if (!column) {
    return;
  }

  await prisma.user.update({ where: { id: userId }, data: { [column]: subject } });
}

/**
 * Whether a row carries an identity in one of the legacy columns.
 *
 * Only for rows written before the identity table existed; a migration
 * copies them across. The identity table is the source of truth.
 */
export async function hasLegacyIdentity(
  prisma: DatabaseClient,
  userId: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { googleSubject: true },
  });

  return Boolean(user?.googleSubject);
}
