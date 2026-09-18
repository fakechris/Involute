import { createNotFoundError, createValidationError } from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

import type { PrismaClient, WorkEvidence } from '@prisma/client';

export const EVIDENCE_NOT_FOUND_MESSAGE = 'Evidence not found.';
export const EVIDENCE_ALREADY_RETRACTED_MESSAGE = 'This evidence is already retracted.';
export const EVIDENCE_RETRACT_HUMAN_ONLY_MESSAGE = 'Only a person may retract evidence.';
export const EVIDENCE_RETRACT_REASON_REQUIRED_MESSAGE = 'Retracting evidence requires a reason.';

/**
 * Retract a piece of evidence (INV-598). Nothing is deleted: the row stays,
 * marked with who retracted it, when, why, and — when known — which work
 * item it should have been attached to. Gates that judge a work item by its
 * evidence (auto-accept, traceability, verification) ignore retracted rows;
 * readers still see them, labelled. The retraction is audited on the work
 * item and emitted, so the correction is as traceable as the mistake.
 */
export async function retractEvidence(
  prisma: PrismaClient,
  input: { correctWorkId?: string | null; evidenceId: string; reason: string },
  actor: WriteActor,
  now: Date = new Date(),
): Promise<WorkEvidence> {
  const retractedById = actor.actorId;
  if (actor.actorKind !== 'HUMAN' || !retractedById) {
    throw createValidationError(EVIDENCE_RETRACT_HUMAN_ONLY_MESSAGE);
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw createValidationError(EVIDENCE_RETRACT_REASON_REQUIRED_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const evidence = await tx.workEvidence.findUnique({
      where: { id: input.evidenceId },
      include: { work: true },
    });
    if (!evidence) {
      throw createNotFoundError(EVIDENCE_NOT_FOUND_MESSAGE);
    }
    if (evidence.retractedAt) {
      throw createValidationError(EVIDENCE_ALREADY_RETRACTED_MESSAGE);
    }
    if (input.correctWorkId) {
      const correct = await tx.issue.findUnique({ where: { id: input.correctWorkId }, select: { id: true } });
      if (!correct) {
        throw createNotFoundError('The work item this evidence should point at was not found.');
      }
    }

    // CAS on retractedAt: two concurrent retractions must not both succeed,
    // or the second would overwrite the first person's reason and target and
    // leave two audits for one act.
    const moved = await tx.workEvidence.updateMany({
      where: { id: evidence.id, retractedAt: null },
      data: {
        retractReason: reason,
        retractedAt: now,
        retractedById,
        supersededByWorkId: input.correctWorkId ?? null,
      },
    });
    if (moved.count !== 1) {
      throw createValidationError(EVIDENCE_ALREADY_RETRACTED_MESSAGE);
    }
    const updated = await tx.workEvidence.findUniqueOrThrow({ where: { id: evidence.id } });

    const snapshot = selectIssueSnapshot(evidence.work);
    await recordWorkAudit(tx, {
      actor: {
        ...actor,
        reason: `evidence retracted (${evidence.kind} ${evidence.url}): ${reason}`,
        sourceMessageId: evidence.id,
        surface: 'evidence.retract',
      },
      after: snapshot,
      before: snapshot,
      workId: evidence.workId,
    });

    await enqueueWorkEvent(tx, {
      payload: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        reason,
        retractedByActorId: retractedById,
        supersededByWorkId: input.correctWorkId ?? null,
        url: evidence.url,
      },
      type: 'evidence.retracted',
      workId: evidence.workId,
      workIdentifier: evidence.work.identifier,
    });

    return updated;
  });
}
