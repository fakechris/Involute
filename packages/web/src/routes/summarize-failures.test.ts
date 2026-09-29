import { describe, expect, it } from 'vitest';

import { summarizeFailures } from './CandidatesPage';

describe('summarizeFailures', () => {
  it('names each distinct reason once, with the items it applies to', () => {
    expect(summarizeFailures([
      { identifier: 'INV-853', reason: 'You are not signed in.' },
      { identifier: 'INV-855', reason: 'You are not signed in.' },
      { identifier: 'INV-857', reason: 'Committed work needs a parent.' },
    ])).toBe('You are not signed in. (INV-853, INV-855) · Committed work needs a parent. (INV-857)');
  });
});
