import { describe, expect, it } from 'vitest';

import { groupIssuesBy } from './views';
import type { IssueSummary, WorkflowStateSummary } from './types';

function makeState(id: string, name: string, type: WorkflowStateSummary['type'] = 'UNSTARTED'): WorkflowStateSummary {
  return { id, name, type, position: 0 };
}

function makeIssue(id: string, repository: string | null, title = 'Issue'): IssueSummary {
  return {
    id,
    identifier: `INV-${id}`,
    revision: 1,
    title,
    priority: 0,
    repository,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    state: makeState('state-1', 'Ready'),
    team: { id: 'team-1', key: 'INV' },
    labels: { nodes: [] },
    assignee: null,
    children: { nodes: [] },
    comments: { nodes: [] },
  };
}

describe('groupIssuesBy', () => {
  it('groups issues by project/repository in alphabetical order', () => {
    const issues = [
      makeIssue('1', 'fakechris/lumen-cut'),
      makeIssue('2', 'fakechris/QuantHarvest'),
      makeIssue('3', 'fakechris/Involute'),
      makeIssue('4', 'fakechris/QuantHarvest'),
    ];

    const groups = groupIssuesBy(issues, 'project', null, [], []);

    expect(groups.map((g) => g.label)).toEqual(['Involute', 'lumen-cut', 'QuantHarvest']);
    expect(groups.map((g) => g.meta?.repository)).toEqual([
      'fakechris/Involute',
      'fakechris/lumen-cut',
      'fakechris/QuantHarvest',
    ]);
    expect(groups[2]?.issues.map((i) => i.id)).toEqual(['2', '4']);
  });

  it('puts issues without a repository into a No Project group at the end', () => {
    const issues = [
      makeIssue('1', 'fakechris/Involute'),
      makeIssue('2', null),
      makeIssue('3', '   '),
    ];

    const groups = groupIssuesBy(issues, 'project', null, [], []);

    expect(groups.map((g) => g.label)).toEqual(['Involute', 'No Project']);
    expect(groups[1]?.id).toBe('project-none');
    expect(groups[1]?.meta?.repository).toBeNull();
    expect(groups[1]?.issues.map((i) => i.id)).toEqual(['2', '3']);
  });

  it('handles empty issues list cleanly when grouping by project', () => {
    const groups = groupIssuesBy([], 'project', null, [], []);
    expect(groups).toEqual([]);
  });
});
