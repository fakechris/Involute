import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default async function globalTeardown() {
  if (process.env.E2E_REUSE_COMPOSE === 'true') {
    return;
  }

  spawnSync('docker', ['compose', 'down', '--remove-orphans'], {
    cwd: rootDir,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: process.env.E2E_COMPOSE_PROJECT ?? 'involute-e2e',
      DB_PORT: process.env.E2E_DB_PORT ?? '5544',
    },
    stdio: 'inherit',
  });
}
