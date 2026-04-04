import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDatabaseUrl } from '../src/database-url.ts';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export function getProjectEnvPath(): string {
  return resolve(currentDirectory, '../../../.env');
}

export function loadProjectEnvironment(): void {
  loadDotenv({
    path: getProjectEnvPath(),
  });

  if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
  }
}
