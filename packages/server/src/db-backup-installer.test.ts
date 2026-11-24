import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// INV-2152: the backup timer installer copies itself. Run through stdin it
// cannot find itself, so it must refuse before copying anything.
const SCRIPT = new URL('../../../scripts/db-backup-daily.sh', import.meta.url).pathname;

describe('db-backup-daily.sh install', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function sandbox(): string {
    const dir = mkdtempSync(join(tmpdir(), 'db-backup-install-'));
    dirs.push(dir);
    return dir;
  }

  it('refuses `bash -s install` even when a file called bash is in the current directory', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'bash'), '#!/bin/sh\necho not-the-backup\n');
    chmodSync(join(dir, 'bash'), 0o755);
    const run = spawnSync('bash', ['-s', 'install'], { cwd: dir, input: readFileSync(SCRIPT), encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('install must run from the script file, not from stdin');
    // It stopped at the guard: nothing tried to copy or to write a unit file.
    expect(run.stderr).not.toMatch(/install:|systemd|Permission denied/);
  });

  it('refuses `bash -s install` with no such file around', () => {
    const run = spawnSync('bash', ['-s', 'install'], { cwd: sandbox(), input: readFileSync(SCRIPT), encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('install must run from the script file');
  });

  it('passes the guard when run from the script file', () => {
    const dir = sandbox();
    const copy = join(dir, 'db-backup-daily.sh');
    copyFileSync(SCRIPT, copy);
    const run = spawnSync('bash', [copy, 'install'], { cwd: dir, encoding: 'utf8' });
    // Past the guard it goes on to install, which needs root here; what matters is it was not refused.
    expect(run.stderr).not.toContain('install must run from the script file');
  });
});
