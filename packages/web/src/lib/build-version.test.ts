import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { INVOLUTE_VERSION_PLACEHOLDER, involuteVersion, withInvoluteVersion } from './build-version';

describe('involute-version meta (INV-1146)', () => {
  it('index.html carries the placeholder the build fills in', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain(`<meta name="involute-version" content="${INVOLUTE_VERSION_PLACEHOLDER}" />`);
    expect(withInvoluteVersion(html, 'ABCDEF0123456789abcdef0123456789abcdef01')).toContain(
      '<meta name="involute-version" content="abcdef0123456789abcdef0123456789abcdef01" />',
    );
  });

  it('is the source SHA when the build has one, otherwise dev', () => {
    expect(involuteVersion('22ae929')).toBe('22ae929');
    expect(involuteVersion(undefined)).toBe('dev');
    expect(involuteVersion('')).toBe('dev');
    expect(involuteVersion('latest')).toBe('dev');
  });
});
