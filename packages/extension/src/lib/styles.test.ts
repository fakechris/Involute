// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { STYLE_KEYS, extractStyles } from './styles';

describe('extractStyles', () => {
  it('reads exactly the allowlist from computed style', () => {
    const element = document.createElement('div');
    element.style.cssText = 'color: rgb(1, 2, 3); font-size: 14px; display: flex; position: absolute; z-index: 5; background-image: url(https://x/y.png); --secret: 1; content: "x"';
    document.body.append(element);
    const styles = extractStyles(getComputedStyle(element));
    expect(styles.color).toBe('rgb(1, 2, 3)');
    expect(styles['font-size']).toBe('14px');
    expect(styles.display).toBe('flex');
    expect(styles.position).toBe('absolute');
    expect(styles['z-index']).toBe('5');
    for (const key of Object.keys(styles)) expect(STYLE_KEYS as readonly string[]).toContain(key);
    expect(JSON.stringify(styles)).not.toContain('y.png');
  });

  it('rebuilds empty shorthands from their sides and caps long values', () => {
    const values: Record<string, string> = {
      'margin-top': '1px', 'margin-right': '2px', 'margin-bottom': '1px', 'margin-left': '2px',
      'padding-top': '4px', 'padding-right': '4px', 'padding-bottom': '4px', 'padding-left': '4px',
      'font-family': 'x'.repeat(500),
    };
    const styles = extractStyles({ getPropertyValue: (name: string) => values[name] ?? '' });
    expect(styles.margin).toBe('1px 2px 1px 2px');
    expect(styles.padding).toBe('4px');
    expect(styles['font-family']).toHaveLength(200);
    expect(styles.color).toBeUndefined();
  });
});
