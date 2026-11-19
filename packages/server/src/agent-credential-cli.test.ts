import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('agent credential CLI startup', () => {
  it.each([
    { args: [], usage: 'Usage: agent-credential <create|revoke|list|deactivate|transfer-owner|service>' },
    { args: ['create', '--help'], usage: 'Usage: agent:create <team-key> <name> <email>' },
    { args: ['unknown'], usage: 'Usage: agent-credential <create|revoke|list|deactivate|transfer-owner|service>' },
  ])('reaches argument handling for $args', ({ args, usage }) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'prisma/agent-credential.ts', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).toContain('Agent credential command failed.');
    expect(result.stderr).toContain(usage);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
