import type { Issue, PrismaClient, WorkClaim, WorkRun } from '@prisma/client';

import { enqueueWorkEvent } from './inv11-hooks.js';
import {
  completeWorkIdempotency,
  hashIdempotencyRequest,
  reserveWorkIdempotency,
} from './idempotency.js';
import { projectWorkNotifications } from './notification-service.js';
import {
  createNotFoundError,
  createValidationError,
  WORK_CLAIM_REQUIRES_ACTOR_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE,
  WORK_RUN_NOT_FOUND_MESSAGE,
  WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE,
  WORK_RUN_ACTOR_MISMATCH_MESSAGE,
  WORK_RUN_TERMINAL_MESSAGE,
  WORK_RUN_TRANSITION_INVALID_MESSAGE,
  WORK_RUN_CONFLICT_MESSAGE,
  WORK_REVIEW_STATE_MISSING_MESSAGE,
} from './errors.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';
import {
  ALLOWED_RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  type DatabaseClient,
  type ReportRunInput,
  eventTypeForRun,
  findRun,
  nextRunPublicId,
  parseRunStatus,
  requireWork,
} from './run-service-shared.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reportRun(
  prisma: PrismaClient,
  input: ReportRunInput,
  actor: WriteActor,
): Promise<{ run: WorkRun; work: Issue }> {
  const actorId = actor.actorId;
  if (!actorId) throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);

  return prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, input.workId);
    let idempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'run_report',
        requestHash: hashIdempotencyRequest({ ...input, idempotencyKey: null }),
        teamId: work.teamId,
      });
      if (!reservation.created) {
        if (reservation.record.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
        }
        if (!reservation.record.resultId) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        const replayed = await transaction.workRun.findUnique({
          where: { id: reservation.record.resultId },
        });
        if (!replayed || replayed.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        const freshWork = await transaction.issue.findUniqueOrThrow({ where: { id: work.id } });
        return { run: replayed, work: freshWork };
      }
      idempotencyId = reservation.record.id;
    }

    const status = parseRunStatus(input.status);
    const isTerminalStatus = Boolean(status && TERMINAL_RUN_STATUSES.includes(status));
    let run = input.runId ? await findRun(transaction, input.runId, work.id) : null;
    let activeClaim: WorkClaim | null = null;

    // Constraint 3: Cross-scope runId must hard-fail if runId actually exists on another work or actor
    if (input.runId && !run) {
      const isInputUuid = UUID_PATTERN.test(input.runId);
      const crossRun = await transaction.workRun.findFirst({
        where: {
          OR: [
            { publicId: input.runId },
            ...(isInputUuid ? [{ id: input.runId }] : []),
          ],
        },
      });
      if (crossRun) {
        if (crossRun.workId !== work.id) {
          throw createValidationError(
            `Work run '${input.runId}' belongs to a different work item (${crossRun.workId}).`,
          );
        }
        if (crossRun.actorId !== actorId) {
          throw createValidationError(WORK_RUN_ACTOR_MISMATCH_MESSAGE);
        }
      }
    }

    // 2. Resolve Active Claim or Idempotent Completed Run
    if (!run) {
      // Check if input.runId was mistakenly passed as the claim ID
      if (input.runId && UUID_PATTERN.test(input.runId)) {
        const claimMatch = await transaction.workClaim.findFirst({
          where: {
            actorId,
            id: input.runId,
            workId: work.id,
            ...(isTerminalStatus ? {} : { leaseUntil: { gt: new Date() } }),
          },
        });
        if (claimMatch) {
          activeClaim = claimMatch;
        }
      }

      if (!activeClaim) {
        activeClaim = await transaction.workClaim.findFirst({
          where: {
            actorId,
            workId: work.id,
            ...(isTerminalStatus ? {} : { leaseUntil: { gt: new Date() } }),
          },
        });
      }

      if (activeClaim) {
        // Constraint 4: Row-level lock on WorkClaim to guarantee serialization under concurrent requests
        await transaction.$queryRaw`SELECT id FROM "WorkClaim" WHERE id = ${activeClaim.id}::uuid FOR UPDATE`;

        // Constraint 1: Check for existing open run under this claimId
        const openRun = await transaction.workRun.findFirst({
          where: {
            claimId: activeClaim.id,
            status: { in: ['QUEUED', 'RUNNING', 'BLOCKED'] },
          },
          orderBy: { startedAt: 'desc' },
        });

        if (openRun) {
          // Rebind to open run under this claim!
          run = openRun;
        }
      } else {
        // Constraint 2: Completed retry idempotency when claim has already been deleted
        if (status === 'COMPLETED' || (!status && input.runId)) {
          const recentCompletedRun = await transaction.workRun.findFirst({
            where: {
              actorId,
              status: 'COMPLETED',
              workId: work.id,
            },
            orderBy: { endedAt: 'desc' },
          });
          if (recentCompletedRun) {
            if (idempotencyId) {
              await completeWorkIdempotency(transaction, idempotencyId, work.id, recentCompletedRun.id);
            }
            return { run: recentCompletedRun, work };
          }
        }

        // If no active claim and not a completed retry:
        if (input.runId) {
          throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);
        } else {
          throw createValidationError(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
        }
      }
    }

    const isNew = !run;
    if (!run) {
      if (!activeClaim) throw createValidationError(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
      const publicId = await nextRunPublicId(transaction);
      run = await transaction.workRun.create({
        data: {
          actorId,
          baseRevision: work.revision,
          claimId: activeClaim.id,
          externalUrl: input.externalUrl ?? null,
          phase: input.phase ?? null,
          publicId,
          status: status ?? 'RUNNING',
          summary: input.summary ?? null,
          workId: work.id,
          ...(status && TERMINAL_RUN_STATUSES.includes(status) ? { endedAt: new Date() } : {}),
        },
      });
    } else {
      if (run.actorId !== actorId) {
        throw createValidationError(WORK_RUN_ACTOR_MISMATCH_MESSAGE);
      }
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        if (!status || status === run.status) {
          if (idempotencyId) {
            await completeWorkIdempotency(transaction, idempotencyId, work.id, run.id);
          }
          return { run, work };
        }
        throw createValidationError(WORK_RUN_TERMINAL_MESSAGE);
      }

      // Constraint 5: Lease expiration does not block terminal completed/failed updates
      if (!activeClaim) {
        if (!run.claimId) throw createValidationError(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
        activeClaim = await transaction.workClaim.findFirst({
          where: {
            actorId,
            id: run.claimId,
            workId: work.id,
            ...(isTerminalStatus ? {} : { leaseUntil: { gt: new Date() } }),
          },
        });
        if (!activeClaim) throw createValidationError(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
      }
      if (status && status !== run.status && !ALLOWED_RUN_TRANSITIONS[run.status].includes(status)) {
        throw createValidationError(WORK_RUN_TRANSITION_INVALID_MESSAGE);
      }
      const update = await transaction.workRun.updateMany({
        where: { id: run.id, updatedAt: run.updatedAt },
        data: {
          ...(status ? { status } : {}),
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
          ...(status && TERMINAL_RUN_STATUSES.includes(status) ? { endedAt: new Date() } : {}),
          ...(status === 'COMPLETED' ? { claimId: null } : {}),
        },
      });
      if (update.count !== 1) throw createValidationError(WORK_RUN_CONFLICT_MESSAGE);
      run = await transaction.workRun.findUniqueOrThrow({ where: { id: run.id } });
    }

    const eventType = eventTypeForRun(isNew, run.status, input.decisionRequested);
    let eventId: string | null = null;
    if (eventType) {
      const enqueued = await enqueueWorkEvent(transaction, {
        payload: {
          runId: run.id,
          publicId: run.publicId,
          status: run.status,
          phase: run.phase,
          summary: run.summary,
          externalUrl: run.externalUrl,
        },
        type: eventType,
        workId: work.id,
        workIdentifier: work.identifier,
      });
      eventId = enqueued.id;
    }

    let nextWork = work;
    if (run.status === 'RUNNING') {
      nextWork = await moveToInProgress(transaction, work);
    } else if (run.status === 'COMPLETED') {
      nextWork = await moveToInReview(transaction, work, actor);
      if (activeClaim) {
        await transaction.workClaim.deleteMany({ where: { id: activeClaim.id } });
      }
    }

    // Human gate: when an attempt finishes (or explicitly asks for a
    // decision), the human assignee — or the team owners — learns that a
    // decision is theirs to make. Projected in-transaction so notifications
    // can never lag or drift from the work state they describe.
    if (eventId && (eventType === 'decision.requested' || eventType === 'run.completed')) {
      await projectWorkNotifications(transaction, {
        eventId,
        payload: {
          externalUrl: run.externalUrl,
          phase: run.phase,
          publicId: run.publicId,
          summary: run.summary,
        },
        type: eventType,
        work,
      });
    }

    if (idempotencyId) {
      await completeWorkIdempotency(transaction, idempotencyId, work.id, run.id);
    }

    // INV-11: hooks may auto-Done after review_submitted; return fresh row.
    const freshWork = await transaction.issue.findUniqueOrThrow({ where: { id: nextWork.id } });
    return { run, work: freshWork };
  });
}

export async function moveToInProgress(prisma: DatabaseClient, work: Issue): Promise<Issue> {
  const currentState = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { type: true },
  });

  if (!currentState || (currentState.type !== 'UNSTARTED' && currentState.type !== 'BACKLOG')) {
    return work;
  }

  const startedState = await prisma.workflowState.findFirst({
    where: {
      teamId: work.teamId,
      type: 'STARTED',
    },
    orderBy: { position: 'asc' },
    select: { id: true },
  });

  if (!startedState) {
    return work;
  }

  const transition = await prisma.issue.updateMany({
    where: { id: work.id, stateId: work.stateId },
    data: {
      stateId: startedState.id,
    },
  });

  if (transition.count === 1) {
    return prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
  }

  return work;
}

export async function moveToInReview(prisma: DatabaseClient, work: Issue, actor: WriteActor): Promise<Issue> {
  const currentState = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { type: true },
  });

  if (!currentState || currentState.type === 'REVIEW' || currentState.type === 'COMPLETED' || currentState.type === 'CANCELED') {
    return work;
  }

  const reviewState = await prisma.workflowState.findFirst({
    where: {
      teamId: work.teamId,
      type: 'REVIEW',
    },
    select: { id: true },
  });

  if (!reviewState) throw createValidationError(WORK_REVIEW_STATE_MISSING_MESSAGE);

  // Optimistic guard: only the first concurrent COMPLETED reporter wins the
  // REVIEW transition. Losers re-read; if the work already moved to a terminal
  // review state they become idempotent no-ops instead of double-incrementing
  // revision and emitting a duplicate work.review_submitted event.
  const transition = await prisma.issue.updateMany({
    where: { id: work.id, revision: work.revision, stateId: work.stateId },
    data: {
      revision: { increment: 1 },
      stateId: reviewState.id,
    },
  });
  if (transition.count !== 1) {
    const fresh = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
    const freshState = await prisma.workflowState.findUnique({
      where: { id: fresh.stateId },
      select: { type: true },
    });
    if (freshState && (freshState.type === 'REVIEW' || freshState.type === 'COMPLETED' || freshState.type === 'CANCELED')) {
      return fresh;
    }
    throw createValidationError(WORK_RUN_CONFLICT_MESSAGE);
  }
  const updated = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
  await recordWorkAudit(prisma, {
    actor,
    after: selectIssueSnapshot(updated),
    before: selectIssueSnapshot(work),
    workId: work.id,
  });
  await enqueueWorkEvent(prisma, {
    payload: { fromRevision: work.revision, toRevision: updated.revision },
    type: 'work.review_submitted',
    workId: work.id,
    workIdentifier: work.identifier,
  });
  return updated;
}
