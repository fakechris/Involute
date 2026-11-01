import { describe, expect, it } from 'vitest';

import { findWorkReferences, workReferenceKey } from './work-reference';

function referencesIn(text: string): string[] {
  return findWorkReferences(text).map((match) => match.reference);
}

describe('work references in prose (INV-1466)', () => {
  it('finds a reference whatever the project prefix is', () => {
    expect(referencesIn('depends on INV-1446')).toEqual(['INV-1446']);
    expect(referencesIn('depends on LUM-398')).toEqual(['LUM-398']);
    expect(referencesIn('see ABC-7')).toEqual(['ABC-7']);
  });

  it('finds every reference in a sentence and where it sits', () => {
    const text = 'INV-1446 depends on INV-267, and INV-268 closes it.';
    const matches = findWorkReferences(text);

    expect(matches.map((match) => match.reference)).toEqual(['INV-1446', 'INV-267', 'INV-268']);
    expect(text.slice(matches[1]!.start, matches[1]!.end)).toBe('INV-267');
  });

  it('leaves the things that only look like references alone', () => {
    // A longer dash chain, a word that continues, and a version number.
    expect(referencesIn('CVE-2021-1234')).toEqual([]);
    expect(referencesIn('INV-1446a')).toEqual([]);
    expect(referencesIn('x-INV-1446')).toEqual([]);
    expect(referencesIn('INV-1446-1447')).toEqual([]);
    expect(referencesIn('utf8 and http2')).toEqual([]);
  });

  it('cuts references out of the text around them', () => {
    expect(referencesIn('（INV-1446）')).toEqual(['INV-1446']);
    expect(referencesIn('INV-1446，')).toEqual(['INV-1446']);
    expect(referencesIn('see INV-1446.')).toEqual(['INV-1446']);
    expect(referencesIn('依赖 INV-1446 落地')).toEqual(['INV-1446']);
  });

  it('keys a reference by its case, so one item is asked about once', () => {
    expect(workReferenceKey('inv-1446')).toBe('INV-1446');
    expect(workReferenceKey(' LUM-398 ')).toBe('LUM-398');
  });
});
