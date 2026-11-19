import { beforeEach, describe, expect, it } from 'vitest';

import {
  childPlacement,
  findPlacementProject,
  placementProjectKey,
  placementProjects,
  projectPlacement,
  readLastPlacement,
  rememberPlacement,
  resolveInitialPlacement,
} from './placement';

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

describe('projects with no repository (INV-1918)', () => {
  const summary = {
    projects: [{ repository: 'fakechris/Involute', name: 'Involute', identifier: 'INV-79' }],
    projectsWithoutRepository: [{ identifier: 'INV-5', name: 'E2E Demo Project' }],
  };
  const all = placementProjects(summary);

  it('lists them after the projects with a repository, keyed by identifier', () => {
    expect(all).toEqual([
      { repository: 'fakechris/Involute', name: 'Involute', identifier: 'INV-79' },
      { repository: null, name: 'E2E Demo Project', identifier: 'INV-5' },
    ]);
    expect(all.map(placementProjectKey)).toEqual(['fakechris/Involute', 'project:INV-5']);
    expect(placementProjects(null)).toEqual([]);
    expect(placementProjects({ projects: summary.projects })).toEqual([summary.projects[0]]);
  });

  it('places new work directly under the project, as No milestone', () => {
    expect(projectPlacement(all[1])).toEqual({ repository: '', parentId: 'INV-5' });
    expect(projectPlacement(all[0])).toEqual({ repository: 'fakechris/Involute', parentId: 'INV-79' });
    expect(projectPlacement(undefined)).toBeNull();
    expect(findPlacementProject(all, { repository: '', parentId: 'INV-5' })).toBe(all[1]);
    expect(findPlacementProject(all, { repository: '', parentId: 'INV-404' })).toBeUndefined();
  });

  it('starts from a remembered placement in such a project while it still exists', () => {
    const last = { repository: '', parentId: 'INV-5' };
    expect(resolveInitialPlacement({ last, projects: all })).toEqual({ placement: last, source: 'last' });
    expect(resolveInitialPlacement({ last, projects: [all[0]!] })).toBeNull();
    rememberPlacement('INV', last);
    expect(readLastPlacement('INV')).toEqual(last);
  });
});
