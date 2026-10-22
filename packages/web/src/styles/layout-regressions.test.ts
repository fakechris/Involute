// @vitest-environment node
/**
 * Layout rules jsdom cannot see (it computes no layout), checked in the
 * stylesheets themselves. Each one fixed a bug seen after a deploy; the
 * browser check that found it is in the commit / PR that added the rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSheet(name: string): string {
  return readFileSync(join(__dirname, name), 'utf8');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`No rule for ${selector}`);
  return match[1];
}

describe('layout regressions (INV-1311)', () => {
  it('lets each filter wrap on its own and keeps the view slot on the last filter row', () => {
    // A wrapped filters slot took the whole width, so "Clear all" sat alone on
    // a row and the view controls dropped below an empty block.
    const css = readSheet('layout.css');
    expect(ruleBody(css, '.page-toolbar')).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(css, '.page-toolbar__filters')).toMatch(/display:\s*contents/);
    expect(ruleBody(css, '.page-toolbar__view')).toMatch(/margin-left:\s*auto/);
  });
});
