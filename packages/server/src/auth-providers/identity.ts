/**
 * Linking a sign-in identity to a person (INV-1288).
 *
 * The identity table is the source of truth for "which provider says this is
 * the same person". The workspace still owns the person: an invite creates the
 * row first, and the first sign-in claims it.
 *
 * The division of labour is deliberate:
 *
 * - **this file** knows which sign-in line vouched and what to record about
 *   it (the identity table, plus the legacy column of a line that has one);
 * - **`workspace-access.ts`** knows the policy — invite-only, approved
 *   domains, the bootstrap allowlist, roles and memberships — and applies the
 *   same policy to every line.
 *
 * Neither file knows the other exists, so Google and DingTalk stay parallel
 * implementations of one contract rather than two halves of one.
 */

import type { PrismaClient, User } from '@prisma/client';

import { admitUser } from '../workspace-access.js';
import { linkLegacyIdentity } from './legacy.js';
import type { AuthProviderProfile, SignInProvider } from './types.js';

export const AUTH_ACCOUNT_CONFLICT_MESSAGE =
  'This sign-in account conflicts with an existing user record.';

export interface ProviderSignInResult {
  email: string;
  id: string;
  name: string;
}

/**
 * Find the person behind a provider profile, or refuse.
 *
 * The profile's subject is looked up at its provider; the email is looked up in
 * the workspace. When both point at different people, or when the email is
 * already claimed by a different subject at the same provider, the sign-in is
 * refused rather than silently merging two people.
 */
export async function upsertProviderUser(
  prisma: PrismaClient,
  profile: AuthProviderProfile,
  provider: SignInProvider,
  adminEmails: readonly string[],
): Promise<ProviderSignInResult> {
  const existingBySubject = await prisma.userIdentity.findUnique({
    where: { provider_subject: { provider: provider.id, subject: provider.subject } },
    include: { user: true },
  });
  const existingByEmail = await prisma.user.findUnique({ where: { email: profile.email } });

  if (existingBySubject && existingByEmail && existingBySubject.userId !== existingByEmail.id) {
    throw new Error(AUTH_ACCOUNT_CONFLICT_MESSAGE);
  }

  if (existingByEmail) {
    const claimed = await prisma.userIdentity.findFirst({
      where: { provider: provider.id, subject: { not: provider.subject }, userId: existingByEmail.id },
      select: { subject: true },
    });

    // The same address already signs in at this provider under another
    // identity: two accounts, one mailbox. Refuse instead of taking one over.
    if (claimed) {
      throw new Error(AUTH_ACCOUNT_CONFLICT_MESSAGE);
    }
  }

  const existing = existingBySubject?.user ?? existingByEmail;
  const user = await admitUser(prisma, profile, existing, adminEmails);

  // The identity is the provider's record of this person; the policy above has
  // already decided whether the person may be here.
  await prisma.userIdentity.upsert({
    where: { provider_subject: { provider: provider.id, subject: provider.subject } },
    create: { provider: provider.id, subject: provider.subject, userId: user.id },
    update: { userId: user.id },
  });
  await linkLegacyIdentity(prisma, provider.id, user.id, provider.subject);

  return { email: user.email, id: user.id, name: user.name };
}

export function toSignInProvider(providerId: string, subject: string): SignInProvider {
  return { id: providerId, subject };
}

export type { User };
