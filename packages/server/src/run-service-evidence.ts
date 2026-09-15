import type { Issue, PrismaClient, WorkEvidence } from '@prisma/client';

import { enqueueWorkEvent } from './inv11-hooks.js';
import {
  completeWorkIdempotency,
  hashIdempotencyRequest,
  reserveWorkIdempotency,
} from './idempotency.js';
import {
  createNotFoundError,
  createValidationError,
  WORK_CLAIM_REQUIRES_ACTOR_MESSAGE,
  WORK_EVIDENCE_REQUIRES_RUN_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE,
  WORK_RUN_NOT_FOUND_MESSAGE,
  WORK_RUN_ACTOR_MISMATCH_MESSAGE,
} from './errors.js';
import type { WriteActor } from './work-service.js';
import {
  type AttachEvidenceInput,
  findRun,
  parseEvidenceKind,
  requireWork,
} from './run-service-shared.js';

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
    const initial = await requireWork(transaction, input.workId);
    await transaction.$queryRaw`SELECT id FROM "Issue" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    const work = await requireWork(transaction, initial.id);
    let evidenceIdempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'evidence_attach',
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
        const replayed = await transaction.workEvidence.findUnique({
          where: { id: reservation.record.resultId },
        });
        if (!replayed || replayed.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        const freshWork = await transaction.issue.findUniqueOrThrow({ where: { id: work.id } });
        return { evidence: replayed, work: freshWork };
      }
      evidenceIdempotencyId = reservation.record.id;
    }
    const run = await findRun(transaction, input.runId as string, work.id);
    if (!run) throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);
    if (run.actorId !== actorId) throw createValidationError(WORK_RUN_ACTOR_MISMATCH_MESSAGE);

    const evidence = await transaction.workEvidence.create({
      data: {
        kind,
        verificationNextAt: kind === 'PR' || kind === 'TEST' ? new Date() : null,
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

    if (evidenceIdempotencyId) {
      await completeWorkIdempotency(transaction, evidenceIdempotencyId, work.id, evidence.id);
    }

    // Shadow evaluation records observations while preserving the review state.
    const freshWork = await transaction.issue.findUniqueOrThrow({ where: { id: work.id } });
    return { evidence, work: freshWork };
  });
}
