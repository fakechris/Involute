import { assertExecutionAuthority, assertWorkToken } from './work-execution.js';
import type { PrismaClient } from '@prisma/client';

import {
  CLAIM_RELEASE_FORBIDDEN_MESSAGE,
  CLAIM_RELEASE_NO_CLAIM_MESSAGE,
  CLAIM_RELEASE_REASON_REQUIRED_MESSAGE,
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

/**
 * A person takes back an agent's lease (INV-789): the claim ends now instead
 * of when it expires, so stuck or wrong-headed work can be picked up. Open
 * runs under the claim are closed as FAILED with who released it and why, so
 * the agent's next report is refused; the holder and its owner are told.
 */
export async function releaseClaim(
  prisma: PrismaClient,
  input: { workId: string; reason: string; claimToken?: string | null },
  actor: WriteActor,
): Promise<{ workId: string; releasedActorId: string }> {
  if (!['HUMAN', 'AGENT'].includes(actor.actorKind) || !actor.actorId) throw createValidationError(CLAIM_RELEASE_FORBIDDEN_MESSAGE);
  const reason = input.reason.trim();
  if (!reason) throw createValidationError(CLAIM_RELEASE_REASON_REQUIRED_MESSAGE);

  return prisma.$transaction(async (transaction) => {
    const work = await findWorkByIdOrIdentifier(transaction, input.workId);
    if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    await transaction.$queryRaw`SELECT id FROM "Issue" WHERE id = ${work.id}::uuid FOR UPDATE`;
    const claim = await transaction.workClaim.findUnique({ where: { workId: work.id } });
    await assertExecutionAuthority(transaction, actor, work, 'claim');
    if (!claim) throw createValidationError(CLAIM_RELEASE_NO_CLAIM_MESSAGE);
    if (actor.actorKind === 'AGENT') {
      if (claim.actorId !== actor.actorId || claim.leaseUntil <= new Date()) throw createValidationError(CLAIM_RELEASE_FORBIDDEN_MESSAGE);
      assertWorkToken(claim.executionTokenHash, input.claimToken);
    }
    const releaser = await transaction.user.findUnique({ where: { id: actor.actorId! }, select: { name: true, email: true } });
    const by = releaser?.name ?? releaser?.email ?? 'a person';

    await transaction.workRun.updateMany({
      where: { workId: work.id, claimSnapshotId: claim.id, executionRevokedAt: null },
      data: { executionRevokedAt: new Date() },
    });
    const closed = await transaction.workRun.updateMany({
      where: { claimId: claim.id, status: { in: ['QUEUED', 'RUNNING', 'BLOCKED'] } },
      data: { status: 'FAILED', endedAt: new Date(), summary: `Claim released by ${by}: ${reason}` },
    });
    await transaction.workClaim.delete({ where: { id: claim.id } });

    const updated = await transaction.issue.update({ where: { id: work.id }, data: { revision: { increment: 1 } } });
    await recordWorkAudit(transaction, {
      actor: { ...actor, reason: `Claim released: ${reason}` },
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
    const payload = { releasedActorId: claim.actorId, releasedById: actor.actorId, reason, closedRuns: closed.count };
    const event = await enqueueWorkEvent(transaction, {
      payload,
      type: 'work.claim_released',
      workId: work.id,
      workIdentifier: work.identifier,
    });
    const holder = await transaction.user.findUnique({ where: { id: claim.actorId }, select: { id: true, ownerId: true } });
    const recipients = [...new Set([holder?.id, holder?.ownerId].filter((id): id is string => Boolean(id) && id !== actor.actorId))];
    if (recipients.length) {
      await transaction.notification.createMany({
        data: recipients.map((userId) => ({
          payload: { ...payload, identifier: work.identifier, title: work.title },
          sourceEventId: event.id,
          teamId: work.teamId,
          type: 'work.claim_released',
          userId,
          workId: work.id,
        })),
        skipDuplicates: true,
      });
    }
    return { workId: work.id, releasedActorId: claim.actorId };
  });
}
