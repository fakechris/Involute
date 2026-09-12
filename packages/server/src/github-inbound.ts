import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type InboundGitHubDelivery } from '@prisma/client';
import { emitOpsAlert, type DeferredOpsAlert } from './ops-alerts.js';

export const INBOUND_LEASE_MS = 60_000;
const MAX_FAILURES = 3;
const PROCESS_TIMEOUT_MS = 20_000;

export class InboundRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export interface InboundEnvelope {
  deliveryId: string;
  eventType: string;
  repository: string;
  payload: Prisma.InputJsonObject;
  rawBody: Buffer;
}

/** A successful return means a durable, uniquely identified receipt exists. */
export async function acceptGitHubDelivery(prisma: PrismaClient, input: InboundEnvelope) {
  const payloadHash = createHash('sha256').update(input.rawBody).digest('hex');
  return prisma.$transaction(async tx => {
    await tx.inboundGitHubDelivery.createMany({ data: {
      id: randomUUID(), provider: 'github', deliveryId: input.deliveryId,
      eventType: input.eventType, repository: input.repository,
      payload: input.payload, payloadHash,
    }, skipDuplicates: true });
    const receipt = await tx.inboundGitHubDelivery.findUniqueOrThrow({
      where: { provider_deliveryId: { provider: 'github', deliveryId: input.deliveryId } },
    });
    if (receipt.payloadHash !== payloadHash || receipt.eventType !== input.eventType || receipt.repository !== input.repository) {
      throw new InboundRequestError(409, 'DELIVERY_PAYLOAD_CONFLICT');
    }
    return receipt;
  });
}

export async function claimGitHubDelivery(prisma: PrismaClient): Promise<InboundGitHubDelivery | null> {
  const now = new Date();
  const eligible: Prisma.InboundGitHubDeliveryWhereInput = { OR: [
    { status: { in: ['PENDING', 'RETRY'] }, availableAt: { lte: now } },
    { status: 'PROCESSING', leaseUntil: { lte: now } },
  ] };
  return prisma.$transaction(async tx => {
    const next = await tx.inboundGitHubDelivery.findFirst({
      where: eligible, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    if (!next) return null;
    const token = randomUUID();
    const won = await tx.inboundGitHubDelivery.updateMany({
      where: { id: next.id, AND: [eligible] },
      data: { status: 'PROCESSING', leaseOwner: token, leaseUntil: new Date(Date.now() + INBOUND_LEASE_MS), attempts: { increment: 1 } },
    });
    if (!won.count) return null;
    await tx.inboundGitHubAttempt.updateMany({
      where: { deliveryId: next.id, outcome: 'PROCESSING' },
      data: { outcome: 'EXPIRED', errorCode: 'LEASE_EXPIRED', endedAt: new Date() },
    });
    const claimed = await tx.inboundGitHubDelivery.findUniqueOrThrow({ where: { id: next.id } });
    await tx.inboundGitHubAttempt.create({ data: { deliveryId: next.id, number: claimed.attempts, leaseOwner: token } });
    return claimed;
  });
}

export type GitHubDeliveryProcessor = (
  tx: Prisma.TransactionClient,
  receipt: InboundGitHubDelivery,
) => Promise<DeferredOpsAlert[]>;

class LeaseLostError extends Error {}

/** Business effects, dedupe, outbox and receipt completion share one transaction. */
export async function processClaimedGitHubDelivery(
  prisma: PrismaClient,
  receipt: InboundGitHubDelivery,
  processEvent: GitHubDeliveryProcessor,
): Promise<'processed' | 'retry' | 'dead' | 'stale'> {
  try {
    const deferred = await prisma.$transaction(async tx => {
      // Lock first; an expired worker cannot race a new lease holder's effects.
      await tx.$queryRaw`SELECT id FROM "InboundGitHubDelivery" WHERE id = ${receipt.id}::uuid FOR UPDATE`;
      const current = await tx.inboundGitHubDelivery.findUniqueOrThrow({ where: { id: receipt.id } });
      if (current.status !== 'PROCESSING' || current.leaseOwner !== receipt.leaseOwner || !current.leaseUntil || current.leaseUntil <= new Date()) {
        throw new LeaseLostError();
      }
      if (!current.payload) throw new Error('PAYLOAD_UNAVAILABLE');
      const alerts = await processEvent(tx, current);
      const completed = await tx.inboundGitHubDelivery.updateMany({
        where: { id: current.id, status: 'PROCESSING', leaseOwner: receipt.leaseOwner, leaseUntil: { gt: new Date() } },
        data: { status: 'PROCESSED', processedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null },
      });
      if (!completed.count) throw new LeaseLostError();
      await tx.inboundGitHubAttempt.update({
        where: { deliveryId_number: { deliveryId: current.id, number: current.attempts } },
        data: { outcome: 'PROCESSED', endedAt: new Date() },
      });
      return alerts;
    }, { timeout: PROCESS_TIMEOUT_MS });
    for (const deferredAlert of deferred) await emitOpsAlert(prisma, deferredAlert.alert, deferredAlert.url);
    return 'processed';
  } catch (error) {
    if (error instanceof LeaseLostError) return 'stale';
    const errorCode = safeErrorCode(error);
    const dead = receipt.failureCount + 1 >= MAX_FAILURES;
    const recorded = await prisma.$transaction(async tx => {
      const result = await tx.inboundGitHubDelivery.updateMany({
        where: { id: receipt.id, status: 'PROCESSING', leaseOwner: receipt.leaseOwner },
        data: {
          status: dead ? 'DEAD' : 'RETRY', failureCount: { increment: 1 },
          availableAt: new Date(Date.now() + retryDelayMs(receipt.failureCount)),
          leaseOwner: null, leaseUntil: null, lastErrorCode: errorCode,
        },
      });
      if (!result.count) return false;
      await tx.inboundGitHubAttempt.update({
        where: { deliveryId_number: { deliveryId: receipt.id, number: receipt.attempts } },
        data: { outcome: dead ? 'DEAD' : 'RETRY', errorCode, endedAt: new Date() },
      });
      return true;
    });
    if (!recorded) return 'stale';
    if (dead) await emitOpsAlert(prisma, {
      kind: 'github_inbound.dead_letter', summary: 'GitHub delivery quarantined after repeated failures',
      details: { receiptId: receipt.id, repository: receipt.repository, attempts: receipt.attempts, errorCode },
    }, process.env.OPS_WEBHOOK_URL?.trim() || null);
    return dead ? 'dead' : 'retry';
  }
}

function retryDelayMs(failures: number): number {
  return Math.round(Math.min(300_000, 5_000 * 2 ** failures) * (0.8 + Math.random() * 0.4));
}

/** Log codes only; exception messages may contain private payloads or credentials. */
export function safeErrorCode(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  return 'PROCESSING_FAILED';
}

export async function drainGitHubDeliveries(prisma: PrismaClient, processEvent: GitHubDeliveryProcessor, limit = 20) {
  const counts = { processed: 0, retry: 0, dead: 0, stale: 0 };
  for (let i = 0; i < limit; i += 1) {
    const receipt = await claimGitHubDelivery(prisma);
    if (!receipt) break;
    const outcome = await processClaimedGitHubDelivery(prisma, receipt, processEvent);
    counts[outcome] += 1;
  }
  return counts;
}

/** Retain dedupe tombstones and failed payloads; only compact completed payloads. */
export async function compactGitHubReceipts(prisma: PrismaClient, retentionDays = 30) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be a positive integer');
  return prisma.inboundGitHubDelivery.updateMany({
    where: { status: 'PROCESSED', processedAt: { lt: new Date(Date.now() - retentionDays * 86_400_000) }, payload: { not: Prisma.DbNull } },
    data: { payload: Prisma.DbNull },
  });
}

export async function replayGitHubDelivery(prisma: PrismaClient, id: string, reason: string, expectedAttempts: number) {
  if (!reason.trim() || reason.length > 2_000) throw new Error('A replay reason of 1–2000 characters is required');
  if (!Number.isInteger(expectedAttempts) || expectedAttempts < 0) throw new Error('expectedAttempts must be nonnegative');
  return prisma.$transaction(async tx => {
    const changed = await tx.inboundGitHubDelivery.updateMany({
      where: { id, status: 'DEAD', attempts: expectedAttempts, payload: { not: Prisma.DbNull } },
      data: { status: 'PENDING', failureCount: 0, availableAt: new Date(), lastErrorCode: null, leaseOwner: null, leaseUntil: null },
    });
    if (!changed.count) throw new Error('Replay conflict: receipt must be DEAD with the expected attempt count and retained payload');
    await tx.inboundGitHubReplay.create({ data: { deliveryId: id, reason: reason.trim(), previousAttempts: expectedAttempts } });
    return tx.inboundGitHubDelivery.findUniqueOrThrow({ where: { id } });
  });
}

export async function getGitHubInboundStatus(prisma: PrismaClient) {
  const [counts, oldestPending, dead] = await Promise.all([
    prisma.inboundGitHubDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.inboundGitHubDelivery.findFirst({
      where: { status: { in: ['PENDING', 'RETRY', 'PROCESSING'] } }, orderBy: { receivedAt: 'asc' },
      select: { id: true, receivedAt: true, availableAt: true, status: true },
    }),
    prisma.inboundGitHubDelivery.findMany({
      where: { status: 'DEAD' }, orderBy: { receivedAt: 'asc' }, take: 20,
      select: { id: true, repository: true, attempts: true, lastErrorCode: true },
    }),
  ]);
  return { counts, oldestPending, dead };
}

export function startGitHubInboundWorker(prisma: PrismaClient, processEvent: GitHubDeliveryProcessor, retentionDays = 30) {
  let active: Promise<void> | null = null;
  let stopped = false;
  let lastCompaction = 0;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => {
      await drainGitHubDeliveries(prisma, processEvent);
      if (Date.now() - lastCompaction > 86_400_000) {
        await compactGitHubReceipts(prisma, retentionDays);
        lastCompaction = Date.now();
      }
    })().catch(error => { console.error(`[github-inbound] Worker failed: ${safeErrorCode(error)}`); })
      .finally(() => { active = null; });
  };
  const timer = setInterval(tick, 5_000);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
