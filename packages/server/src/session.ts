import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';

export const SESSION_COOKIE_NAME = 'involute_session';
export const OAUTH_STATE_COOKIE_NAME = 'involute_oauth_state';
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface SessionCookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  value?: string;
}

export interface SessionRecord {
  expiresAt: Date;
  user: User;
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, entry) => {
      const separatorIndex = entry.indexOf('=');

      if (separatorIndex <= 0) {
        return cookies;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();

      if (!key || !value) {
        return cookies;
      }

      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  return parseCookieHeader(cookieHeader)[name] ?? null;
}

export function serializeSessionCookie({
  maxAgeSeconds = DEFAULT_SESSION_TTL_SECONDS,
  secure = false,
  value,
}: SessionCookieOptions): string {
  return serializeCookie(SESSION_COOKIE_NAME, value ?? '', {
    httpOnly: true,
    maxAgeSeconds,
    sameSite: 'Lax',
    secure,
  });
}

export function serializeExpiredSessionCookie(secure = false): string {
  return serializeCookie(SESSION_COOKIE_NAME, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAgeSeconds: 0,
    sameSite: 'Lax',
    secure,
  });
}

export function serializeOAuthStateCookie(
  value: string,
  options: { maxAgeSeconds?: number; secure?: boolean } = {},
): string {
  return serializeCookie(OAUTH_STATE_COOKIE_NAME, value, {
    httpOnly: true,
    maxAgeSeconds: options.maxAgeSeconds ?? 60 * 10,
    sameSite: 'Lax',
    secure: options.secure ?? false,
  });
}

export function serializeExpiredOAuthStateCookie(secure = false): string {
  return serializeCookie(OAUTH_STATE_COOKIE_NAME, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAgeSeconds: 0,
    sameSite: 'Lax',
    secure,
  });
}

export async function createSession(
  prisma: PrismaClient,
  userId: string,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
): Promise<{ expiresAt: Date; token: string }> {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await prisma.session.create({
    data: {
      expiresAt,
      tokenHash: hashSessionToken(token),
      userId,
    },
  });

  return {
    expiresAt,
    token,
  };
}

export async function getSessionRecord(
  prisma: PrismaClient,
  token: string | null,
): Promise<SessionRecord | null> {
  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: {
      tokenHash: hashSessionToken(token),
    },
    include: {
      user: true,
    },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({
      where: {
        id: session.id,
      },
    }).catch(() => undefined);

    return null;
  }

  return {
    expiresAt: session.expiresAt,
    user: session.user,
  };
}

export async function deleteSession(
  prisma: PrismaClient,
  token: string | null,
): Promise<void> {
  if (!token) {
    return;
  }

  await prisma.session.deleteMany({
    where: {
      tokenHash: hashSessionToken(token),
    },
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires?: Date;
    httpOnly?: boolean;
    maxAgeSeconds?: number;
    sameSite?: 'Lax' | 'Strict' | 'None';
    secure?: boolean;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (typeof options.maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}
