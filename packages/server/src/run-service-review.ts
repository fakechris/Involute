import { prepareDeliveryAcceptance, acceptDeliveryChildren, returnDeliveryChildren } from './delivery-review.js';
import { lockWorkGraph } from './graph-integrity.js';
import type { Issue, Prisma, PrismaClient, WorkReviewDecision } from '@prisma/client';

import { enqueueWorkEvent } from './inv11-hooks.js';
import {
  completeWorkIdempotency,
  hashIdempotencyRequest,
  reserveWorkIdempotency,
} from './idempotency.js';
import { projectDecisionNotifications, resolveAttentionNotifications } from './notification-service.js';
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
  if (!actor.actorId) throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);
  return prisma.$transaction((transaction) => reviewWorkInTransaction(transaction, id, input, actor));
}

/**
 * The review itself, inside a caller's transaction. People reach it through
 * reviewWork; the only other caller is the Auto-Accept Gate (a SERVICE actor)
 * for a bug GitHub confirmed fixed (INV-1075). Never exposed to agents.
 */
export async function reviewWorkInTransaction(
  transaction: Prisma.TransactionClient,
  id: string,
  input: ReviewWorkInput,
  actor: WriteActor,
): Promise<{ decision: WorkReviewDecision; work: Issue }> {
  if (actor.actorKind !== 'HUMAN' && actor.actorKind !== 'SERVICE') throw createValidationError(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  const actorId = actor.actorId;
  if (!actorId) throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);
  {
    const initial = await requireWork(transaction, id);
    await lockWorkGraph(transaction, initial.teamId);
    await transaction.$queryRaw`SELECT id FROM "Issue" WHERE id = ${initial.id}::uuid FOR NO KEY UPDATE`;
    const work = await requireWork(transaction, initial.id);
    if (work.deliveryRootId) throw createValidationError('Review the delivery package to accept or return its implementation units together.');
    if (work.supersededById) throw createValidationError('Review the replacement work instead of this superseded item.');
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
    const deliveryTasks = input.decision === 'ACCEPTED' ? await prepareDeliveryAcceptance(transaction, work) : [];
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
    await acceptDeliveryChildren(transaction, deliveryTasks, work, targetState.id, actor);
    if (input.decision === 'REJECTED') await returnDeliveryChildren(transaction, work, targetState.id, actor, input.reason ?? null);
    await recordWorkAudit(transaction, {
      actor,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
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

    // Close the loop with whoever did the work and whoever proposed it, agents
    // included: the run's actor learns the outcome of its delivery, the
    // proposer the outcome of its proposal. Neither is the reviewer (INV-968).
    await projectDecisionNotifications(transaction, {
      alsoNotify: [run?.actorId],
      deciderId: actorId,
      eventId: enqueued.id,
      payload: {
        decision: input.decision,
        decisionId: decision.id,
        reason: decision.reason,
        reviewerId: actorId,
      },
      type: reviewEventType,
      work,
    });
    // The review it was waiting for, and any decision its run asked for, are made (INV-1093).
    const resolution = input.decision === 'ACCEPTED' ? 'accepted' : 'returned';
    await resolveAttentionNotifications(transaction, { kind: 'WORK_REVIEW', resolution, resolvedById: actorId, workId: work.id });
    await resolveAttentionNotifications(transaction, { kind: 'DECISION_REQUESTED', resolution, resolvedById: actorId, workId: work.id });
    if (reviewIdempotencyId) {
      await completeWorkIdempotency(transaction, reviewIdempotencyId, work.id, decision.id);
    }
    return { decision, work: updated };
  }
}
