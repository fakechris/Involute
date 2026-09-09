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

  const isTestContext =
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.VITEST) ||
    process.argv.some((arg) => arg.includes('vitest') || arg.includes('test'));

  if (isTestContext) {
    // If TEST_DATABASE_URL is provided, prioritize it
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    } else if (process.env.DATABASE_URL) {
      try {
        const parsed = new URL(process.env.DATABASE_URL);
        const dbName = parsed.pathname.replace(/^\//, '');
        if (!dbName.endsWith('_test')) {
          // Divert from production to test database
          parsed.pathname = `/${dbName}_test`;
          process.env.DATABASE_URL = parsed.toString();
        }
      } catch {
        // malformed URL, let normal handling catch it
      }
    } else {
      process.env.DATABASE_URL = 'postgresql://involute:involute@127.0.0.1:5434/involute_test?schema=public';
    }

    // STRICT DEFENSE GATE: Refuse to proceed if target DB is not a test database
    if (process.env.DATABASE_URL) {
      try {
        const checkUrl = new URL(process.env.DATABASE_URL);
        const checkName = checkUrl.pathname.replace(/^\//, '');
        if (!checkName.endsWith('_test') && process.env.ALLOW_TESTS_ON_PROD_DB !== 'true') {
          console.error('\n================================================================================');
          console.error(' [FATAL SECURITY INTERCEPTION: TEST AGAINST LIVE DATABASE PREVENTED]');
          console.error(` Test runner attempted to connect to non-test database '${checkName}'!`);
          console.error(' Tests are strictly forbidden from running against production databases.');
          console.error(' Target DATABASE_URL must end with _test (e.g. involute_test).');
          console.error(' Current URL:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
          console.error('================================================================================\n');
          process.exit(1);
        }
      } catch (err) {
        console.error('Failed to validate test DATABASE_URL:', err);
        process.exit(1);
      }
    }
  }

  if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
  }
}
