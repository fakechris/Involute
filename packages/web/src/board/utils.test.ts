import { describe, expect, it } from 'vitest';

import { buildCommittedIssueFilter, getBoardColumns } from './utils';
import type { IssueSummary, TeamSummary, WorkflowStateSummary } from './types';

function makeState(
  id: string,
  name: string,
  type: WorkflowStateSummary['type'],
  position = 0,
): WorkflowStateSummary {
  return { id, name, type, position };
}

function makeTeam(states: WorkflowStateSummary[]): TeamSummary {
  return {
    id: 'team-1',
    key: 'SON',
    name: 'Son',
    states: { nodes: states },
  };
}

function makeIssue(id: string, state: WorkflowStateSummary): IssueSummary {
  return {
    id,
    identifier: 'SON-1',
    revision: 1,
    title: 'Issue',
    priority: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    state,
    team: { id: 'team-1', key: 'SON' },
    labels: { nodes: [] },
    assignee: null,
    children: { nodes: [] },
    comments: { nodes: [] },
  };
}

describe('getBoardColumns', () => {
  it('orders columns by state group before name', () => {
    const team = makeTeam([
      makeState('s-shipped', 'Shipped', 'COMPLETED', 9),
      makeState('s-uat', 'UAT', 'REVIEW', 0),
      makeState('s-in-dev', 'In Development', 'STARTED', 3),
      makeState('s-idea', 'Idea', 'BACKLOG', 0),
      makeState('s-archived', 'Archived', 'CANCELED', 0),
    ]);

    const columns = getBoardColumns(team, []);

    expect(columns.map((column) => column.name)).toEqual([
      'Idea',
      'In Development',
      'UAT',
      'Shipped',
      'Archived',
    ]);
  });

  it('falls back to position then name inside the same group', () => {
    const team = makeTeam([
      makeState('s-b', 'Beta', 'STARTED', 2),
      makeState('s-c', 'Charlie', 'STARTED', 2),
      makeState('s-a', 'Alpha', 'STARTED', 1),
    ]);

    const columns = getBoardColumns(team, []);

    expect(columns.map((column) => column.name)).toEqual(['Alpha', 'Beta', 'Charlie']);
  });

  it('keeps states only seen on issues after team states of the same group', () => {
    const team = makeTeam([makeState('s-ready', 'Ready', 'UNSTARTED', 1)]);
    const issueState = makeState('s-custom', 'Custom Started', 'STARTED', 0);
    const columns = getBoardColumns(team, [makeIssue('issue-1', issueState)]);

    expect(columns.map((column) => column.stateId)).toEqual(['s-ready', 's-custom']);
  });
});

describe('buildCommittedIssueFilter', () => {
  it('builds basic committed filter without team or repository', () => {
    expect(buildCommittedIssueFilter(null)).toEqual({
      commitmentStatus: 'COMMITTED',
    });
  });

  it('builds committed filter with team key', () => {
    expect(buildCommittedIssueFilter('INV')).toEqual({
      commitmentStatus: 'COMMITTED',
      team: {
        key: {
          eq: 'INV',
        },
      },
    });
  });

  it('builds committed filter with team and repository eq filter', () => {
    expect(buildCommittedIssueFilter('INV', { eq: 'fakechris/moyu-badge' })).toEqual({
      commitmentStatus: 'COMMITTED',
      team: {
        key: {
          eq: 'INV',
        },
      },
      repository: {
        eq: 'fakechris/moyu-badge',
      },
    });
  });

  it('builds committed filter with repository isNull filter for orphans', () => {
    expect(buildCommittedIssueFilter('INV', { isNull: true })).toEqual({
      commitmentStatus: 'COMMITTED',
      team: {
        key: {
          eq: 'INV',
        },
      },
      repository: {
        isNull: true,
      },
    });
  });
});
