import { execSync } from 'node:child_process';

const dbUrl = process.env.DATABASE_URL || '';
let isTestDb = false;
try {
  const parsed = new URL(dbUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  isTestDb = dbName.endsWith('_test') || parsed.port === '5433';
} catch {
  isTestDb = false;
}
const allowDangerous = process.env.ALLOW_DANGEROUS_DB_RESET === 'true';

if (!isTestDb && !allowDangerous) {
  console.error('\n================================================================================');
  console.error(' [FATAL GUARD: DANGEROUS PRISMA RESET PREVENTED]');
  console.error(' Attempted to run migrate reset on a non-test database!');
  console.error(' Current DATABASE_URL does not contain "test":');
  console.error('   ' + dbUrl.replace(/:[^:@]+@/, ':****@'));
  console.error('');
  console.error(' To prevent accidental data loss, tests and resets must target a test DB.');
  console.error(' Example: DATABASE_URL="postgresql://involute:involute@127.0.0.1:5434/involute_test"');
  console.error('================================================================================\n');
  process.exit(1);
}

execSync('pnpm exec prisma migrate reset --force --skip-generate --skip-seed', { stdio: 'inherit' });
