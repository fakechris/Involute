// @vitest-environment node
/**
 * The issue drawer's rail (INV-1513). jsdom has no layout, so the rules that
 * keep the 280px rail from scrolling sideways are checked in the stylesheet:
 * the rail hides horizontal overflow, its stacked fields may shrink, and the
 * Project / Location picker is one column as on the full page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of every rule whose selector list is exactly `selector`, later rules winning. */
function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const selectors = match[1]!.split(',').map((entry) => entry.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const declaration of match[2]!.split(';')) {
      const [property, ...value] = declaration.split(':');
      if (property?.trim() && value.length) result[property.trim()] = value.join(':').trim();
    }
  }
  return result;
}

describe('issue drawer rail (INV-1513)', () => {
  it('never scrolls sideways', () => {
    expect(declarations('.issue-panel__rail')).toMatchObject({ 'overflow-y': 'auto', 'overflow-x': 'hidden' });
  });

  it('lets stacked fields shrink below their 140px default', () => {
    expect(declarations('.field-stack')['min-width']).toBe('140px');
    expect(declarations('.issue-panel__rail .field-stack')['min-width']).toBe('0');
  });

  it('stacks Project and Location in one column, as the full page does', () => {
    expect(declarations('.placement-picker')['grid-template-columns']).toBe('1fr 1fr');
    expect(declarations('.issue-panel__rail .work-structure .placement-picker')['grid-template-columns']).toBe('minmax(0, 1fr)');
    expect(declarations('.issue-panel--page .work-structure .placement-picker')['grid-template-columns']).toBe('minmax(0, 1fr)');
  });
});
