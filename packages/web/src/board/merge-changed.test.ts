import { describe, expect, it } from 'vitest';

import type { BoardPageQueryData } from './types';
import { mergeChangedBoardIssues, newestUpdatedAt } from './utils';

// INV-1526: items changed after the board loaded are merged in without losing the list's paging.
const page = (nodes: Array<{ id: string; updatedAt: string; title?: string }>, endCursor: string | null) =>
  ({ teams: { nodes: [] }, issueStateCounts: [{ stateId: 's', count: 9 }], issues: { nodes, pageInfo: { endCursor, hasNextPage: true } } }) as unknown as BoardPageQueryData;

describe('changed-since merge (INV-1526)', () => {
  it('replaces and adds by id and keeps the paging and totals of the list', () => {
    const loaded = page([{ id: 'a', updatedAt: '2026-11-02T10:00:00Z' }, { id: 'b', updatedAt: '2026-11-02T09:00:00Z' }], 'u:cursor');
    const changed = page([{ id: 'b', updatedAt: '2026-11-02T11:00:00Z', title: 'edited' }, { id: 'z', updatedAt: '2026-11-02T11:30:00Z' }], 'other');
    const merged = mergeChangedBoardIssues(loaded, changed);
    expect(merged.issues.nodes.map((node) => node.id)).toEqual(['a', 'b', 'z']);
    expect((merged.issues.nodes[1] as unknown as { title: string }).title).toBe('edited');
    expect(merged.issues.pageInfo.endCursor).toBe('u:cursor');
    expect(merged.issueStateCounts).toEqual([{ stateId: 's', count: 9 }]);
  });

  it('finds the newest change among loaded items', () => {
    expect(newestUpdatedAt([{ updatedAt: '2026-11-02T09:00:00Z' }, { updatedAt: '2026-11-02T10:00:00Z' }, { updatedAt: null }])).toBe('2026-11-02T10:00:00Z');
    expect(newestUpdatedAt([])).toBeNull();
  });
});
