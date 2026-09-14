import type { Issue, Prisma, PrismaClient, WorkAutoAcceptEvaluation, WorkReviewDecision } from '@prisma/client';
import { evaluateAutoAcceptGrade, type AutoAcceptGradeResult } from './auto-accept-grade.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { assessVerifiedEvidence } from './evidence-verification.js';
import { ACCEPTANCE_POLICY } from './evidence-contract.js';
import type { WriteActor } from './work-service.js';
type DatabaseClient = PrismaClient | Prisma.TransactionClient;
export const AUTO_ACCEPT_ACTOR_EMAIL = 'auto-accept@involute.internal';
export const AUTO_ACCEPT_ACTOR_NAME = 'Auto-Accept Gate';
export interface AutoAcceptGateResult {
  evaluation: WorkAutoAcceptEvaluation;
  grade: AutoAcceptGradeResult;
  work: Issue;
  decision?: WorkReviewDecision;
}
/** Every automated evaluation is shadow-only. Only the human review service accepts work. */
export async function tryAutoAccept(prisma: DatabaseClient, workId: string,
  options: { actor?: WriteActor | null; runId?: string | null } = {}): Promise<AutoAcceptGateResult | null> {
  if ('$transaction' in prisma) return prisma.$transaction(tx => tryAutoAccept(tx, workId, options));
  await prisma.$queryRaw`SELECT id FROM "Issue" WHERE id = ${workId}::uuid FOR UPDATE`;
  const work = await prisma.issue.findUnique({ where: { id: workId } });
  if (!work) return null;
  const state = await prisma.workflowState.findUnique({ where: { id: work.stateId } });
  if (state?.type !== 'REVIEW') return null;
  const run = options.runId
    ? await prisma.workRun.findFirst({ where: { id: options.runId, workId } })
    : await prisma.workRun.findFirst({ where: { workId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const evidence = await prisma.workEvidence.findMany({ where: { workId, ...(run ? { runId: run.id } : {}) } });
  const grade = evaluateAutoAcceptGrade({ evidence, runStatus: run?.status ?? null });
  const verified = await assessVerifiedEvidence(prisma, work, run);
  if (verified.eligible) { grade.tier = 'CLEAR'; grade.reasons = ['required criteria verified by server observations']; }
  grade.reasons.push(...verified.reasons, `${ACCEPTANCE_POLICY.mode}: human review required; covered=${verified.covered.join(',')}`);
  const service = await ensureAutoAcceptActor(prisma);
  return recordSkipped(prisma, { actorId: service.id, grade, runId: run?.id ?? null, work });
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
