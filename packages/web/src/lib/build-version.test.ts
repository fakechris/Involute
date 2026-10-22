import { existsSync, readFileSync } from 'node:fs';
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

  it('index.html declares /favicon.svg and /favicon.ico backed by public assets (INV-1325)', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(html).toContain('<link rel="alternate icon" href="/favicon.ico" sizes="any" />');

    const svgPath = join(process.cwd(), 'public', 'favicon.svg');
    const icoPath = join(process.cwd(), 'public', 'favicon.ico');
    expect(existsSync(svgPath)).toBe(true);
    expect(existsSync(icoPath)).toBe(true);

    const svg = readFileSync(svgPath, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('#9f4f24');

    const ico = readFileSync(icoPath);
    // ICONDIR header: reserved=0, type=1 (ICO), count=1
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(1);
  });

  it('is the source SHA when the build has one, otherwise dev', () => {
    expect(involuteVersion('22ae929')).toBe('22ae929');
    expect(involuteVersion(undefined)).toBe('dev');
    expect(involuteVersion('')).toBe('dev');
    expect(involuteVersion('latest')).toBe('dev');
  });
});
