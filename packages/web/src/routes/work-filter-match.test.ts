// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { matchesProject, matchesWorkFilters, projectsFromCounts } from './work-filter-match';

const none = { type: '', kind: '', priority: '', owner: '', q: '' } as const;

describe('client-side work filters (INV-1314)', () => {
  it('matches the repository, case-insensitively, and __none__ for no repository', () => {
    expect(matchesProject('acme/a', '')).toBe(true);
    expect(matchesProject('acme/a', 'ACME/a')).toBe(true);
    expect(matchesProject('acme/b', 'acme/a')).toBe(false);
    expect(matchesProject(null, '__none__')).toBe(true);
    expect(matchesProject('acme/a', '__none__')).toBe(false);
  });

  it('applies type, kind, priority, owner and every word of the text', () => {
    const item = { title: 'Crash on save', description: 'The editor dies', kind: 'ISSUE', priority: 1, labelNames: ['Bug'], assigneeId: 'u1' };
    expect(matchesWorkFilters(item, { ...none, type: 'bug' }, 'u1')).toBe(true);
    expect(matchesWorkFilters(item, { ...none, type: 'untyped' }, 'u1')).toBe(false);
    expect(matchesWorkFilters(item, { ...none, kind: 'EPIC' }, 'u1')).toBe(false);
    expect(matchesWorkFilters(item, { ...none, priority: '2' }, 'u1')).toBe(false);
    expect(matchesWorkFilters(item, { ...none, owner: 'me' }, 'u1')).toBe(true);
    expect(matchesWorkFilters(item, { ...none, owner: 'none' }, 'u1')).toBe(false);
    expect(matchesWorkFilters(item, { ...none, q: 'editor crash' }, 'u1')).toBe(true);
    expect(matchesWorkFilters(item, { ...none, q: 'editor sync' }, 'u1')).toBe(false);
  });

  it('skips filters the row cannot answer', () => {
    expect(matchesWorkFilters({ title: 'Outage' }, { ...none, priority: '1', owner: 'me' }, null)).toBe(true);
  });

  it('builds combobox projects from repository counts', () => {
    expect(projectsFromCounts([{ repository: 'acme/a', count: 1 }, { repository: null, count: 4 }, { repository: 'acme/b', count: 2 }, { repository: 'acme/a', count: 2 }])
      .map((project) => [project.name, project.identifier, project.issueCount])).toEqual([['acme/a', 'a', 3], ['acme/b', 'b', 2]]);
  });
});
