import type { Prisma, PrismaClient } from '@prisma/client';

import type { GraphQLContext } from './auth.js';
import {
  OPS_ADMIN_ONLY_MESSAGE,
  OPS_DEAD_LETTER_NOT_FOUND_MESSAGE,
  OPS_INBOUND_NOT_REPLAYABLE_MESSAGE,
  OPS_REASON_REQUIRED_MESSAGE,
  createNotAuthenticatedError,
  createNotFoundError,
  createValidationError,
} from './errors.js';
import { replayGitHubDelivery } from './github-inbound.js';

/**
 * The ops page (INV-796): what AGENTS.md §9 used to do in SQL or the CLI —
 * sync watermarks, sync dead letters, the inbound GitHub queue, failed outbox
 * events — readable and recoverable by a workspace admin, with every action
 * on the ops audit.
 */

const WATERMARK_PREFIX = 'github_sync_';
const LIST_LIMIT = 50;

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export function assertOpsAdmin(context: GraphQLContext): void {
  if (context.isTrustedSystem) return;
  if (!context.viewer) throw createNotAuthenticatedError();
  // A person with admin rights, as for workspace settings (INV-797).
  if (context.viewer.actorKind !== 'HUMAN' || context.viewer.globalRole !== 'ADMIN') {
    throw createValidationError(OPS_ADMIN_ONLY_MESSAGE);
  }
}

export async function recordOpsAudit(
  db: DatabaseClient,
  input: { action: string; subject: string; byActorId: string | null; reason?: string | null; details?: Prisma.InputJsonValue },
): Promise<void> {
  await db.opsAudit.create({
    data: {
      action: input.action,
      subject: input.subject,
      byActorId: input.byActorId,
      reason: input.reason ?? null,
      details: input.details ?? {},
    },
  });
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (!trimmed || trimmed.length > 2_000) throw createValidationError(OPS_REASON_REQUIRED_MESSAGE);
  return trimmed;
}

export async function readOpsOverview(prisma: PrismaClient) {
  const [watermarks, syncDeadLetters, inboundCounts, oldestPending, inboundDead, outboxFailures, audits] = await Promise.all([
    prisma.syncWatermark.findMany({ orderBy: { updatedAt: 'desc' } }),
    prisma.syncDeadLetter.findMany({ orderBy: { lastFailedAt: 'desc' }, take: LIST_LIMIT }),
    prisma.inboundGitHubDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.inboundGitHubDelivery.findFirst({
      where: { status: { in: ['PENDING', 'RETRY', 'PROCESSING'] } },
      orderBy: { receivedAt: 'asc' },
      select: { receivedAt: true },
    }),
    prisma.inboundGitHubDelivery.findMany({
      where: { status: 'DEAD' },
      orderBy: { receivedAt: 'desc' },
      take: LIST_LIMIT,
      select: {
        id: true,
        deliveryId: true,
        eventType: true,
        repository: true,
        attempts: true,
        lastErrorCode: true,
        receivedAt: true,
        payload: true,
      },
    }),
    prisma.eventOutbox.findMany({
      where: { deliveredAt: null, OR: [{ deadLetteredAt: { not: null } }, { lastError: { not: null } }] },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      select: { id: true, type: true, attempts: true, lastError: true, createdAt: true, deadLetteredAt: true },
    }),
    prisma.opsAudit.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  return {
    watermarks: watermarks.map((row) => ({
      key: row.key,
      repository: row.key.startsWith(WATERMARK_PREFIX) ? row.key.slice(WATERMARK_PREFIX.length) : row.key,
      watermark: row.watermark,
      updatedAt: row.updatedAt,
    })),
    syncDeadLetters,
    inbound: {
      counts: inboundCounts.map((row) => ({ status: row.status, count: row._count._all })),
      oldestPendingAt: oldestPending?.receivedAt ?? null,
      dead: inboundDead.map(({ payload, ...row }) => ({ ...row, replayable: payload !== null })),
    },
    outboxFailures,
    audits,
  };
}

/**
 * Deleting the dead letter is the recovery (§9.3): the next reconciliation
 * cycle fetches that PR again and retries it.
 */
export async function clearSyncDeadLetter(prisma: PrismaClient, input: { id: string; reason: string; byActorId: string | null }) {
  const reason = requireReason(input.reason);
  return prisma.$transaction(async (tx) => {
    const row = await tx.syncDeadLetter.findUnique({ where: { id: input.id } }).catch(() => null);
    if (!row) throw createNotFoundError(OPS_DEAD_LETTER_NOT_FOUND_MESSAGE);
    await tx.syncDeadLetter.delete({ where: { id: row.id } });
    await recordOpsAudit(tx, {
      action: 'sync-dead-letter-cleared',
      subject: `${row.repository} ${row.itemRef}`,
      byActorId: input.byActorId,
      reason,
      details: { attempts: row.attempts, error: row.error, lastFailedAt: row.lastFailedAt.toISOString() },
    });
    return row;
  });
}

/** Same replay as `github:inbound replay`, recorded as coming from the ops page. */
export async function replayInboundDelivery(
  prisma: PrismaClient,
  input: { id: string; reason: string; expectedAttempts: number; byActorId: string | null },
) {
  const reason = requireReason(input.reason);
  let replayed;
  try {
    replayed = await replayGitHubDelivery(prisma, input.id, reason, input.expectedAttempts, 'ops-page');
  } catch {
    throw createValidationError(OPS_INBOUND_NOT_REPLAYABLE_MESSAGE);
  }
  await recordOpsAudit(prisma, {
    action: 'inbound-replayed',
    subject: `${replayed.repository} ${replayed.eventType} ${replayed.deliveryId}`,
    byActorId: input.byActorId,
    reason,
    details: { previousAttempts: input.expectedAttempts },
  });
  return replayed;
}
