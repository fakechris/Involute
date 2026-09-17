import { snapshotContract, SHA_PATTERN } from './evidence-contract.js';
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
  WORK_RUN_TERMINAL_REPLAY_MESSAGE,
  WORK_RUN_TRANSITION_INVALID_MESSAGE,
  WORK_RUN_CONFLICT_MESSAGE,
  WORK_REVIEW_STATE_MISSING_MESSAGE,
} from './errors.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';
import { attachDecisionReceipt } from './decision-receipt.js';
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
  if (input.commitSha != null && !SHA_PATTERN.test(input.commitSha)) throw createValidationError('commitSha must be a lowercase full 40-character Git SHA');
  if (input.pullRequestNumber != null && (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1)) throw createValidationError('pullRequestNumber must be a positive integer');
  const actorId = actor.actorId;
  if (!actorId) throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);

  return prisma.$transaction(async (transaction) => {
    const initial = await requireWork(transaction, input.workId);
    await transaction.$queryRaw`SELECT id FROM "Issue" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    const work = await requireWork(transaction, initial.id);
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
      const frozen = snapshotContract(work);
      run = await transaction.workRun.create({
        data: {
          actorId,
          baseRevision: work.revision,
          contractRevision: frozen.contractRevision,
          acceptanceDigest: frozen.acceptanceDigest,
          contractSnapshot: JSON.parse(JSON.stringify(frozen.contractSnapshot)),
          claimSnapshotId: activeClaim.id,
          repository: work.repository,
          commitSha: input.commitSha ?? null,
          pullRequestNumber: input.pullRequestNumber ?? null,
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
        // A proven replay (same idempotencyKey, identical request hash) has
        // already returned above. Anything that reaches here — a keyless
        // re-report, or a keyed one carrying a new receipt, summary, SHA, PR
        // or phase — is not provably the same request, and the server does
        // not keep the original to compare "looks the same" field by field.
        // Refuse; never accept and silently drop the content (INV-595).
        if (status && status !== run.status) {
          throw createValidationError(WORK_RUN_TERMINAL_MESSAGE);
        }
        throw createValidationError(WORK_RUN_TERMINAL_REPLAY_MESSAGE);
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
      const targetChanged = (input.commitSha !== undefined && input.commitSha !== run.commitSha) ||
        (input.pullRequestNumber !== undefined && input.pullRequestNumber !== run.pullRequestNumber);
      const update = await transaction.workRun.updateMany({
        where: { id: run.id, updatedAt: run.updatedAt },
        data: {
          ...(status ? { status } : {}),
          ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
          ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
          ...(status && TERMINAL_RUN_STATUSES.includes(status) ? { endedAt: new Date() } : {}),
          ...(status === 'COMPLETED' ? { claimId: null } : {}),
        },
      });
      if (update.count !== 1) throw createValidationError(WORK_RUN_CONFLICT_MESSAGE);
      run = await transaction.workRun.findUniqueOrThrow({ where: { id: run.id } });
      if (targetChanged) await transaction.workEvidence.updateMany({ where: { runId: run.id, verificationNextAt: { not: null } }, data: { verificationNextAt: new Date() } });
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

    // A receipt attaches to the audit *this* report writes — the state
    // transition, if there was one. Not every report writes one.
    let nextWork = work;
    let transitionAuditId: string | null = null;
    if (run.status === 'RUNNING') {
      ({ auditId: transitionAuditId, work: nextWork } = await moveToInProgress(transaction, work, actor));
    } else if (run.status === 'COMPLETED') {
      ({ auditId: transitionAuditId, work: nextWork } = await moveToInReview(transaction, work, actor));
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

    // Return the row after the Review transition and shadow evaluation.
    const freshWork = await transaction.issue.findUniqueOrThrow({ where: { id: nextWork.id } });
    if (input.receipt) {
      if (!transitionAuditId) {
        throw createValidationError(RUN_RECEIPT_NEEDS_AUDIT_MESSAGE);
      }
      await attachDecisionReceipt(transaction, { auditId: transitionAuditId, receipt: input.receipt });
    }
    return { run, work: freshWork };
  });
}

export const RUN_RECEIPT_NEEDS_AUDIT_MESSAGE =
  'This report changed nothing audited, so there is no write for a receipt to explain. Attach the receipt to the report that moves the work (e.g. status: completed), or to the answer/proposal it belongs to.';

export async function moveToInProgress(
  prisma: DatabaseClient,
  work: Issue,
  actor: WriteActor,
): Promise<{ auditId: string | null; work: Issue }> {
  const currentState = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { type: true },
  });

  if (!currentState || (currentState.type !== 'UNSTARTED' && currentState.type !== 'BACKLOG')) {
    return { auditId: null, work };
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
    return { auditId: null, work };
  }

  const transition = await prisma.issue.updateMany({
    where: { id: work.id, stateId: work.stateId },
    data: {
      stateId: startedState.id,
    },
  });

  if (transition.count === 1) {
    const updated = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
    // The move to In Progress was the one state transition that left no
    // audit row: a work item could start with nobody named as starting it.
    const auditId = await recordWorkAudit(prisma, {
      actor,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
    return { auditId, work: updated };
  }

  return { auditId: null, work };
}

export async function moveToInReview(
  prisma: DatabaseClient,
  work: Issue,
  actor: WriteActor,
): Promise<{ auditId: string | null; work: Issue }> {
  const currentState = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { type: true },
  });

  if (!currentState || currentState.type === 'REVIEW' || currentState.type === 'COMPLETED' || currentState.type === 'CANCELED') {
    return { auditId: null, work };
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
      return { auditId: null, work: fresh };
    }
    throw createValidationError(WORK_RUN_CONFLICT_MESSAGE);
  }
  const updated = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
  const auditId = await recordWorkAudit(prisma, {
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
  return { auditId, work: updated };
}
