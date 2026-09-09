import { PrismaClient } from '@prisma/client';
import { loadProjectEnvironment } from '../prisma/env.ts';

// Force test environment
process.env.NODE_ENV = 'test';
loadProjectEnvironment();

const dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl) {
  throw new Error('[SECURITY FATAL] DATABASE_URL is not set for test environment!');
}

let parsedUrl: URL;
try {
  parsedUrl = new URL(dbUrl);
} catch (err) {
  throw new Error(`[SECURITY FATAL] Invalid DATABASE_URL for tests: ${dbUrl}`);
}

const dbName = parsedUrl.pathname.replace(/^\//, '');
if (!dbName.endsWith('_test') && process.env.ALLOW_TESTS_ON_PROD_DB !== 'true') {
  console.error('\n================================================================================');
  console.error(' [FATAL SECURITY INTERCEPTION: TEST SETUP ABORTED]');
  console.error(` Active DATABASE_URL target is '${dbName}', which does NOT end with '_test'!`);
  console.error(' Tests and deleteMany operations are FATALLY BLOCKED on production databases.');
  console.error('================================================================================\n');
  throw new Error(`[SECURITY FATAL] Refusing to run tests against non-test database '${dbName}'!`);
}

// Perform active runtime check with database engine
const verificationClient = new PrismaClient();
try {
  const result = await verificationClient.$queryRawUnsafe<Array<{ current_database: string }>>(
    'SELECT current_database();'
  );
  const activeDb = result[0]?.current_database;
  if (!activeDb || (!activeDb.endsWith('_test') && process.env.ALLOW_TESTS_ON_PROD_DB !== 'true')) {
    throw new Error(
      `[SECURITY FATAL] Live PostgreSQL engine reported connected database is '${activeDb}', NOT a test database! Aborting all tests immediately.`
    );
  }
} finally {
  await verificationClient.$disconnect();
}
