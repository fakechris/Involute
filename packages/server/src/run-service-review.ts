import type { Issue, PrismaClient, WorkReviewDecision } from '@prisma/client';

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
  WORK_ACCEPT_FORBIDDEN_MESSAGE,
  WORK_CLAIM_REQUIRES_ACTOR_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE,
  WORK_REVIEW_REQUIRED_MESSAGE,
  WORK_REVIEW_STATE_MISSING_MESSAGE,
  WORK_RUN_NOT_FOUND_MESSAGE,
} from './errors.js';
import {
  claimIssueRevision,
  recordWorkAudit,
  selectIssueSnapshot,
  type WriteActor,
} from './work-service.js';
import {
  type ReviewWorkInput,
  findRun,
  requireWork,
} from './run-service-shared.js';

export async function reviewWork(
  prisma: PrismaClient,
  id: string,
  input: ReviewWorkInput,
  actor: WriteActor,
): Promise<{ decision: WorkReviewDecision; work: Issue }> {
  if (actor.actorKind !== 'HUMAN') throw createValidationError(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  const actorId = actor.actorId;
  if (!actorId) throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);

  return prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, id);
    let reviewIdempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'review',
        requestHash: hashIdempotencyRequest({ ...input, idempotencyKey: null, id }),
        teamId: work.teamId,
      });
      if (!reservation.created) {
        if (reservation.record.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
        }
        if (!reservation.record.resultId) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        const replayed = await transaction.workReviewDecision.findUnique({
          where: { id: reservation.record.resultId },
        });
        if (!replayed || replayed.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        const freshWork = await transaction.issue.findUniqueOrThrow({ where: { id: work.id } });
        return { decision: replayed, work: freshWork };
      }
      reviewIdempotencyId = reservation.record.id;
    }
    const state = await transaction.workflowState.findUnique({
      where: { id: work.stateId },
      select: { type: true },
    });
    if (state?.type !== 'REVIEW') throw createValidationError(WORK_REVIEW_REQUIRED_MESSAGE);
    await claimIssueRevision(transaction, work.id, input.expectedRevision);

    const targetType = input.decision === 'ACCEPTED' ? 'COMPLETED' : 'UNSTARTED';
    const targetState = await transaction.workflowState.findFirst({
      where: { teamId: work.teamId, type: targetType },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (!targetState) throw createValidationError(WORK_REVIEW_STATE_MISSING_MESSAGE);

    const run = input.runId
      ? await findRun(transaction, input.runId, work.id)
      : await transaction.workRun.findFirst({
          where: { status: 'COMPLETED', workId: work.id },
          orderBy: { endedAt: 'desc' },
        });
    if (input.runId && !run) throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);

    const updated = await transaction.issue.update({
      where: { id: work.id },
      data: { stateId: targetState.id },
    });
    const decision = await transaction.workReviewDecision.create({
      data: {
        decision: input.decision,
        fromRevision: work.revision,
        reason: input.reason ?? null,
        reviewerId: actorId,
        runId: run?.id ?? null,
        toRevision: updated.revision,
        workId: work.id,
      },
    });
    await recordWorkAudit(transaction, {
      actor,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
    let reviewEventId: string | null = null;
    const reviewEventType = input.decision === 'ACCEPTED' ? 'work.accepted' : 'work.review_rejected';
    const enqueued = await enqueueWorkEvent(transaction, {
      payload: {
        decisionId: decision.id,
        reason: decision.reason,
        reviewerId: actorId,
        runId: decision.runId,
        selfReviewed: work.assigneeId === actorId || run?.actorId === actorId,
      },
      type: reviewEventType,
      updatedFrom: { revision: work.revision, stateId: work.stateId },
      workId: work.id,
      workIdentifier: work.identifier,
    });
    reviewEventId = enqueued.id;

    // Close the loop with the acting agent's owner: a human actor learns the
    // review outcome here; agent actors have no notification inbox (their
    // surface is webhooks), so they are skipped.
    if (run?.actorId) {
      const runActor = await transaction.user.findUnique({
        where: { id: run.actorId },
        select: { actorKind: true, id: true },
      });
      if (runActor?.actorKind === 'HUMAN') {
        await transaction.notification.createMany({
          data: [
            {
              payload: {
                decision: input.decision,
                decisionId: decision.id,
                reason: decision.reason,
              },
              sourceEventId: reviewEventId,
              teamId: work.teamId,
              type: reviewEventType,
              userId: runActor.id,
              workId: work.id,
            },
          ],
          skipDuplicates: true,
        });
      }
    }
    if (reviewIdempotencyId) {
      await completeWorkIdempotency(transaction, reviewIdempotencyId, work.id, decision.id);
    }
    return { decision, work: updated };
  });
}
