import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from './constants.js';
import { normalizeDatabaseUrl } from './database-url.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export interface ServerEnvironment {
  allowAdminFallback: boolean;
  databaseUrl: string;
  authToken: string;
  port: number;
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

  if (allowAdminFallback && nodeEnvironment !== 'development' && nodeEnvironment !== 'test') {
    throw new Error('ALLOW_ADMIN_FALLBACK=true is only supported in development or test environments.');
  }

  return {
    allowAdminFallback,
    databaseUrl: env.DATABASE_URL ?? '',
    authToken: env.AUTH_TOKEN ?? '',
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    viewerAssertionSecret: env.VIEWER_ASSERTION_SECRET?.trim() || null,
  };
}
