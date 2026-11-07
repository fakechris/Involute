import type { Issue, Prisma } from '@prisma/client';

/**
 * A completed run filed after the claim ran out (INV-1704). Long work outlives
 * its lease; meanwhile the pull request moves the item to In Review (AGENTS.md
 * §8.3), and Review cannot be claimed. The agent that held the last claim may
 * still file its completed run there — within LATE_RUN_WINDOW_MS of the lease
 * ending, while nobody else holds the work — without moving the item back to
 * In Progress. Anyone else still needs a live claim.
 */

export const LATE_RUN_WINDOW_MS = 72 * 60 * 60_000;

export const LATE_RUN_REFUSED_MESSAGE =
  'This work is In Review and you hold no live claim. A completed run can be filed here without a claim only by the agent whose claim on it expired in the last 72 hours, while no one else holds it (INV-1704).';

export function lateRunReason(publicId: string, expiredAt: Date): string {
  return `${publicId} filed after the claim expired at ${expiredAt.toISOString()}, while the work was already In Review (INV-1704).`;
}

/**
 * When `actorId` held the last claim on this In Review work and it ended within
 * the window: the moment it expired. Null otherwise.
 */
export async function lateRunAllowance(
  tx: Prisma.TransactionClient,
  work: Issue,
  actorId: string,
  now = new Date(),
): Promise<{ expiredAt: Date; staleClaimId: string | null } | null> {
  const state = await tx.workflowState.findUnique({ where: { id: work.stateId }, select: { type: true } });
  if (state?.type !== 'REVIEW') return null;
  const since = new Date(now.getTime() - LATE_RUN_WINDOW_MS);
  const claims = await tx.workClaim.findMany({ where: { workId: work.id } });
  // Someone holds it now: they file, not the earlier holder.
  if (claims.some((claim) => claim.leaseUntil > now)) return null;
  // The lease ran out but the sweep has not removed it yet.
  const stale = claims.find((claim) => claim.actorId === actorId && claim.leaseUntil > since);
  if (stale) return { expiredAt: stale.leaseUntil, staleClaimId: stale.id };
  if (claims.length > 0) return null;
  // The sweep removed it and said so (claim-expiry.ts): the latest expiry on this work must be this actor's.
  const [latest] = await tx.eventOutbox.findMany({
    where: { type: 'work.claim_expired', createdAt: { gte: since }, payload: { path: ['work', 'id'], equals: work.id } },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { payload: true },
  });
  const data = (latest?.payload as { data?: { expiredActorId?: unknown; leaseUntil?: unknown } } | undefined)?.data;
  if (!data || data.expiredActorId !== actorId || typeof data.leaseUntil !== 'string') return null;
  const expiredAt = new Date(data.leaseUntil);
  return expiredAt > since ? { expiredAt, staleClaimId: null } : null;
}
