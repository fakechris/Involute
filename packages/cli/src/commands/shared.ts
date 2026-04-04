import { config as loadDotenv } from 'dotenv';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function loadEnv(): void {
  const paths = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '../../.env'),
  ];

  for (const envPath of paths) {
    const result = loadDotenv({ path: envPath });
    if (!result.error) {
      return;
    }
  }
}

export function ensureDatabaseUrl(): void {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
        'Run the project init script or set DATABASE_URL in your .env file.',
    );
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
