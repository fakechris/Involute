import { describe, expect, it } from 'vitest';

import { assertSingleType, isTypeLabel } from './labels.ts';

describe('Type label group (INV-749)', () => {
  it('recognises Bug, Feature and Improvement in any casing', () => {
    expect(['Bug', 'bug', ' FEATURE ', 'Improvement'].every(isTypeLabel)).toBe(true);
    expect(isTypeLabel('ui')).toBe(false);
  });

  it('counts Research as the fourth Type (INV-912)', () => {
    expect(['Research', 'research', ' RESEARCH '].every(isTypeLabel)).toBe(true);
    expect(() => assertSingleType([{ name: 'research' }, { name: 'Bug' }])).toThrow(/at most one Type/);
    expect(() => assertSingleType([{ name: 'research' }, { name: 'ui' }])).not.toThrow();
  });

  it('allows one Type and any number of other labels', () => {
    expect(() => assertSingleType([{ name: 'bug' }, { name: 'ui' }, { name: 'regression' }])).not.toThrow();
    expect(() => assertSingleType([{ name: 'ui' }])).not.toThrow();
  });

  it('refuses two Types, including two records of the same Type in different casing', () => {
    expect(() => assertSingleType([{ name: 'Bug' }, { name: 'Feature' }])).toThrow(/at most one Type/);
    expect(() => assertSingleType([{ name: 'Bug' }, { name: 'bug' }])).toThrow(/at most one Type/);
  });
});
