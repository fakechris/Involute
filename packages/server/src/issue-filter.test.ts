import { describe, expect, it } from 'vitest';

import { buildIssueWhere } from './issue-filter.ts';

describe('buildIssueWhere', () => {
  it('matches the numeric prefix and intersects all selected labels', () => {
    expect(buildIssueWhere({ text: '671', labelIds: ['a', 'b'] }, null)).toEqual({ AND: [
      { identifier: { contains: '-671' } },
      { labels: { some: { id: 'a' } } },
      { labels: { some: { id: 'b' } } },
    ] });
  });

  it('combines people and unassigned with OR, and states with AND', () => {
    expect(buildIssueWhere({ stateIds: ['ready'], assigneeIds: ['person', 'unassigned'] }, null)).toEqual({ AND: [
      { stateId: { in: ['ready'] } },
      { OR: [{ assigneeId: { in: ['person'] } }, { assigneeId: null }] },
    ] });
  });

  it('filters by commitment status so the board can project committed work only', () => {
    expect(buildIssueWhere({ commitmentStatus: 'COMMITTED' }, null)).toEqual({
      AND: [{ supersededById: null }, { commitmentStatus: 'COMMITTED' }],
    });
    expect(buildIssueWhere({ commitmentStatus: 'COMMITTED', includeSuperseded: true }, null)).toEqual({ commitmentStatus: 'COMMITTED' });
  });

  it('combines commitment status with a team key', () => {
    expect(
      buildIssueWhere(
        {
          commitmentStatus: 'CANDIDATE',
          team: { key: { eq: 'INV' } },
        },
        null,
      ),
    ).toEqual({
      AND: [
        { supersededById: null },
        {
          team: {
            is: {
              key: 'INV',
            },
          },
        },
        {
          commitmentStatus: 'CANDIDATE',
        },
      ],
    });
  });
});
