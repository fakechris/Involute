/**
 * One question, one place: **has this person ever signed in?**
 *
 * The answer is the identity table. The legacy `googleSubject` column is the
 * shape that question was asked in before the table existed; a migration
 * copies those rows into it, and this module reads the column only so a
 * database that has not run that migration still answers correctly.
 *
 * It lives here, in a leaf module, so that neither the workspace policy nor
 * any sign-in line has to know how identities are stored. The policy asks
 * "is this person linked?" and gets an answer; it does not learn that one
 * line happens to have a column of its own.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { hasLegacyIdentity } from './auth-providers/legacy.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Whether this person has a sign-in identity linked to them. */
export async function hasAnyIdentity(
  prisma: DatabaseClient,
  userId: string,
): Promise<boolean> {
  const identities = await prisma.userIdentity.count({ where: { userId } });
  if (identities > 0) {
    return true;
  }

  return hasLegacyIdentity(prisma, userId);
}
