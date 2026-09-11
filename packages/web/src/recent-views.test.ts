import { describe, expect, it } from 'vitest';

import {
  RECENT_VIEWS_STORAGE_KEY,
  deriveViewLabel,
  pushRecentView,
  readRecentViews,
  writeRecentViews,
  type RecentViewEntry,
} from './recent-views';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

function entry(path: string, at = 1): RecentViewEntry {
  return { path, label: path, at };
}

describe('deriveViewLabel', () => {
  it('maps known pathnames to base labels', () => {
    expect(deriveViewLabel('/', '')).toBe('Board');
    expect(deriveViewLabel('/backlog', '')).toBe('Backlog');
    expect(deriveViewLabel('/candidates', '')).toBe('Candidates');
    expect(deriveViewLabel('/in-review', '')).toBe('In Review');
    expect(deriveViewLabel('/bugs', '')).toBe('Bugs');
    expect(deriveViewLabel('/graph', '')).toBe('Graph');
    expect(deriveViewLabel('/inbox', '')).toBe('Inbox');
    expect(deriveViewLabel('/my-issues', '')).toBe('My Issues');
    expect(deriveViewLabel('/views', '')).toBe('Views');
    expect(deriveViewLabel('/projects', '')).toBe('Projects');
    expect(deriveViewLabel('/members', '')).toBe('Members');
  });

  it('maps work detail paths to Work', () => {
    expect(deriveViewLabel('/issue/abc-123', '')).toBe('Work');
    expect(deriveViewLabel('/work/abc-123', '')).toBe('Work');
  });

  it('returns null for unknown or auth paths', () => {
    expect(deriveViewLabel('/settings', '')).toBeNull();
    expect(deriveViewLabel('/auth/callback', '')).toBeNull();
    expect(deriveViewLabel('/nope', '')).toBeNull();
  });

  it('appends the team param', () => {
    expect(deriveViewLabel('/', '?team=INV')).toBe('Board · INV');
  });

  it('appends the project short name', () => {
    expect(deriveViewLabel('/', '?team=INV&project=fakechris%2Flumenbox')).toBe(
      'Board · INV · lumenbox',
    );
  });

  it('renders the no-project sentinel and skips all/absent projects', () => {
    expect(deriveViewLabel('/candidates', '?project=__none__')).toBe('Candidates · No project');
    expect(deriveViewLabel('/', '?project=all')).toBe('Board');
    expect(deriveViewLabel('/', '?team=INV')).toBe('Board · INV');
  });

  it('appends the issue param', () => {
    expect(deriveViewLabel('/', '?issue=INV-12')).toBe('Board · INV-12');
    expect(deriveViewLabel('/', '?team=INV&project=fakechris%2FInvolute&issue=INV-40')).toBe(
      'Board · INV · Involute · INV-40',
    );
  });
});

describe('pushRecentView', () => {
  it('prepends new entries', () => {
    const next = pushRecentView([entry('/a', 1)], entry('/b', 2));
    expect(next.map((item) => item.path)).toEqual(['/b', '/a']);
  });

  it('dedupes by path and moves the revisit to the front', () => {
    const list = [entry('/b', 2), entry('/a', 1)];
    const next = pushRecentView(list, entry('/a', 3));
    expect(next.map((item) => item.path)).toEqual(['/a', '/b']);
    expect(next[0]?.at).toBe(3);
    expect(next).toHaveLength(2);
  });

  it('caps the list length', () => {
    let list: RecentViewEntry[] = [];
    for (let i = 0; i < 10; i++) {
      list = pushRecentView(list, entry(`/p${i}`, i));
    }
    expect(list).toHaveLength(8);
    expect(list[0]?.path).toBe('/p9');
    expect(list[7]?.path).toBe('/p2');
  });

  it('respects a custom cap', () => {
    const list = pushRecentView([entry('/a'), entry('/b')], entry('/c'), 2);
    expect(list.map((item) => item.path)).toEqual(['/c', '/a']);
  });
});

describe('readRecentViews / writeRecentViews', () => {
  it('round-trips entries through storage', () => {
    const storage = createMemoryStorage();
    const list = [entry('/b', 2), entry('/a', 1)];
    writeRecentViews(storage, list);
    expect(readRecentViews(storage)).toEqual(list);
  });

  it('returns an empty list when nothing is stored', () => {
    expect(readRecentViews(createMemoryStorage())).toEqual([]);
  });

  it('tolerates corrupt JSON', () => {
    const storage = createMemoryStorage({ [RECENT_VIEWS_STORAGE_KEY]: '{not json' });
    expect(readRecentViews(storage)).toEqual([]);
  });

  it('tolerates non-array payloads and drops malformed entries', () => {
    const wrongShape = createMemoryStorage({ [RECENT_VIEWS_STORAGE_KEY]: '{"path":"/a"}' });
    expect(readRecentViews(wrongShape)).toEqual([]);

    const mixed = createMemoryStorage({
      [RECENT_VIEWS_STORAGE_KEY]: JSON.stringify([
        { path: '/a', label: 'Board', at: 1 },
        { path: 42, label: 'Bad' },
        'garbage',
        { path: '/b', label: 'Backlog', at: 2 },
      ]),
    });
    expect(readRecentViews(mixed).map((item) => item.path)).toEqual(['/a', '/b']);
  });

  it('does not throw when storage writes fail', () => {
    const failingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => writeRecentViews(failingStorage, [entry('/a')])).not.toThrow();
  });
});
