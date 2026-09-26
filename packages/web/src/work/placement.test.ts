import { beforeEach, describe, expect, it } from 'vitest';

import { childPlacement, readLastPlacement, rememberPlacement, resolveInitialPlacement } from './placement';

const projects = [
  { repository: 'fakechris/Involute', identifier: 'INV-79' },
  { repository: 'fakechris/lumenbox', identifier: 'INV-96' },
  { repository: 'loose/repo', identifier: null },
];

describe('create placement (INV-744)', () => {
  beforeEach(() => window.localStorage.clear());

  it('prefers entry-point context, then the board filter, then the last choice', () => {
    const context = { repository: 'fakechris/Involute', parentId: 'milestone-80' };
    const last = { repository: 'fakechris/lumenbox', parentId: 'milestone-9' };
    expect(resolveInitialPlacement({ context, boardRepository: 'fakechris/lumenbox', last, projects })).toEqual({ placement: context, source: 'context' });
    expect(resolveInitialPlacement({ boardRepository: 'fakechris/Involute', last, projects })).toEqual({
      placement: { repository: 'fakechris/Involute', parentId: 'INV-79' },
      source: 'board',
    });
    expect(resolveInitialPlacement({ boardRepository: 'loose/repo', last, projects })).toEqual({ placement: last, source: 'last' });
    expect(resolveInitialPlacement({ last: { repository: 'gone/repo', parentId: 'x' }, projects })).toBeNull();
    expect(resolveInitialPlacement({ projects })).toBeNull();
  });

  it('remembers a project location per team but not a one-off sub-issue parent', () => {
    rememberPlacement('INV', { repository: 'fakechris/Involute', parentId: 'milestone-80' });
    expect(readLastPlacement('INV')).toEqual({ repository: 'fakechris/Involute', parentId: 'milestone-80' });
    expect(readLastPlacement('SON')).toBeNull();
    rememberPlacement('INV', { repository: 'fakechris/Involute', parentId: 'issue-1', parentLabel: 'Sub-issue of INV-1 — X' });
    expect(readLastPlacement('INV')).toEqual({ repository: 'fakechris/Involute', parentId: 'milestone-80' });
    window.localStorage.setItem('involute.createPlacement.INV', '{not json');
    expect(readLastPlacement('INV')).toBeNull();
  });

  it('places children under issues, containers and projects, never under decisions', () => {
    const base = { id: 'id-1', identifier: 'INV-1', title: 'Parent', repository: 'fakechris/Involute' };
    expect(childPlacement({ ...base, kind: 'ISSUE' })).toEqual({
      repository: 'fakechris/Involute',
      parentId: 'id-1',
      parentLabel: 'Sub-issue of INV-1 — Parent',
    });
    expect(childPlacement({ ...base, kind: 'MILESTONE' })).toEqual({ repository: 'fakechris/Involute', parentId: 'id-1' });
    expect(childPlacement({ ...base, kind: 'DECISION' })).toBeNull();
    expect(childPlacement({ ...base, kind: 'ISSUE', repository: null })).toBeNull();
  });
});
