import type { Issue, Prisma } from '@prisma/client';

import { finishRejection } from './claim-service.js';
import { createNotFoundError, createValidationError, ISSUE_NOT_FOUND_MESSAGE } from './errors.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';
import { enqueueWorkCanceledEvent } from './work-resolution.js';

export interface CloseAsDuplicateResult {
  /** False when the work was already closed (Done, Canceled or rejected) and was left as it is. */
  closed: boolean;
  work: Issue;
}

/**
 * Closes `workId` as a duplicate of `duplicateOfId` with resolution DUPLICATE
 * (INV-1118, for INV-1124's DUPLICATE_OF linkage). A candidate is rejected; a
 * committed open item moves to its team's Canceled state. Already-closed work
 * is left alone. Runs inside the caller's transaction and does not apply the
 * human gate: the caller decides who may cause it (the link it follows already
 * passed write checks). Records the audit, the event and, for a candidate, the
 * same decision notifications a person's rejection sends.
 */
export async function closeWorkAsDuplicate(
  tx: Prisma.TransactionClient,
  input: { workId: string; duplicateOfId: string; actor: WriteActor; reason?: string | null },
): Promise<CloseAsDuplicateResult> {
  const work = await tx.issue.findUnique({ where: { id: input.workId }, include: { state: { select: { type: true } } } });
  if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  const { state, ...before } = work;
  const original = await tx.issue.findUnique({ where: { id: input.duplicateOfId }, select: { identifier: true } });
  if (!original) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  const reason = input.reason?.trim() || `Duplicate of ${original.identifier}`;

  if (before.commitmentStatus === 'REJECTED' || state.type === 'COMPLETED' || state.type === 'CANCELED') {
    return { closed: false, work: before };
  }

  if (before.commitmentStatus === 'CANDIDATE') {
    const updated = await tx.issue.update({
      where: { id: before.id },
      data: { commitmentStatus: 'REJECTED', resolution: 'DUPLICATE', revision: { increment: 1 } },
    });
    await finishRejection(tx, { actor: input.actor, before, updated, reason, resolution: 'DUPLICATE', duplicateOfId: input.duplicateOfId });
    return { closed: true, work: updated };
  }

  const canceled = await tx.workflowState.findFirst({ where: { teamId: before.teamId, type: 'CANCELED' }, orderBy: { position: 'asc' } });
  if (!canceled) throw createValidationError('This team has no Canceled state to close the duplicate into.');
  const updated = await tx.issue.update({
    where: { id: before.id },
    data: { stateId: canceled.id, resolution: 'DUPLICATE', revision: { increment: 1 } },
  });
  await recordWorkAudit(tx, {
    actor: { ...input.actor, reason },
    after: selectIssueSnapshot(updated),
    before: selectIssueSnapshot(before),
    workId: before.id,
  });
  await enqueueWorkCanceledEvent(tx, {
    work: updated,
    before,
    actorId: input.actor.actorId,
    resolution: 'DUPLICATE',
    reason,
    duplicateOfId: input.duplicateOfId,
    source: 'duplicate',
  });
  return { closed: true, work: updated };
}
