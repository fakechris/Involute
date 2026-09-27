import type { Issue, PrismaClient } from '@prisma/client';

import { findWorkByIdOrIdentifier } from './context-service.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_RESTORE_FORBIDDEN_MESSAGE,
  WORK_RESTORE_NOT_REJECTED_MESSAGE,
  WORK_RESTORE_REASON_REQUIRED_MESSAGE,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

/**
 * A person undoes a rejection (INV-792): rejected work becomes a candidate
 * again, with the reason in the audit, so a wrong "no" is not permanent. It
 * goes back through commit like any candidate.
 */
export async function restoreWork(
  prisma: PrismaClient,
  input: { id: string; reason: string },
  actor: WriteActor,
): Promise<Issue> {
  if (actor.actorKind !== 'HUMAN' || !actor.actorId) throw createValidationError(WORK_RESTORE_FORBIDDEN_MESSAGE);
  const reason = input.reason.trim();
  if (!reason) throw createValidationError(WORK_RESTORE_REASON_REQUIRED_MESSAGE);

  return prisma.$transaction(async (transaction) => {
    const work = await findWorkByIdOrIdentifier(transaction, input.id);
    if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    if (work.commitmentStatus !== 'REJECTED') throw createValidationError(WORK_RESTORE_NOT_REJECTED_MESSAGE);
    const restored = await transaction.issue.update({
      where: { id: work.id },
      data: { commitmentStatus: 'CANDIDATE', revision: { increment: 1 } },
    });
    await recordWorkAudit(transaction, {
      actor: { ...actor, reason: `Restored to candidate: ${reason}` },
      after: selectIssueSnapshot(restored),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
    await enqueueWorkEvent(transaction, {
      payload: { reason, restoredById: actor.actorId },
      type: 'work.restored',
      workId: work.id,
      workIdentifier: work.identifier,
    });
    return restored;
  });
}
