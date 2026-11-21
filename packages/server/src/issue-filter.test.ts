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
    // Only a delivery merge's own marker hides an item, never a DUPLICATE_OF link (INV-2005).
    expect(buildIssueWhere({ commitmentStatus: 'COMMITTED' }, null)).toEqual({
      AND: [{ OR: [{ supersededById: null }, { deliveryMergedAt: null }] }, { commitmentStatus: 'COMMITTED' }],
    });
    expect(buildIssueWhere({ commitmentStatus: 'COMMITTED', includeSuperseded: true }, null)).toEqual({ commitmentStatus: 'COMMITTED' });
    // Looking an item up by its number finds a hidden merge source too.
    for (const text of ['1979', 'INV-1979', 'inv-1979']) {
      expect(JSON.stringify(buildIssueWhere({ commitmentStatus: 'COMMITTED', text }, null))).not.toContain('deliveryMergedAt');
    }
    expect(JSON.stringify(buildIssueWhere({ commitmentStatus: 'COMMITTED', text: 'login bug' }, null))).toContain('deliveryMergedAt');
    // Wherever the number and the status sit in a conjunction.
    expect(JSON.stringify(buildIssueWhere({ commitmentStatus: 'COMMITTED', and: [{ text: 'INV-1979' }] }, null))).not.toContain('deliveryMergedAt');
    expect(JSON.stringify(buildIssueWhere({ text: '1979', and: [{ commitmentStatus: 'COMMITTED' }] }, null))).not.toContain('deliveryMergedAt');
  });

  it('matches free-text against the repository so a repo fragment finds the project (INV-1430)', () => {
    expect(buildIssueWhere({ text: 'meituan' }, null)).toEqual({ OR: [
      { identifier: { contains: 'meituan', mode: 'insensitive' } },
      { title: { contains: 'meituan', mode: 'insensitive' } },
      { description: { contains: 'meituan', mode: 'insensitive' } },
      { parent: { is: { OR: [
        { title: { contains: 'meituan', mode: 'insensitive' } },
        { identifier: { contains: 'meituan', mode: 'insensitive' } },
      ] } } },
      { project: { is: { name: { contains: 'meituan', mode: 'insensitive' } } } },
      { repository: { contains: 'meituan', mode: 'insensitive' } },
    ] });
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
        { OR: [{ supersededById: null }, { deliveryMergedAt: null }] },
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
