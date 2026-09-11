import { describe, expect, it } from 'vitest';

import { applyBoardViewState, getDefaultBoardViewState, groupIssuesBy } from './views';
import type { IssueSummary, WorkflowStateSummary } from './types';

function makeState(id: string, name: string, type: WorkflowStateSummary['type'] = 'UNSTARTED'): WorkflowStateSummary {
  return { id, name, type, position: 0 };
}

function makeIssue(
  id: string,
  repository: string | null,
  title = 'Issue',
  overrides: Partial<IssueSummary> = {},
): IssueSummary {
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
    ...overrides,
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

describe('board sorting', () => {
  it('defaults to updatedAt descending so the most recently active issues come first', () => {
    const state = getDefaultBoardViewState();
    expect(state.sortField).toBe('updatedAt');
    expect(state.sortDirection).toBe('desc');

    const issues = [
      makeIssue('1', null, 'Stale', { updatedAt: '2026-01-01T00:00:00Z' }),
      makeIssue('2', null, 'Fresh', { updatedAt: '2026-09-01T00:00:00Z' }),
    ];

    const sorted = applyBoardViewState(issues, state, []);
    expect(sorted.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('sorts by priority with urgent first and no-priority sinking, ties broken by identifier', () => {
    const state = { ...getDefaultBoardViewState(), sortField: 'priority' as const, sortDirection: 'asc' as const };
    const issues = [
      makeIssue('30', null, 'No priority'),
      makeIssue('10', null, 'Low', { priority: 4 }),
      makeIssue('20', null, 'Urgent B', { priority: 1 }),
      makeIssue('5', null, 'Urgent A', { priority: 1 }),
    ];

    const sorted = applyBoardViewState(issues, state, []);
    expect(sorted.map((i) => i.identifier)).toEqual(['INV-5', 'INV-20', 'INV-10', 'INV-30']);
  });

  it('keeps a stable identifier order when updatedAt values tie', () => {
    const state = getDefaultBoardViewState(); // desc direction flips the tiebreak too
    const issues = [
      makeIssue('3', null, 'A'),
      makeIssue('20', null, 'B'),
    ];

    const sorted = applyBoardViewState(issues, state, []);
    expect(sorted.map((i) => i.identifier)).toEqual(['INV-20', 'INV-3']);

    const ascending = applyBoardViewState(issues, { ...state, sortDirection: 'asc' }, []);
    expect(ascending.map((i) => i.identifier)).toEqual(['INV-3', 'INV-20']);
  });
});
