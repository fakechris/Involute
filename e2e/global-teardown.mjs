import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default async function globalTeardown() {
  spawnSync('docker', ['compose', 'down', '--remove-orphans'], {
    cwd: rootDir,
    stdio: 'inherit',
  });
}
