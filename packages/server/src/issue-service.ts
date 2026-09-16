import type { Comment, Issue, Prisma, PrismaClient, WorkflowState } from '@prisma/client';

import {
  ASSIGNEE_NOT_FOUND_MESSAGE,
  COMMENT_NOT_FOUND_MESSAGE,
  COMMENT_PARENT_ISSUE_MISMATCH_MESSAGE,
  createNotFoundError,
  createValidationError,
  ISSUE_LABEL_NOT_FOUND_MESSAGE,
  ISSUE_NOT_FOUND_MESSAGE,
  PARENT_ISSUE_CYCLE_MESSAGE,
  PARENT_ISSUE_NOT_FOUND_MESSAGE,
  PARENT_ISSUE_SELF_REFERENCE_MESSAGE,
  PARENT_ISSUE_TEAM_MISMATCH_MESSAGE,
  SNOOZE_REQUIRES_CANDIDATE_MESSAGE,
  TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE,
  WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE,
  WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  PROJECT_NOT_FOUND_MESSAGE,
  CYCLE_NOT_FOUND_MESSAGE,
  AGENT_DESCRIPTION_REQUIRED_MESSAGE,
} from './errors.js';
import { assertActorCan, isAcceptStateType, sanitizeWorkTitle, validateAgentDescription } from './claim-service.js';
import { assertNoWorkLinkCycle, syncContainsFromParentId } from './link-service.js';
import { syncCommentMentions } from './mention-service.js';
import { enqueueCommentEvents } from './comment-events.js';
import { openAgentRequestsForMentions } from './agent-request-from-mention.js';
import { assertNodeHierarchy, getContainsDescendantIds, lockWorkGraph } from './graph-integrity.js';
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
  assigneeId?: string | null;
  commitmentStatus?: Issue['commitmentStatus'] | null;
  constraints?: string | null;
  cycleId?: string | null;
  description?: string | null;
  kind?: Issue['kind'] | null;
  labelIds?: string[] | null;
  outcome?: string | null;
  parentId?: string | null;
  priority?: number | null;
  projectId?: string | null;
  repository?: string | null;
  scope?: string | null;
  source?: string | null;
  stateId?: string | null;
  teamId: string;
  title: string;
  verification?: string | null;
}

export interface UpdateIssueInput {
  acceptance?: string | null;
  alias?: string | null;
  assigneeId?: string | null;
  cascadeRepository?: boolean | null;
  constraints?: string | null;
  cycleId?: string | null;
  description?: string | null;
  expectedRevision?: number | null;
  kind?: Issue['kind'] | null;
  labelIds?: string[] | null;
  outcome?: string | null;
  parentId?: string | null;
  priority?: number | null;
  projectId?: string | null;
  repository?: string | null;
  scope?: string | null;
  snoozedUntil?: Date | null;
  stateId?: string | null;
  title?: string | null;
  verification?: string | null;
}

export interface CreateCommentInput {
  body: string;
  issueId: string;
  /** Reply into an existing thread. Must be a comment on the same work item. */
  parentCommentId?: string | null;
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
  if ('$transaction' in prisma) return prisma.$transaction(tx => createIssueInTransaction(tx, input, actor));
  await lockWorkGraph(prisma, input.teamId);
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

  let labelConnect: Array<{ id: string }> | undefined;
  if (input.labelIds !== undefined && input.labelIds !== null) {
    const labelIds = [...new Set(input.labelIds)];

    if (labelIds.length > 0) {
      const labels = await prisma.issueLabel.findMany({
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

    labelConnect = labelIds.map((labelId) => ({ id: labelId }));
  }

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
        assigneeId: input.assigneeId ?? null,
        commitmentStatus: input.commitmentStatus ?? 'COMMITTED',
        constraints: input.constraints ?? null,
        cycleId: input.cycleId ?? null,
        description: input.description ?? null,
        identifier: `${updatedTeam.key.toUpperCase()}-${updatedTeam.nextIssueNumber - 1}`,
        kind: input.kind ?? 'ISSUE',
        outcome: input.outcome ?? null,
        parentId: input.parentId ?? null,
        priority: input.priority ?? 0,
        projectId: input.projectId ?? null,
        repository: input.repository ?? null,
        scope: input.scope ?? null,
        source: input.source ?? null,
        stateId: state.id,
        teamId: input.teamId,
        title: input.title,
        verification: input.verification ?? null,
        ...(labelConnect ? { labels: { connect: labelConnect } } : {}),
      },
    });

  await syncContainsFromParentId(prisma, created.id, created.parentId, actor);
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
    const hint = await transaction.issue.findUnique({ where: { id }, select: { teamId: true } });
    if (!hint) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    await lockWorkGraph(transaction, hint.teamId);
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
      data.title = sanitizeWorkTitle(input.title).title;
    }

    if ('description' in input) {
      if (existingIssue.commitmentStatus === 'CANDIDATE' && actor.actorKind === 'AGENT') {
        validateAgentDescription(input.description, actor);
      } else if (input.description && /^ref\s*:?\s*docs\//i.test(input.description.trim())) {
        throw createValidationError(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
      }
      data.description = input.description ?? null;
    }

    if ('priority' in input && input.priority !== undefined && input.priority !== null) {
      data.priority = input.priority;
    }

    // Snooze is candidate-pool governance: committed work has a human owner
    // and a delivery contract, so pausing it silently would be wrong.
    if ('snoozedUntil' in input) {
      if (input.snoozedUntil && existingIssue.commitmentStatus !== 'CANDIDATE') {
        throw createValidationError(SNOOZE_REQUIRES_CANDIDATE_MESSAGE);
      }
      data.snoozedUntil = input.snoozedUntil ?? null;
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

    if ('alias' in input) {
      data.alias = input.alias ?? null;
    }

    if ('kind' in input && input.kind) {
      data.kind = input.kind;
    }

    const nextRepository = 'repository' in input ? input.repository ?? null : existingIssue.repository;
    const repositoryChanged = 'repository' in input && nextRepository !== existingIssue.repository;

    if (repositoryChanged && input.cascadeRepository) {
      const descendantIds = await getContainsDescendantIds(transaction, id);
      if (descendantIds.length > 0) {
        const descendantIssues = await transaction.issue.findMany({
          where: { id: { in: descendantIds } },
        });
        await transaction.issue.updateMany({
          where: { id: { in: descendantIds } },
          data: {
            repository: nextRepository,
            revision: { increment: 1 },
          },
        });
        await transaction.workRun.updateMany({
          where: { workId: { in: descendantIds } },
          data: { repository: nextRepository },
        });
        for (const descendant of descendantIssues) {
          await recordWorkAudit(transaction, {
            actor,
            after: selectIssueSnapshot({
              ...descendant,
              repository: nextRepository,
              revision: descendant.revision + 1,
            }),
            before: selectIssueSnapshot(descendant),
            workId: descendant.id,
          });
        }
      }
      await transaction.workRun.updateMany({
        where: { workId: id },
        data: { repository: nextRepository },
      });
    }

    if (nextParentId !== undefined || 'repository' in input || 'kind' in input) {
      await assertNodeHierarchy(transaction, {
        ...existingIssue,
        parentId: nextParentId === undefined ? existingIssue.parentId : nextParentId,
        repository: nextRepository,
        kind: input.kind ?? existingIssue.kind,
      }, nextParentId !== undefined);
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
      identifier: true,
    },
  });

  if (!issue) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  const parentCommentId = await resolveThreadParent(prisma, input, issue.id);

  // The comment, its resolved mentions and its events land together
  // (INV-558 / INV-559): a consumer must never observe a comment whose `@`s
  // have not been turned into actorIds yet, and an event must never announce a
  // comment that a crash then rolled back.
  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: {
        body: input.body,
        issueId: input.issueId,
        parentCommentId,
        userId,
      },
    });

    const mentions = await syncCommentMentions(tx, comment.id, comment.body);
    const requestIdByActorId = await openAgentRequestsForMentions(tx, {
      comment,
      mentions,
      workId: issue.id,
    });

    await enqueueCommentEvents(tx, {
      comment,
      mentions,
      requestIdByActorId,
      work: issue,
    });

    return comment;
  });
}

/**
 * Normalizes a reply target to a thread root (INV-561).
 *
 * Threads are one level deep on purpose: replying to a reply attaches to the
 * same root, so every comment has exactly one unambiguous `rootCommentId` and
 * an `AgentRequest` anchored to it stays anchored. Arbitrary nesting would make
 * "which thread is this request on" a tree walk, and two parallel questions on
 * one work item would be able to drift into each other.
 */
async function resolveThreadParent(
  prisma: PrismaClient,
  input: CreateCommentInput,
  issueId: string,
): Promise<string | null> {
  if (!input.parentCommentId) {
    return null;
  }

  const parent = await prisma.comment.findUnique({
    where: { id: input.parentCommentId },
    select: { id: true, issueId: true, parentCommentId: true },
  });

  if (!parent) {
    throw createNotFoundError(COMMENT_NOT_FOUND_MESSAGE);
  }

  // A thread belongs to one work item. Replying across work items would let a
  // request anchored on one item be answered on another.
  if (parent.issueId !== issueId) {
    throw createValidationError(COMMENT_PARENT_ISSUE_MISMATCH_MESSAGE);
  }

  return parent.parentCommentId ?? parent.id;
}

export async function deleteIssue(
  prisma: PrismaClient,
  id: string,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Pick<Issue, 'id'>> {
  return prisma.$transaction(async tx => {
    const hint = await tx.issue.findUnique({ where: { id }, select: { teamId: true } });
    if (!hint) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    await lockWorkGraph(tx, hint.teamId);
    const issue = await tx.issue.findUnique({ where: { id }, select: { id: true } });
    if (!issue) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    const children = await tx.issue.findMany({ where: { parentId: id } });
    for (const child of children) {
      const after = await tx.issue.update({ where: { id: child.id }, data: { parentId: null, revision: { increment: 1 } } });
      await recordWorkAudit(tx, { actor, before: selectIssueSnapshot(child), after: selectIssueSnapshot(after), workId: child.id });
    }
    await tx.issue.delete({ where: { id } });
    return issue;
  });
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
      type: true,
      position: true,
    },
  });

  const initialState = orderWorkflowStates(states)[0];

  if (!initialState) {
    throw createValidationError(TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE);
  }

  return initialState;
}
