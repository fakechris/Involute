import type { Issue, PrismaClient, WorkflowState } from '@prisma/client';

import { DEFAULT_WORKFLOW_STATE_ORDER } from './constants.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
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
  stateId?: string | null;
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
  const existingIssue = await prisma.issue.findUnique({
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

  if (input.stateId === undefined || input.stateId === null) {
    return prisma.issue.findUniqueOrThrow({
      where: {
        id,
      },
    });
  }

  const state = await prisma.workflowState.findUnique({
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

  return prisma.issue.update({
    where: {
      id,
    },
    data: {
      stateId: state.id,
    },
  });
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
