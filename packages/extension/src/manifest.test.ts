import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPERATIONS } from './api/operations';

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'static', 'manifest.json'), 'utf8')) as Record<string, unknown> & {
  key: string;
  permissions: string[];
  optional_host_permissions: string[];
  host_permissions?: string[];
  externally_connectable: { matches: string[] };
  commands: Record<string, { suggested_key: { default: string } }>;
};

/** Chrome's extension ID: the first 128 bits of SHA-256 over the public key (DER), as hex digits mapped 0-f → a-p. */
function extensionId(publicKeyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...digest].map((digit) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16))).join('');
}

describe('manifest', () => {
  it('has the fixed public key, so the unpacked ID is the one Involute sends tokens to', () => {
    expect(manifest.name).toBe('Involute Capture');
    expect(manifest.manifest_version).toBe(3);
    expect(extensionId(manifest.key)).toBe('gggpgjhcjmonhaipcmeeaejlncgihbge');
    const web = readFileSync(join(root, '..', 'web', 'src', 'extension', 'constants.ts'), 'utf8');
    expect(web).toContain(`'${extensionId(manifest.key)}'`);
  });

  it('asks for the minimum: no host permission up front, no tabs, cookies, debugger or webRequest', () => {
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'scripting', 'sidePanel', 'storage']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions.sort()).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest.commands['capture-bug']!.suggested_key.default).toBe('Alt+Shift+B');
  });

  it('lets only Involute and local development pages message it', () => {
    expect(manifest.externally_connectable.matches).toEqual(['https://involute.lumenopen.com/*', 'http://127.0.0.1/*', 'http://localhost/*']);
  });

  it('never ships a private key', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('dist')) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(root);
    for (const file of files) {
      expect(file.endsWith('.pem'), file).toBe(false);
      expect(readFileSync(file, 'utf8'), file).not.toContain(['PRIVATE', 'KEY-----'].join(' '));
    }
  });

  it('exports every GraphQL document by its operation name', () => {
    for (const [name, document] of Object.entries(OPERATIONS)) {
      expect(document).toMatch(new RegExp(`(query|mutation) ${name}\\b`));
      expect(document).not.toContain('...');
    }
  });
});
