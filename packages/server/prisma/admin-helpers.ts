import type { PrismaClient, User } from '@prisma/client';

import { DEFAULT_ADMIN_NAME } from './constants.ts';

export interface EnsureAdminUsersOptions {
  defaultName?: string;
}

export function normalizeAdminEmails(emails: readonly string[]): string[] {
  return [...new Set(
    emails
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )];
}

export async function ensureAdminUsers(
  prisma: PrismaClient,
  emails: readonly string[],
  options: EnsureAdminUsersOptions = {},
): Promise<Array<Pick<User, 'email' | 'globalRole' | 'id' | 'name'>>> {
  const normalizedEmails = normalizeAdminEmails(emails);
  const defaultName = options.defaultName?.trim() || DEFAULT_ADMIN_NAME;
  const createdOrUpdatedUsers: Array<Pick<User, 'email' | 'globalRole' | 'id' | 'name'>> = [];

  for (const email of normalizedEmails) {
    const user = await prisma.user.upsert({
      where: {
        email,
      },
      create: {
        email,
        globalRole: 'ADMIN',
        name: buildBootstrapAdminName(email, defaultName),
      },
      update: {
        globalRole: 'ADMIN',
      },
      select: {
        email: true,
        globalRole: true,
        id: true,
        name: true,
      },
    });

    createdOrUpdatedUsers.push(user);
  }

  return createdOrUpdatedUsers;
}

function buildBootstrapAdminName(email: string, fallbackName: string): string {
  const localPart = email.split('@')[0]?.trim() ?? '';
  const name = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(' ')
    .trim();

  return name || fallbackName;
}
