import { describe, expect, it } from 'vitest';

import { buildIssueWhere } from './issue-filter.ts';

describe('buildIssueWhere', () => {
  it('filters by commitment status so the board can project committed work only', () => {
    expect(buildIssueWhere({ commitmentStatus: 'COMMITTED' }, null)).toEqual({
      commitmentStatus: 'COMMITTED',
    });
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
