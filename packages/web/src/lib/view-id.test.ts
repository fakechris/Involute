import { afterEach, describe, expect, it } from 'vitest';

import { isViewUuid, newViewId } from './view-id';

// INV-2157: view ids are UUIDs even where crypto.randomUUID is missing (plain http).
describe('newViewId', () => {
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  afterEach(() => {
    if (original) Object.defineProperty(crypto, 'randomUUID', original);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  });

  it('makes a v4 UUID without crypto.randomUUID', () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 50 }, () => newViewId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(isViewUuid(id)).toBe(true);
      expect(id[14]).toBe('4');
      expect('89ab').toContain(id[19]!);
    }
  });

  it('tells a browser-made id from a UUID', () => {
    expect(isViewUuid('backlog-view-1700000000000-abc123')).toBe(false);
    expect(isViewUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
  });
});
