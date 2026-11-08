import { describe, expect, it } from 'vitest';

import { looksLikeIql, neighbourhoodIdentifierOf, withoutNeighbourhoodTerm } from './iql-eval';

// The board asks the server to filter and keeps its answer (INV-1470); this
// only tells the two apart, so plain text goes to the server's text search and
// IQL goes to its query argument.
describe('looksLikeIql', () => {
  it('reads a field term as IQL', () => {
    expect(looksLikeIql('state:Ready')).toBe(true);
    expect(looksLikeIql('severity:sev1')).toBe(true);
    expect(looksLikeIql('-state:Ready')).toBe(true);
  });

  it('reads plain text as plain text', () => {
    expect(looksLikeIql('meituan')).toBe(false);
    expect(looksLikeIql('143')).toBe(false);
    expect(looksLikeIql('')).toBe(false);
  });

  it('falls back to plain text when the query does not parse', () => {
    expect(looksLikeIql('unknownfield:x')).toBe(false);
  });

  it('treats neighbourhood: as IQL and keeps the chip identifier (INV-1758)', () => {
    expect(looksLikeIql('neighbourhood:INV-1739')).toBe(true);
    expect(neighbourhoodIdentifierOf('neighbourhood:inv-1739 state:"In Review"')).toBe('INV-1739');
    expect(neighbourhoodIdentifierOf('-neighbourhood:INV-1739')).toBeNull();
    expect(withoutNeighbourhoodTerm('neighbourhood:INV-1739 state:"In Review"')).toBe('state:"In Review"');
  });
});
