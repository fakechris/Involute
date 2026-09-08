import type {
  Issue,
  Prisma,
  PrismaClient,
  WorkAutoAcceptEvaluation,
  WorkReviewDecision,
  WorkRun,
} from '@prisma/client';

import {
  evaluateAutoAcceptGrade,
  type AutoAcceptGradeResult,
} from './auto-accept-grade.js';
import { enqueueWorkEvent } from './event-outbox.js';
import {
  createValidationError,
  WORK_ACCEPT_FORBIDDEN_MESSAGE,
  WORK_REVIEW_REQUIRED_MESSAGE,
  WORK_REVIEW_STATE_MISSING_MESSAGE,
} from './errors.js';
import {
  claimIssueRevision,
  recordWorkAudit,
  selectIssueSnapshot,
  type WriteActor,
} from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const AUTO_ACCEPT_ACTOR_EMAIL = 'auto-accept@involute.internal';
export const AUTO_ACCEPT_ACTOR_NAME = 'Auto-Accept Gate';

export interface AutoAcceptGateResult {
  evaluation: WorkAutoAcceptEvaluation;
  grade: AutoAcceptGradeResult;
  work: Issue;
  decision?: WorkReviewDecision;
}

/**
 * Evaluate In Review evidence and, only for CLEAR tiers, move work to Done.
 * Always persists an evaluation row for audit. Agents cannot call this via MCP;
 * this is an internal SERVICE gate.
 */
export async function tryAutoAccept(
  prisma: DatabaseClient,
  workId: string,
  options: { actor?: WriteActor | null; runId?: string | null } = {},
): Promise<AutoAcceptGateResult | null> {
  const work = await prisma.issue.findUnique({ where: { id: workId } });
  if (!work) {
    return null;
  }

  const state = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { type: true },
  });
  if (state?.type !== 'REVIEW') {
    return null;
  }

  const run = options.runId
    ? await prisma.workRun.findFirst({ where: { id: options.runId, workId: work.id } })
    : await prisma.workRun.findFirst({
        where: { status: 'COMPLETED', workId: work.id },
        orderBy: [{ endedAt: 'desc' }, { createdAt: 'desc' }],
      });

  const evidence = run
    ? await prisma.workEvidence.findMany({
        where: { workId: work.id, runId: run.id },
        orderBy: { createdAt: 'asc' },
      })
    : await prisma.workEvidence.findMany({
        where: { workId: work.id },
        orderBy: { createdAt: 'asc' },
      });

  const grade = evaluateAutoAcceptGrade({
    evidence: evidence.map((item) => ({
      kind: item.kind,
      summary: item.summary,
      url: item.url,
    })),
    runStatus: run?.status ?? null,
  });

  const serviceActor = await ensureAutoAcceptActor(prisma);
  const actor: WriteActor = {
    actorId: serviceActor.id,
    actorKind: 'SERVICE',
    reason: `auto-accept:${grade.tier}`,
    surface: options.actor?.surface ?? 'auto-accept-gate',
  };

  if (grade.tier !== 'CLEAR') {
    return recordSkipped(prisma, {
      actorId: serviceActor.id,
      grade,
      runId: run?.id ?? null,
      work,
    });
  }

  // CLEAR: apply Done through the internal SERVICE path (not agent / not MCP).
  try {
    return await applyClearAutoAccept(prisma, work, run, actor, grade);
  } catch (error) {
    // Concurrent human/auto accept or revision race: never fail the caller
    // mutation; leave an audit SKIPPED row instead.
    const fresh = await prisma.issue.findUnique({ where: { id: work.id } });
    const freshState = fresh
      ? await prisma.workflowState.findUnique({
          where: { id: fresh.stateId },
          select: { type: true },
        })
      : null;
    if (freshState?.type === 'COMPLETED' || freshState?.type === 'CANCELED' || freshState?.type !== 'REVIEW') {
      const skippedGrade = {
        ...grade,
        reasons: [...grade.reasons, 'skipped: work left REVIEW before auto-accept applied'],
      };
      return recordSkipped(prisma, {
        actorId: serviceActor.id,
        grade: skippedGrade,
        runId: run?.id ?? null,
        work: fresh ?? work,
      });
    }
    throw error;
  }
}

async function recordSkipped(
  prisma: DatabaseClient,
  input: {
    actorId: string;
    grade: AutoAcceptGradeResult;
    runId: string | null;
    work: Issue;
  },
): Promise<AutoAcceptGateResult> {
  const evaluation = await persistEvaluation(prisma, {
    actorId: input.actorId,
    grade: input.grade,
    outcome: 'SKIPPED',
    runId: input.runId,
    workId: input.work.id,
  });
  await enqueueWorkEvent(prisma, {
    payload: {
      evaluationId: evaluation.id,
      outcome: evaluation.outcome,
      reasons: evaluation.reasons,
      tier: evaluation.tier,
      runId: input.runId,
    },
    type: 'work.auto_accept_evaluated' as unknown as import('./event-outbox.js').WorkEventType,
    workId: input.work.id,
    workIdentifier: input.work.identifier,
  });
  return { evaluation, grade: input.grade, work: input.work };
}

async function applyClearAutoAccept(
  prisma: DatabaseClient,
  work: Issue,
  run: WorkRun | null,
  actor: WriteActor,
  grade: AutoAcceptGradeResult,
): Promise<AutoAcceptGateResult> {
  if (actor.actorKind === 'AGENT') {
    throw createValidationError(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  }

  const state = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { type: true },
  });
  if (state?.type !== 'REVIEW') {
    throw createValidationError(WORK_REVIEW_REQUIRED_MESSAGE);
  }

  await claimIssueRevision(prisma, work.id, work.revision);

  const doneState = await prisma.workflowState.findFirst({
    where: { teamId: work.teamId, type: 'COMPLETED' },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  if (!doneState) {
    throw createValidationError(WORK_REVIEW_STATE_MISSING_MESSAGE);
  }

  const updated = await prisma.issue.update({
    where: { id: work.id },
    data: { stateId: doneState.id },
  });

  const reviewerId = actor.actorId;
  if (!reviewerId) {
    throw createValidationError(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  }

  const decision = await prisma.workReviewDecision.create({
    data: {
      decision: 'ACCEPTED',
      fromRevision: work.revision,
      reason: `auto-accept:CLEAR — ${grade.reasons.join('; ')}`,
      reviewerId,
      runId: run?.id ?? null,
      toRevision: updated.revision,
      workId: work.id,
    },
  });

  await recordWorkAudit(prisma, {
    actor,
    after: selectIssueSnapshot(updated),
    before: selectIssueSnapshot(work),
    workId: work.id,
  });

  const evaluation = await persistEvaluation(prisma, {
    actorId: reviewerId,
    decisionId: decision.id,
    grade,
    outcome: 'ACCEPTED',
    runId: run?.id ?? null,
    workId: work.id,
  });

  await enqueueWorkEvent(prisma, {
    payload: {
      evaluationId: evaluation.id,
      outcome: evaluation.outcome,
      reasons: evaluation.reasons,
      tier: evaluation.tier,
      runId: run?.id ?? null,
      decisionId: decision.id,
    },
    type: 'work.auto_accept_evaluated' as unknown as import('./event-outbox.js').WorkEventType,
    workId: work.id,
    workIdentifier: work.identifier,
  });

  await enqueueWorkEvent(prisma, {
    payload: {
      decisionId: decision.id,
      reason: decision.reason,
      reviewerId,
      runId: decision.runId,
      autoAccept: true,
      tier: grade.tier,
      selfReviewed: false,
    },
    type: 'work.accepted',
    updatedFrom: { revision: work.revision, stateId: work.stateId },
    workId: work.id,
    workIdentifier: work.identifier,
  });

  return { decision, evaluation, grade, work: updated };
}

async function persistEvaluation(
  prisma: DatabaseClient,
  input: {
    actorId: string | null;
    decisionId?: string | null;
    grade: AutoAcceptGradeResult;
    outcome: 'ACCEPTED' | 'SKIPPED';
    runId: string | null;
    workId: string;
  },
): Promise<WorkAutoAcceptEvaluation> {
  return prisma.workAutoAcceptEvaluation.create({
    data: {
      actorId: input.actorId,
      decisionId: input.decisionId ?? null,
      outcome: input.outcome,
      reasons: input.grade.reasons,
      runId: input.runId,
      signals: input.grade.signals as unknown as Prisma.InputJsonValue,
      tier: input.grade.tier,
      workId: input.workId,
    },
  });
}

export async function ensureAutoAcceptActor(prisma: DatabaseClient): Promise<{ id: string }> {
  const existing = await prisma.user.findUnique({
    where: { email: AUTO_ACCEPT_ACTOR_EMAIL },
    select: { id: true, actorKind: true },
  });
  if (existing) {
    if (existing.actorKind !== 'SERVICE') {
      await prisma.user.update({
        where: { id: existing.id },
        data: { actorKind: 'SERVICE' },
      });
    }
    return { id: existing.id };
  }

  const created = await prisma.user.create({
    data: {
      actorKind: 'SERVICE',
      email: AUTO_ACCEPT_ACTOR_EMAIL,
      name: AUTO_ACCEPT_ACTOR_NAME,
    },
    select: { id: true },
  });
  return created;
}
