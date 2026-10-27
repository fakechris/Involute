import { afterEach, describe, expect, it } from 'vitest';
import {
  addProjectRecent,
  pickPinnedProjects,
  projectRecentsStorageKey,
  readProjectRecents,
  recordProjectRecent,
  shortProjectName,
  type PinnableProject,
} from './project-recents';

afterEach(() => {
  window.localStorage.clear();
});

function project(name: string, issueCount: number): PinnableProject {
  return { id: `id-${name}`, identifier: `INV-${issueCount}`, key: `INV-${issueCount}`, name, issueCount };
}

describe('project recents (INV-1386)', () => {
  it('adds newest first, de-duplicates case-insensitively and keeps five', () => {
    let recents: string[] = [];
    for (const name of ['a/one', 'a/two', 'a/three', 'a/four', 'a/five']) recents = addProjectRecent(recents, name);
    expect(recents).toEqual(['a/five', 'a/four', 'a/three', 'a/two', 'a/one']);
    recents = addProjectRecent(recents, 'A/TWO');
    expect(recents).toEqual(['A/TWO', 'a/five', 'a/four', 'a/three', 'a/one']);
    recents = addProjectRecent(recents, 'a/six');
    expect(recents).toEqual(['a/six', 'A/TWO', 'a/five', 'a/four', 'a/three']);
  });

  it('stores one list per team', () => {
    recordProjectRecent('INV', 'fakechris/Involute');
    recordProjectRecent('INV', 'fakechris/lumenbox');
    recordProjectRecent('OPS', 'fakechris/ops');
    expect(readProjectRecents('INV')).toEqual(['fakechris/lumenbox', 'fakechris/Involute']);
    expect(readProjectRecents('OPS')).toEqual(['fakechris/ops']);
    expect(readProjectRecents(null)).toEqual([]);
    expect(projectRecentsStorageKey('INV')).not.toBe(projectRecentsStorageKey('OPS'));
  });

  it('ignores corrupt storage', () => {
    window.localStorage.setItem(projectRecentsStorageKey('INV'), '{not json');
    expect(readProjectRecents('INV')).toEqual([]);
    window.localStorage.setItem(projectRecentsStorageKey('INV'), JSON.stringify([1, 'a/b', '']));
    expect(readProjectRecents('INV')).toEqual(['a/b']);
  });

  it('pins recents first, then fills with the highest issue counts up to five', () => {
    const projects = [project('a/small', 1), project('a/big', 90), project('a/mid', 40), project('a/tiny', 0), project('a/large', 70), project('a/medium', 20), project('a/other', 5)];
    expect(pickPinnedProjects(projects, ['a/tiny', 'a/unknown', 'a/mid']).map((p) => p.name)).toEqual(['a/tiny', 'a/mid', 'a/big', 'a/large', 'a/medium']);
    expect(pickPinnedProjects(projects, []).map((p) => p.name)).toEqual(['a/big', 'a/large', 'a/mid', 'a/medium', 'a/other']);
    expect(pickPinnedProjects(projects.slice(0, 2), ['a/small']).map((p) => p.name)).toEqual(['a/small', 'a/big']);
  });

  it('shortens owner/repo to the repo name', () => {
    expect(shortProjectName('fakechris/Involute')).toBe('Involute');
    expect(shortProjectName('Involute')).toBe('Involute');
  });
});
