import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from './constants.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export interface ServerEnvironment {
  databaseUrl: string;
  authToken: string;
  port: number;
}

export function getProjectEnvPath(): string {
  return resolve(currentDirectory, '../../../.env');
}

export function normalizeDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    return databaseUrl;
  }

  const protocolSeparatorIndex = databaseUrl.indexOf('://');

  if (protocolSeparatorIndex === -1) {
    return databaseUrl;
  }

  const protocol = databaseUrl.slice(0, protocolSeparatorIndex);
  const authorityAndPath = databaseUrl.slice(protocolSeparatorIndex + 3);
  const firstPathSeparatorIndex = authorityAndPath.indexOf('/');
  const authority =
    firstPathSeparatorIndex === -1
      ? authorityAndPath
      : authorityAndPath.slice(0, firstPathSeparatorIndex);
  const pathAndSuffix =
    firstPathSeparatorIndex === -1 ? '' : authorityAndPath.slice(firstPathSeparatorIndex);
  const atSymbolIndex = authority.lastIndexOf('@');

  if (atSymbolIndex === -1) {
    return databaseUrl;
  }

  const auth = authority.slice(0, atSymbolIndex);
  const host = authority.slice(atSymbolIndex + 1);
  const usernameSeparatorIndex = auth.indexOf(':');

  if (usernameSeparatorIndex === -1) {
    return databaseUrl;
  }

  const username = auth.slice(0, usernameSeparatorIndex);
  const password = auth.slice(usernameSeparatorIndex + 1);

  const safeDecode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  return `${protocol}://${encodeURIComponent(safeDecode(username))}:${encodeURIComponent(
    safeDecode(password),
  )}@${host}${pathAndSuffix}`;
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

  return {
    databaseUrl: env.DATABASE_URL ?? '',
    authToken: env.AUTH_TOKEN ?? '',
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
  };
}
