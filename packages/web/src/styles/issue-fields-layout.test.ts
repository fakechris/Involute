// @vitest-environment node
/**
 * Field rows in the narrow issue rail (INV-1514): the label sits above a
 * full-width control. A second label column beside the control squeezed a
 * list field to a sliver ("l‹") and pushed the rail wider than the screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((entry) => entry.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const declaration of match[2]!.split(';')) {
      const [property, ...value] = declaration.split(':');
      if (property?.trim() && value.length) result[property.trim()] = value.join(':').trim();
    }
  }
  return result;
}

describe('field rows in the issue rail (INV-1514)', () => {
  it('stack the label above the control', () => {
    expect(declarations('.issue-fields__row')).toMatchObject({ 'flex-direction': 'column', 'align-items': 'stretch', 'min-width': '0' });
    expect(declarations('.issue-fields__label').width).toBeUndefined();
  });

  it('let selects and inputs take the full width', () => {
    expect(declarations('.issue-fields__row select')).toMatchObject({ width: '100%', 'min-width': '0' });
  });
});
