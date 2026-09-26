import { describe, expect, it } from 'vitest';

import { isTypeLabel, toggleLabelId } from './labels';

const labels = [
  { id: 'bug', name: 'bug' },
  { id: 'feature', name: 'Feature' },
  { id: 'improvement', name: 'IMPROVEMENT' },
  { id: 'ui', name: 'ui' },
];

describe('Type label group (INV-749)', () => {
  it('recognises Bug, Feature and Improvement in any casing', () => {
    expect(['Bug', 'bug', ' Feature ', 'improvement'].every(isTypeLabel)).toBe(true);
    expect(isTypeLabel('ui')).toBe(false);
  });

  it('swaps one Type for another and leaves other labels alone', () => {
    expect(toggleLabelId(['bug', 'ui'], 'feature', true, labels)).toEqual(['ui', 'feature']);
    expect(toggleLabelId(['feature'], 'ui', true, labels)).toEqual(['feature', 'ui']);
    expect(toggleLabelId(['feature', 'ui'], 'feature', false, labels)).toEqual(['ui']);
    expect(toggleLabelId(['bug'], 'bug', true, labels)).toEqual(['bug']);
  });
});
