import type { PrismaClient } from '@prisma/client';

import { enqueueWorkEvent } from './event-outbox.js';
import { recordWorkAudit, selectIssueSnapshot } from './work-service.js';

/**
 * Leases that ran out without the agent coming back (INV-991). Until now an
 * expired claim stayed until the next claim attempt removed it: the work
 * looked occupied, its run looked alive, and nobody was told. Each sweep
 * closes such claims the way a person's release does (INV-789): open runs
 * fail with the reason, work that was In Progress goes back to Ready, and the
 * owner, the holder and the holder's owner get a work.claim_expired note.
 */
export async function sweepExpiredClaims(prisma: PrismaClient, now = new Date()): Promise<number> {
  const expired = await prisma.workClaim.findMany({
    where: { leaseUntil: { lte: now } },
    select: { id: true },
    orderBy: { leaseUntil: 'asc' },
    take: 100,
  });
  let swept = 0;
  for (const { id } of expired) {
    swept += await prisma.$transaction(async (tx) => {
      const claim = await tx.workClaim.findUnique({ where: { id } });
      // Renewed or released since the sweep looked: not ours.
      if (!claim || claim.leaseUntil > now) return 0;
      await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${claim.workId}::uuid FOR UPDATE`;
      const work = await tx.issue.findUniqueOrThrow({ where: { id: claim.workId }, include: { state: true } });
      const overdueMinutes = Math.max(1, Math.round((now.getTime() - claim.leaseUntil.getTime()) / 60_000));
      const summary = `Lease expired ${overdueMinutes} min ago without renewal; the claim was released by the server.`;

      await tx.workRun.updateMany({ where: { workId: work.id, claimSnapshotId: claim.id, executionRevokedAt: null }, data: { executionRevokedAt: now } });
      const closed = await tx.workRun.updateMany({
        where: { claimId: claim.id, status: { in: ['QUEUED', 'RUNNING', 'BLOCKED'] } },
        data: { status: 'FAILED', endedAt: now, summary },
      });
      await tx.workClaim.delete({ where: { id: claim.id } });

      // Only work the agent had moved to In Progress goes back; Review or
      // Done reached through a PR stays where the PR put it.
      let stateId = work.stateId;
      if (work.state.type === 'STARTED') {
        const ready = await tx.workflowState.findFirst({ where: { teamId: work.teamId, type: 'UNSTARTED' }, orderBy: { position: 'asc' }, select: { id: true } });
        if (ready) stateId = ready.id;
      }
      const updated = await tx.issue.update({ where: { id: work.id }, data: { stateId, revision: { increment: 1 } } });
      await recordWorkAudit(tx, {
        actor: { actorId: null, actorKind: 'SERVICE', surface: 'system', reason: summary },
        after: selectIssueSnapshot(updated),
        before: selectIssueSnapshot(work),
        workId: work.id,
      });

      const payload = { expiredActorId: claim.actorId, leaseUntil: claim.leaseUntil.toISOString(), overdueMinutes, closedRuns: closed.count, returnedToReady: stateId !== work.stateId };
      const event = await enqueueWorkEvent(tx, { payload, type: 'work.claim_expired', workId: work.id, workIdentifier: work.identifier });
      const holder = await tx.user.findUnique({ where: { id: claim.actorId }, select: { id: true, ownerId: true } });
      const recipients = [...new Set([work.assigneeId, holder?.id, holder?.ownerId].filter((userId): userId is string => Boolean(userId)))];
      if (recipients.length) {
        await tx.notification.createMany({
          data: recipients.map((userId) => ({
            payload: { ...payload, identifier: work.identifier, title: work.title },
            sourceEventId: event.id,
            teamId: work.teamId,
            type: 'work.claim_expired',
            userId,
            workId: work.id,
          })),
          skipDuplicates: true,
        });
      }
      return 1;
    });
  }
  return swept;
}
