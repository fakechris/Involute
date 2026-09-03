import type { Comment, Issue, Prisma, PrismaClient, WorkflowState } from '@prisma/client';

import {
  ASSIGNEE_NOT_FOUND_MESSAGE,
  COMMENT_NOT_FOUND_MESSAGE,
  createNotFoundError,
  createValidationError,
  ISSUE_LABEL_NOT_FOUND_MESSAGE,
  ISSUE_NOT_FOUND_MESSAGE,
  PARENT_ISSUE_CYCLE_MESSAGE,
  PARENT_ISSUE_NOT_FOUND_MESSAGE,
  PARENT_ISSUE_SELF_REFERENCE_MESSAGE,
  PARENT_ISSUE_TEAM_MISMATCH_MESSAGE,
  TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE,
  WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE,
  WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  PROJECT_NOT_FOUND_MESSAGE,
  CYCLE_NOT_FOUND_MESSAGE,
} from './errors.js';
import { assertActorCan, isAcceptStateType } from './claim-service.js';
import { assertNoWorkLinkCycle, syncContainsFromParentId } from './link-service.js';
import { orderWorkflowStates } from './workflow-state-order.js';
import {
  INTERNAL_WRITE_ACTOR,
  recordWorkAudit,
  claimIssueRevision,
  selectIssueSnapshot,
  type WriteActor,
} from './work-service.js';

export interface CreateIssueInput {
  acceptance?: string | null;
  commitmentStatus?: Issue['commitmentStatus'] | null;
  constraints?: string | null;
  cycleId?: string | null;
  description?: string | null;
  kind?: Issue['kind'] | null;
  outcome?: string | null;
  priority?: number | null;
  projectId?: string | null;
  repository?: string | null;
  scope?: string | null;
  stateId?: string | null;
  teamId: string;
  title: string;
  verification?: string | null;
}

export interface UpdateIssueInput {
  acceptance?: string | null;
  assigneeId?: string | null;
  constraints?: string | null;
  cycleId?: string | null;
  description?: string | null;
  expectedRevision?: number | null;
  labelIds?: string[] | null;
  outcome?: string | null;
  parentId?: string | null;
  priority?: number | null;
  projectId?: string | null;
  repository?: string | null;
  scope?: string | null;
  stateId?: string | null;
  title?: string | null;
  verification?: string | null;
}

export interface CreateCommentInput {
  body: string;
  issueId: string;
}

type WorkflowStateSelection = Pick<WorkflowState, 'id' | 'name' | 'teamId'>;
type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export async function createIssue(
  prisma: PrismaClient,
  input: CreateIssueInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  return prisma.$transaction((transaction) => createIssueInTransaction(transaction, input, actor));
}

export async function createIssueInTransaction(
  prisma: DatabaseClient,
  input: CreateIssueInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
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

  await assertProjectAndCycleTeam(prisma, input.teamId, input.projectId, input.cycleId);

  const state = await resolveCreateState(prisma, input.teamId, input.stateId);

  const updatedTeam = await prisma.team.update({
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

  const created = await prisma.issue.create({
      data: {
        acceptance: input.acceptance ?? null,
        commitmentStatus: input.commitmentStatus ?? 'COMMITTED',
        constraints: input.constraints ?? null,
        cycleId: input.cycleId ?? null,
        description: input.description ?? null,
        identifier: `${updatedTeam.key.toUpperCase()}-${updatedTeam.nextIssueNumber - 1}`,
        kind: input.kind ?? 'ISSUE',
        outcome: input.outcome ?? null,
        priority: input.priority ?? 0,
        projectId: input.projectId ?? null,
        repository: input.repository ?? null,
        scope: input.scope ?? null,
        stateId: state.id,
        teamId: input.teamId,
        title: input.title,
        verification: input.verification ?? null,
      },
    });

  await recordWorkAudit(prisma, {
      actor,
      after: selectIssueSnapshot(created),
      workId: created.id,
    });

  return created;
}

export async function updateIssue(
  prisma: PrismaClient,
  id: string,
  input: UpdateIssueInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  return prisma.$transaction(async (transaction) => {
    const existingIssue = await transaction.issue.findUnique({
      where: {
        id,
      },
    });

    if (!existingIssue) {
      throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    }

    // Agents shape candidate work via propose, but the committed contract is
    // human-owned: once COMMITTED, acceptance/scope/verification/outcome/
    // constraints can only be rewritten by a human (via commit or human update).
    if (actor.actorKind === 'AGENT' && existingIssue.commitmentStatus === 'COMMITTED') {
      const contractFields = ['acceptance', 'constraints', 'outcome', 'scope', 'verification'] as const;
      const rewritesContract = contractFields.some(
        (field) => field in input && input[field] !== undefined,
      );
      if (rewritesContract) {
        throw createValidationError(WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE);
      }
    }

    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== null &&
      existingIssue.revision !== input.expectedRevision
    ) {
      throw createValidationError(WORK_REVISION_CONFLICT_MESSAGE);
    }


    await assertProjectAndCycleTeam(
      transaction,
      existingIssue.teamId,
      input.projectId,
      input.cycleId,
    );

    let nextParentId: string | null | undefined;

    const data: Prisma.IssueUpdateInput = {};

    if ('stateId' in input && input.stateId) {
      const state = await transaction.workflowState.findUnique({
        where: {
          id: input.stateId,
        },
        select: {
          id: true,
          name: true,
          type: true,
          teamId: true,
        },
      });

      if (!state) {
        throw createNotFoundError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
      }

      if (state.teamId !== existingIssue.teamId) {
        throw createValidationError(WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE);
      }

      if (isAcceptStateType(state.type)) {
        assertActorCan(actor.actorKind, 'accept');
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

    if ('priority' in input && input.priority !== undefined && input.priority !== null) {
      data.priority = input.priority;
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
        nextParentId = null;
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

        await assertNoParentCycle(transaction, id, parentIssue.id);
        await assertNoWorkLinkCycle(transaction, 'CONTAINS', parentIssue.id, id);

        nextParentId = parentIssue.id;
        data.parent = {
          connect: {
            id: parentIssue.id,
          },
        };
      }
    }

    if ('projectId' in input) {
      if (input.projectId === null) {
        data.project = { disconnect: true };
      } else if (input.projectId !== undefined) {
        data.project = { connect: { id: input.projectId } };
      }
    }

    if ('cycleId' in input) {
      if (input.cycleId === null) {
        data.cycle = { disconnect: true };
      } else if (input.cycleId !== undefined) {
        data.cycle = { connect: { id: input.cycleId } };
      }
    }

    if ('acceptance' in input) {
      data.acceptance = input.acceptance ?? null;
    }

    if ('constraints' in input) {
      data.constraints = input.constraints ?? null;
    }

    if ('outcome' in input) {
      data.outcome = input.outcome ?? null;
    }

    if ('scope' in input) {
      data.scope = input.scope ?? null;
    }

    if ('verification' in input) {
      data.verification = input.verification ?? null;
    }

    if ('repository' in input) {
      data.repository = input.repository ?? null;
    }

    if (Object.keys(data).length === 0) {
      return existingIssue;
    }

    if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
      await claimIssueRevision(transaction, id, input.expectedRevision);
    } else {
      data.revision = { increment: 1 };
    }

    const updated = await transaction.issue.update({
      where: {
        id,
      },
      data,
    });

    if (nextParentId !== undefined) {
      await syncContainsFromParentId(transaction, id, nextParentId, actor);
    }

    await recordWorkAudit(transaction, {
      actor,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(existingIssue),
      workId: id,
    });

    return updated;
  });
}

async function assertProjectAndCycleTeam(
  prisma: DatabaseClient,
  teamId: string,
  projectId: string | null | undefined,
  cycleId: string | null | undefined,
): Promise<void> {
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, teamId },
      select: { id: true },
    });
    if (!project) throw createNotFoundError(PROJECT_NOT_FOUND_MESSAGE);
  }
  if (cycleId) {
    const cycle = await prisma.cycle.findFirst({
      where: { id: cycleId, teamId },
      select: { id: true },
    });
    if (!cycle) throw createNotFoundError(CYCLE_NOT_FOUND_MESSAGE);
  }
}

async function assertNoParentCycle(
  prisma: Prisma.TransactionClient,
  issueId: string,
  parentIssueId: string,
): Promise<void> {
  let currentParentId: string | null = parentIssueId;
  const visitedIssueIds = new Set<string>();

  while (currentParentId) {
    if (currentParentId === issueId || visitedIssueIds.has(currentParentId)) {
      throw createValidationError(PARENT_ISSUE_CYCLE_MESSAGE);
    }

    visitedIssueIds.add(currentParentId);

    const currentParent: { parentId: string | null } | null = await prisma.issue.findUnique({
      where: {
        id: currentParentId,
      },
      select: {
        parentId: true,
      },
    });

    currentParentId = currentParent?.parentId ?? null;
  }
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
