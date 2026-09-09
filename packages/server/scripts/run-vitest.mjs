import { spawn } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);
const vitestArgs = ['--config', 'vitest.config.ts', '--passWithNoTests', '--run'];

for (let index = 0; index < forwardedArgs.length; index += 1) {
  const argument = forwardedArgs[index];

  if (argument === '--run') {
    continue;
  }

  if (argument === '--grep') {
    const pattern = forwardedArgs[index + 1];

    if (pattern !== undefined) {
      vitestArgs.push('--testNamePattern', pattern);
      index += 1;
    }

    continue;
  }

  if (argument.startsWith('--grep=')) {
    vitestArgs.push('--testNamePattern', argument.slice('--grep='.length));
    continue;
  }

  vitestArgs.push(argument);
}

// Strict security gate: Vitest MUST only run against a test database (_test suffix)
process.env.NODE_ENV = 'test';

let targetDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
if (!targetDbUrl) {
  targetDbUrl = 'postgresql://involute:involute@127.0.0.1:5434/involute_test?schema=public';
} else {
  try {
    const parsed = new URL(targetDbUrl);
    const dbName = parsed.pathname.replace(/^\//, '');
    if (!dbName.endsWith('_test')) {
      parsed.pathname = `/${dbName}_test`;
      targetDbUrl = parsed.toString();
    }
  } catch {
    // Malformed URL, let downstream error
  }
}

// Final assertion: verify database name
try {
  const parsed = new URL(targetDbUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test') && process.env.ALLOW_TESTS_ON_PROD_DB !== 'true') {
    console.error('\n================================================================================');
    console.error(' [FATAL SECURITY INTERCEPTION: VITEST ABORTED]');
    console.error(` Attempted to run Vitest against non-test database: '${dbName}'!`);
    console.error(' Vitest is hard-coded to ONLY run against databases ending in _test.');
    console.error(' Target URL:', targetDbUrl.replace(/:[^:@]+@/, ':****@'));
    console.error('================================================================================\n');
    process.exit(1);
  }
} catch (err) {
  console.error('Failed to validate test DATABASE_URL in run-vitest.mjs:', err);
  process.exit(1);
}

process.env.DATABASE_URL = targetDbUrl;

const child = spawn('pnpm', ['exec', 'vitest', ...vitestArgs], {
  stdio: 'inherit',
  shell: true,
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    DATABASE_URL: targetDbUrl,
    NODE_ENV: 'test',
  },
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
