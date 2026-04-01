import type { Prisma } from '@prisma/client';

export interface StringComparatorInput {
  eq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
}

export interface BooleanComparatorInput {
  eq?: boolean | null;
}

export interface TeamFilterInput {
  key?: StringComparatorInput | null;
}

export interface WorkflowStateFilterRefInput {
  name?: StringComparatorInput | null;
}

export interface UserFilterRefInput {
  isMe?: BooleanComparatorInput | null;
}

export interface IssueLabelFilterRefInput {
  name?: StringComparatorInput | null;
}

export interface IssueLabelRelationFilterInput {
  every?: IssueLabelFilterRefInput | null;
  some?: IssueLabelFilterRefInput | null;
}

export interface IssueFilterInput {
  and?: IssueFilterInput[] | null;
  assignee?: UserFilterRefInput | null;
  labels?: IssueLabelRelationFilterInput | null;
  state?: WorkflowStateFilterRefInput | null;
  team?: TeamFilterInput | null;
}

export function buildIssueWhere(
  filter: IssueFilterInput | null | undefined,
  viewerId: string | null,
): Prisma.IssueWhereInput | undefined {
  const clauses: Prisma.IssueWhereInput[] = [];

  if (filter?.and) {
    for (const nestedFilter of filter.and) {
      const nestedWhere = buildIssueWhere(nestedFilter, viewerId);

      if (nestedWhere) {
        clauses.push(nestedWhere);
      }
    }
  }

  const teamKey = filter?.team?.key?.eq;

  if (teamKey !== undefined && teamKey !== null) {
    clauses.push({
      team: {
        is: {
          key: teamKey,
        },
      },
    });
  }

  const stateName = filter?.state?.name?.eq;

  if (stateName !== undefined && stateName !== null) {
    clauses.push({
      state: {
        is: {
          name: stateName,
        },
      },
    });
  }

  const assigneeIsMe = filter?.assignee?.isMe?.eq;

  if (assigneeIsMe === true) {
    clauses.push(
      viewerId
        ? {
            assigneeId: viewerId,
          }
        : {
            id: {
              in: [],
            },
          },
    );
  } else if (assigneeIsMe === false && viewerId) {
    clauses.push({
      NOT: {
        assigneeId: viewerId,
      },
    });
  }

  const someLabelNames = filter?.labels?.some?.name?.in;

  if (someLabelNames !== undefined && someLabelNames !== null) {
    clauses.push({
      labels: {
        some: {
          name: {
            in: someLabelNames,
          },
        },
      },
    });
  }

  const excludedLabelNames = filter?.labels?.every?.name?.nin;

  if (excludedLabelNames !== undefined && excludedLabelNames !== null) {
    clauses.push({
      labels: {
        every: {
          name: {
            notIn: excludedLabelNames,
          },
        },
      },
    });
  }

  if (clauses.length === 0) {
    return undefined;
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return {
    AND: clauses,
  };
}
