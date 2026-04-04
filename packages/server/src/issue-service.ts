import type { Comment, Issue, Prisma, PrismaClient, WorkflowState } from '@prisma/client';

import { DEFAULT_WORKFLOW_STATE_ORDER } from './constants.js';
import {
  ASSIGNEE_NOT_FOUND_MESSAGE,
  COMMENT_NOT_FOUND_MESSAGE,
  createNotFoundError,
  createValidationError,
  ISSUE_LABEL_NOT_FOUND_MESSAGE,
  ISSUE_NOT_FOUND_MESSAGE,
  PARENT_ISSUE_NOT_FOUND_MESSAGE,
  PARENT_ISSUE_SELF_REFERENCE_MESSAGE,
  PARENT_ISSUE_TEAM_MISMATCH_MESSAGE,
  TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE,
  WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE,
} from './errors.js';

export interface CreateIssueInput {
  description?: string | null;
  stateId?: string | null;
  teamId: string;
  title: string;
}

export interface UpdateIssueInput {
  assigneeId?: string | null;
  description?: string | null;
  labelIds?: string[] | null;
  parentId?: string | null;
  stateId?: string | null;
  title?: string | null;
}

export interface CreateCommentInput {
  body: string;
  issueId: string;
}

type WorkflowStateSelection = Pick<WorkflowState, 'id' | 'name' | 'teamId'>;

const workflowStateOrder = new Map<string, number>(
  DEFAULT_WORKFLOW_STATE_ORDER.map((name, index) => [name, index] as const),
);

export async function createIssue(
  prisma: PrismaClient,
  input: CreateIssueInput,
): Promise<Issue> {
  const team = await prisma.team.findUnique({
    where: {
      id: input.teamId,
    },
    select: {
      id: true,
    },
  });

  if (!team) {
    throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  }

  const state = await resolveCreateState(prisma, input.teamId, input.stateId);

  return prisma.$transaction(async (transaction) => {
    const updatedTeam = await transaction.team.update({
      where: {
        id: input.teamId,
      },
      data: {
        nextIssueNumber: {
          increment: 1,
        },
      },
      select: {
        key: true,
        nextIssueNumber: true,
      },
    });

    return transaction.issue.create({
      data: {
        identifier: `${updatedTeam.key.toUpperCase()}-${updatedTeam.nextIssueNumber - 1}`,
        title: input.title,
        description: input.description ?? null,
        stateId: state.id,
        teamId: input.teamId,
      },
    });
  });
}

export async function updateIssue(
  prisma: PrismaClient,
  id: string,
  input: UpdateIssueInput,
): Promise<Issue> {
  return prisma.$transaction(async (transaction) => {
    const existingIssue = await transaction.issue.findUnique({
      where: {
        id,
      },
      select: {
        id: true,
        teamId: true,
      },
    });

    if (!existingIssue) {
      throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    }

    const data: Prisma.IssueUpdateInput = {};

    if ('stateId' in input && input.stateId) {
      const state = await transaction.workflowState.findUnique({
        where: {
          id: input.stateId,
        },
        select: {
          id: true,
          teamId: true,
        },
      });

      if (!state) {
        throw createNotFoundError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
      }

      if (state.teamId !== existingIssue.teamId) {
        throw createValidationError(WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE);
      }

      data.state = {
        connect: {
          id: state.id,
        },
      };
    }

    if ('title' in input && input.title !== undefined && input.title !== null) {
      data.title = input.title;
    }

    if ('description' in input) {
      data.description = input.description ?? null;
    }

    if ('assigneeId' in input) {
      if (input.assigneeId === null) {
        data.assignee = {
          disconnect: true,
        };
      } else if (input.assigneeId !== undefined) {
        const assignee = await transaction.user.findUnique({
          where: {
            id: input.assigneeId,
          },
          select: {
            id: true,
          },
        });

        if (!assignee) {
          throw createNotFoundError(ASSIGNEE_NOT_FOUND_MESSAGE);
        }

        data.assignee = {
          connect: {
            id: assignee.id,
          },
        };
      }
    }

    if ('labelIds' in input && input.labelIds !== null && input.labelIds !== undefined) {
      const labelIds = [...new Set(input.labelIds)];

      if (labelIds.length > 0) {
        const labels = await transaction.issueLabel.findMany({
          where: {
            id: {
              in: labelIds,
            },
          },
          select: {
            id: true,
          },
        });

        if (labels.length !== labelIds.length) {
          throw createNotFoundError(ISSUE_LABEL_NOT_FOUND_MESSAGE);
        }
      }

      data.labels = {
        set: labelIds.map((labelId) => ({ id: labelId })),
      };
    }

    if ('parentId' in input) {
      if (input.parentId === null) {
        data.parent = {
          disconnect: true,
        };
      } else if (input.parentId !== undefined) {
        if (input.parentId === id) {
          throw createValidationError(PARENT_ISSUE_SELF_REFERENCE_MESSAGE);
        }

        const parentIssue = await transaction.issue.findUnique({
          where: {
            id: input.parentId,
          },
          select: {
            id: true,
            teamId: true,
          },
        });

        if (!parentIssue) {
          throw createNotFoundError(PARENT_ISSUE_NOT_FOUND_MESSAGE);
        }

        if (parentIssue.teamId !== existingIssue.teamId) {
          throw createValidationError(PARENT_ISSUE_TEAM_MISMATCH_MESSAGE);
        }

        data.parent = {
          connect: {
            id: parentIssue.id,
          },
        };
      }
    }

    if (Object.keys(data).length === 0) {
      return transaction.issue.findUniqueOrThrow({
        where: {
          id,
        },
      });
    }

    return transaction.issue.update({
      where: {
        id,
      },
      data,
    });
  });
}

export async function createComment(
  prisma: PrismaClient,
  input: CreateCommentInput,
  userId: string,
): Promise<Comment> {
  const issue = await prisma.issue.findUnique({
    where: {
      id: input.issueId,
    },
    select: {
      id: true,
    },
  });

  if (!issue) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  return prisma.comment.create({
    data: {
      body: input.body,
      issueId: input.issueId,
      userId,
    },
  });
}

export async function deleteIssue(
  prisma: PrismaClient,
  id: string,
): Promise<Pick<Issue, 'id'>> {
  const issue = await prisma.issue.findUnique({
    where: {
      id,
    },
    select: {
      id: true,
    },
  });

  if (!issue) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  await prisma.issue.delete({
    where: {
      id,
    },
  });

  return issue;
}

export async function deleteComment(
  prisma: PrismaClient,
  id: string,
): Promise<Pick<Comment, 'id'>> {
  const comment = await prisma.comment.findUnique({
    where: {
      id,
    },
    select: {
      id: true,
    },
  });

  if (!comment) {
    throw createNotFoundError(COMMENT_NOT_FOUND_MESSAGE);
  }

  await prisma.comment.delete({
    where: {
      id,
    },
  });

  return comment;
}

async function resolveCreateState(
  prisma: Pick<PrismaClient, 'workflowState'>,
  teamId: string,
  stateId: string | null | undefined,
): Promise<WorkflowStateSelection> {
  if (stateId) {
    const selectedState = await prisma.workflowState.findUnique({
      where: {
        id: stateId,
      },
      select: {
        id: true,
        name: true,
        teamId: true,
      },
    });

    if (!selectedState) {
      throw createNotFoundError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
    }

    if (selectedState.teamId !== teamId) {
      throw createValidationError(WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE);
    }

    return selectedState;
  }

  const states = await prisma.workflowState.findMany({
    where: {
      teamId,
    },
    select: {
      id: true,
      name: true,
      teamId: true,
    },
  });

  const initialState = orderWorkflowStates(states)[0];

  if (!initialState) {
    throw createValidationError(TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE);
  }

  return initialState;
}

function orderWorkflowStates(states: WorkflowStateSelection[]): WorkflowStateSelection[] {
  return [...states].sort((left, right) => {
    const leftOrder = workflowStateOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = workflowStateOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.name.localeCompare(right.name);
  });
}
