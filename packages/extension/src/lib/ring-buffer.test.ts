import { describe, expect, it } from 'vitest';

import { RingBuffer, truncate } from './ring-buffer';

describe('RingBuffer', () => {
  it('keeps the newest entries up to its capacity and counts what fell out', () => {
    const buffer = new RingBuffer<number>(3);
    for (let n = 1; n <= 10; n += 1) buffer.push(n);
    expect(buffer.toArray()).toEqual([8, 9, 10]);
    expect(buffer.size).toBe(3);
    expect(buffer.droppedCount).toBe(7);
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });

  it('returns a copy', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.toArray().push(99);
    expect(buffer.toArray()).toEqual([1]);
  });
});

describe('truncate', () => {
  it('cuts to the limit with a mark', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 4)).toHaveLength(4);
    expect(truncate('abc', 4)).toBe('abc');
  });
});
