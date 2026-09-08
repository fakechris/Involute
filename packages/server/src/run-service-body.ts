import type {
  Issue,
  Prisma,
  PrismaClient,
  WorkEvidence,
  WorkEvidenceKind,
  WorkClaim,
  WorkReviewDecision,
  WorkReviewDecisionKind,
  WorkRun,
  WorkRunStatus,
} from '@prisma/client';

import { findWorkByIdOrIdentifier } from './context-service.js';
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
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_EVIDENCE_KIND_INVALID_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE,
  WORK_RUN_NOT_FOUND_MESSAGE,
  WORK_RUN_STATUS_INVALID_MESSAGE,
  WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE,
  WORK_RUN_ACTOR_MISMATCH_MESSAGE,
  WORK_RUN_TERMINAL_MESSAGE,
  WORK_RUN_TRANSITION_INVALID_MESSAGE,
  WORK_RUN_CONFLICT_MESSAGE,
  WORK_EVIDENCE_REQUIRES_RUN_MESSAGE,
  WORK_REVIEW_REQUIRED_MESSAGE,
  WORK_REVIEW_STATE_MISSING_MESSAGE,
  WORK_ACCEPT_FORBIDDEN_MESSAGE,
  WORK_CLAIM_REQUIRES_ACTOR_MESSAGE,
} from './errors.js';
import {
  claimIssueRevision,
  recordWorkAudit,
  selectIssueSnapshot,
  type WriteActor,
} from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const TERMINAL_RUN_STATUSES: WorkRunStatus[] = ['COMPLETED', 'FAILED'];
const ALLOWED_RUN_TRANSITIONS: Record<WorkRunStatus, readonly WorkRunStatus[]> = {
  QUEUED: ['RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED'],
  RUNNING: ['BLOCKED', 'COMPLETED', 'FAILED'],
  BLOCKED: ['RUNNING', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export interface ReportRunInput {
  decisionRequested?: boolean | null;
  externalUrl?: string | null;
  idempotencyKey?: string | null;
  phase?: string | null;
  runId?: string | null;
  status?: string | null;
  summary?: string | null;
  workId: string;
}

export interface AttachEvidenceInput {
  idempotencyKey?: string | null;
  kind: string;
  runId?: string | null;
  summary?: string | null;
  url: string;
  workId: string;
}

export interface ReviewWorkInput {
  decision: WorkReviewDecisionKind;
  expectedRevision: number;
  idempotencyKey?: string | null;
  reason?: string | null;
  runId?: string | null;
}

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
    let run = input.runId ? await findRun(transaction, input.runId, work.id) : null;
    let activeClaim: WorkClaim | null = null;

    if (input.runId && !run) {
      throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);
    }

    const isNew = !run;
    if (!run) {
      activeClaim = await transaction.workClaim.findFirst({
        where: {
          actorId,
          leaseUntil: { gt: new Date() },
          workId: work.id,
        },
      });
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
      if (!run.claimId) throw createValidationError(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
      activeClaim = await transaction.workClaim.findFirst({
        where: {
          actorId,
          id: run.claimId,
          leaseUntil: { gt: new Date() },
          workId: work.id,
        },
      });
      if (!activeClaim) throw createValidationError(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
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
    if (run.status === 'COMPLETED') {
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

    return { run, work: nextWork };
  });
}

export async function attachEvidence(
  prisma: PrismaClient,
  input: AttachEvidenceInput,
  actor: WriteActor,
): Promise<{ evidence: WorkEvidence; work: Issue }> {
  const kind = parseEvidenceKind(input.kind);
  const actorId = actor.actorId;
  if (!actorId) throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);
  if (!input.runId) throw createValidationError(WORK_EVIDENCE_REQUIRES_RUN_MESSAGE);

  return prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, input.workId);
    let evidenceIdempotencyId: st