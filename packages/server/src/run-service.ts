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
import { enqueueWorkEvent } from './event-outbox.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_EVIDENCE_KIND_INVALID_MESSAGE,
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
  phase?: string | null;
  runId?: string | null;
  status?: string | null;
  summary?: string | null;
  workId: string;
}

export interface AttachEvidenceInput {
  kind: string;
  runId?: string | null;
  summary?: string | null;
  url: string;
  workId: string;
}

export interface ReviewWorkInput {
  decision: WorkReviewDecisionKind;
  expectedRevision: number;
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
        if (!status || status === run.status) return { run, work };
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
    if (eventType) {
      await enqueueWorkEvent(transaction, {
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
    }

    let nextWork = work;
    if (run.status === 'COMPLETED') {
      nextWork = await moveToInReview(transaction, work, actor);
      if (activeClaim) {
        await transaction.workClaim.deleteMany({ where: { id: activeClaim.id } });
      }
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
    const run = await findRun(transaction, input.runId as string, work.id);
    if (!run) throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);
    if (run.actorId !== actorId) throw createValidationError(WORK_RUN_ACTOR_MISMATCH_MESSAGE);

    const evidence = await transaction.workEvidence.create({
      data: {
        kind,
        actorId,
        runId: run.id,
        summary: input.summary ?? null,
        url: input.url,
        workId: work.id,
      },
    });

    await enqueueWorkEvent(transaction, {
      payload: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        url: evidence.url,
        summary: evidence.summary,
        runId: evidence.runId,
        actorId: actor.actorId ?? null,
      },
      type: 'artifact.attached',
      workId: work.id,
      workIdentifier: work.identifier,
    });

    return { evidence, work };
  });
}

async function moveToInReview(prisma: DatabaseClient, work: Issue, actor: WriteActor): Promise<Issue> {
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

  const updated = await prisma.issue.update({
    where: { id: work.id },
    data: {
      revision: { increment: 1 },
      stateId: reviewState.id,
    },
  });
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
    await enqueueWorkEvent(transaction, {
      payload: {
        decisionId: decision.id,
        reason: decision.reason,
        reviewerId: actorId,
        runId: decision.runId,
      },
      type: input.decision === 'ACCEPTED' ? 'work.accepted' : 'work.review_rejected',
      updatedFrom: { revision: work.revision, stateId: work.stateId },
      workId: work.id,
      workIdentifier: work.identifier,
    });
    return { decision, work: updated };
  });
}

async function nextRunPublicId(prisma: DatabaseClient): Promise<string> {
  const sequence = await prisma.appSequence.upsert({
    where: { name: 'work_run' },
    create: { name: 'work_run', value: 1 },
    update: { value: { increment: 1 } },
  });

  return `RUN-${sequence.value}`;
}

async function findRun(
  prisma: DatabaseClient,
  runId: string,
  workId: string,
): Promise<WorkRun | null> {
  const byPublicId = await prisma.workRun.findFirst({
    where: {
      workId,
      publicId: runId,
    },
  });

  if (byPublicId) {
    return byPublicId;
  }

  try {
    return await prisma.workRun.findFirst({
      where: {
        workId,
        id: runId,
      },
    });
  } catch {
    return null;
  }
}

async function requireWork(prisma: DatabaseClient, id: string): Promise<Issue> {
  const work = await findWorkByIdOrIdentifier(prisma, id);
  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }
  return work;
}

function parseRunStatus(value: string | null | undefined): WorkRunStatus | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  const allowed: WorkRunStatus[] = ['QUEUED', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED'];
  if (!allowed.includes(normalized as WorkRunStatus)) {
    throw createValidationError(WORK_RUN_STATUS_INVALID_MESSAGE);
  }
  return normalized as WorkRunStatus;
}

function parseEvidenceKind(value: string): WorkEvidenceKind {
  const normalized = value.trim().toUpperCase();
  const allowed: WorkEvidenceKind[] = ['PR', 'TEST', 'LOG', 'SCREENSHOT', 'ARTIFACT', 'DECISION'];
  if (!allowed.includes(normalized as WorkEvidenceKind)) {
    throw createValidationError(WORK_EVIDENCE_KIND_INVALID_MESSAGE);
  }
  return normalized as WorkEvidenceKind;
}

function eventTypeForRun(
  isNew: boolean,
  status: WorkRunStatus,
  decisionRequested?: boolean | null,
): 'run.started' | 'run.blocked' | 'run.completed' | 'decision.requested' | null {
  if (decisionRequested) {
    return 'decision.requested';
  }
  if (status === 'COMPLETED') {
    return 'run.completed';
  }
  if (status === 'BLOCKED') {
    return 'run.blocked';
  }
  if (isNew) {
    return 'run.started';
  }
  return null;
}
