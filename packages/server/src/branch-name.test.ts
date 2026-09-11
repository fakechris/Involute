import { describe, expect, it } from 'vitest';

import { suggestedBranchName } from './branch-name.ts';

describe('suggestedBranchName', () => {
  it('builds feat/<identifier>-<slug> for ASCII titles', () => {
    expect(suggestedBranchName('INV-449', 'PR traceability guard')).toBe('feat/inv-449-pr-traceability-guard');
  });

  it('normalizes punctuation, case, and whitespace into single dashes', () => {
    expect(suggestedBranchName('INV-390', '  Board: Default Sort (updatedAt DESC)!! ')).toBe(
      'feat/inv-390-board-default-sort-updatedat-desc',
    );
  });

  it('falls back to the bare identifier for non-ASCII titles', () => {
    expect(suggestedBranchName('INV-445', '看板默认排序修复')).toBe('feat/inv-445');
  });

  it('keeps only the identifier when the title has no ASCII alphanumerics at all', () => {
    expect(suggestedBranchName('LUM-12', '———')).toBe('feat/lum-12');
  });

  it('caps the slug so branch names stay usable', () => {
    const longTitle = 'a'.repeat(200);
    const branch = suggestedBranchName('INV-1', longTitle);
    expect(branch).toBe(`feat/inv-1-${'a'.repeat(40)}`);
    expect(branch.length).toBeLessThanOrEqual('feat/inv-1-'.length + 40);
  });

  it('does not leave a trailing dash when the cap cuts mid-word boundary', () => {
    const branch = suggestedBranchName('INV-7', `${'word-'.repeat(20)}tail`);
    expect(branch.endsWith('-')).toBe(false);
  });

  it('lowercases the identifier so the webhook word-boundary pattern still matches', () => {
    expect(suggestedBranchName('INV-449', 'x')).toMatch(/^feat\/inv-449-/);
  });
});
