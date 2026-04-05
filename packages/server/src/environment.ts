import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from './constants.js';
import { normalizeDatabaseUrl } from './database-url.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export interface ServerEnvironment {
  appOrigin: string;
  allowAdminFallback: boolean;
  databaseUrl: string;
  authToken: string;
  googleOAuthAdminEmails: string[];
  googleOAuthClientId: string | null;
  googleOAuthClientSecret: string | null;
  googleOAuthRedirectUri: string | null;
  port: number;
  sessionTtlSeconds: number;
  viewerAssertionSecret: string | null;
}

export function getProjectEnvPath(): string {
  return resolve(currentDirectory, '../../../.env');
}

export function loadServerEnvironment(): void {
  loadDotenv({
    path: getProjectEnvPath(),
  });

  if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
  }
}

export function getServerEnvironment(env: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  const allowAdminFallback = env.ALLOW_ADMIN_FALLBACK === 'true';
  const nodeEnvironment = env.NODE_ENV ?? 'development';
  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30);
  const googleOAuthAdminEmails = (env.GOOGLE_OAUTH_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (allowAdminFallback && nodeEnvironment !== 'development' && nodeEnvironment !== 'test') {
    throw new Error('ALLOW_ADMIN_FALLBACK=true is only supported in development or test environments.');
  }

  return {
    appOrigin: env.APP_ORIGIN?.trim() || 'http://localhost:4201',
    allowAdminFallback,
    databaseUrl: env.DATABASE_URL ?? '',
    authToken: env.AUTH_TOKEN ?? '',
    googleOAuthAdminEmails,
    googleOAuthClientId: env.GOOGLE_OAUTH_CLIENT_ID?.trim() || null,
    googleOAuthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || null,
    googleOAuthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || null,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    sessionTtlSeconds: Number.isFinite(sessionTtlSeconds) && sessionTtlSeconds > 0
      ? Math.trunc(sessionTtlSeconds)
      : 60 * 60 * 24 * 30,
    viewerAssertionSecret: env.VIEWER_ASSERTION_SECRET?.trim() || null,
  };
}
