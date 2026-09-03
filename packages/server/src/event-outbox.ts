import { createHash, createHmac } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

export const WORK_EVENT_TYPES = [
  'work.proposed',
  'work.committed',
  'work.rejected',
  'work.claimed',
  'run.started',
  'run.blocked',
  'run.completed',
  'decision.requested',
  'artifact.attached',
  'work.review_submitted',
  'work.review_rejected',
  'work.accepted',
] as const;

export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
// How long a flush claim on an outbox row is honored before another flush
// tick may steal it (crash recovery). The claim is always released when the
// event finishes processing, so this only matters if a process dies mid-flush.
export const OUTBOX_CLAIM_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface WebhookTarget {
  secret: string;
  url: string;
}

export interface EnqueueWorkEventInput {
  payload: Prisma.InputJsonValue;
  type: WorkEventType;
  updatedFrom?: Prisma.InputJsonValue | null;
  workId: string;
  workIdentifier: string;
}

export async function enqueueWorkEvent(
  prisma: DatabaseClient,
  input: EnqueueWorkEventInput,
): Promise<void> {
  await prisma.eventOutbox.create({
    data: {
      type: input.type,
      payload: {
        type: input.type,
        work: {
          id: input.workId,
          identifier: input.workIdentifier,
        },
        data: input.payload,
        ...(input.updatedFrom ? { updatedFrom: input.updatedFrom } : {}),
      },
    },
  });
}

export async function flushEventOutbox(
  prisma: PrismaClient,
  targets: WebhookTarget[],
  fetchImpl: typeof fetch = fetch,
  limit = 20,
): Promise<{ delivered: number; failed: number }> {
  if (targets.length === 0) {
    return { delivered: 0, failed: 0 };
  }

  const claimCutoff = new Date(Date.now() - OUTBOX_CLAIM_LEASE_MS);
  const pending = await prisma.eventOutbox.findMany({
    where: {
      deliveredAt: null,
      deadLetteredAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: claimCutoff } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let delivered = 0;
  let failed = 0;

  for (const event of pending) {
    // Mutual exclusion: overlapping ticks (2s interval) or multiple replicas
    // race here; only the winner processes the event. Losers skip silently.
    // The claim is released below, so the lease is crash recovery only.
    const claimed = await prisma.eventOutbox.updateMany({
      where: {
        id: event.id,
        deliveredAt: null,
        deadLetteredAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lt: claimCutoff } }],
      },
      data: { claimedAt: new Date() },
    });
    if (claimed.count !== 1) {
      continue;
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt.toISOString(),
      ...(event.payload as object),
    });

    // Deliver to all targets concurrently: one slow webhook must not
    // head-of-line block the others.
    const outcomes = await Promise.all(
      targets.map(async (target) => deliverToTarget(prisma, event, target, body, fetchImpl)),
    );    const targetHashes = targets.map((target) => targetHashFor(target.url));

    if (outcomes.every((outcome) => outcome.ok)) {
      await prisma.eventOutbox.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          claimedAt: null,
          deliveredAt: new Date(),
          lastError: null,
        },
      });
      delivered += 1;
    } else {
      failed += 1;
      const deliveries = await prisma.eventOutboxDelivery.findMany({
        where: { eventId: event.id, targetHash: { in: targetHashes } },
      });
      // Dead-letter only when NO target can still succeed (every target is
      // delivered or exhausted). A single exhausted target must not starve
      // the remaining retryable targets.
      const allTerminal =
        deliveries.length === targets.length &&
        deliveries.every((delivery) => delivery.deliveredAt || delivery.attempts >= MAX_DELIVERY_ATTEMPTS);
      const anyExhausted = deliveries.some(
        (delivery) => !delivery.deliveredAt && delivery.attempts >= MAX_DELIVERY_ATTEMPTS,
      );
      await prisma.eventOutbox.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          claimedAt: null,
          ...(allTerminal && anyExhausted ? { deadLetteredAt: new Date() } : {}),
          lastError: outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.error).join('; '),
        },
      });
    }
  }

  return { delivered, failed };
}

function targetHashFor(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

async function deliverToTarget(
  prisma: PrismaClient,
  event: { id: string; type: string },
  target: WebhookTarget,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; error: string }> {
  const targetHash = targetHashFor(target.url);
  const delivery = await prisma.eventOutboxDelivery.upsert({
    where: { eventId_targetHash: { eventId: event.id, targetHash } },
    create: { eventId: event.id, targetHash },
    update: {},
  });
  if (delivery.deliveredAt) {
    return { ok: true, error: '' };
  }
  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { ok: false, error: delivery.lastError ?? `Webhook ${target.url} exhausted retries` };
  }

  try {
    const signature = createHmac('sha256', target.secret).update(body).digest('hex');
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'involute-delivery': event.id,
          'involute-event': event.type,
        'involute-signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Webhook ${target.url} returned ${response.status}`);
    }
    await prisma.eventOutboxDelivery.update({
      where: { id: delivery.id },
      data: { attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null },
    });
    return { ok: true, error: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.eventOutboxDelivery.update({
      where: { id: delivery.id },
      data: { attempts: { increment: 1 }, lastError: message },
    });
    return { ok: false, error: message };
  }
}

export function parseWebhookTargets(urlList: string | null | undefined, secret: string | null | undefined): WebhookTarget[] {
  const urls = (urlList ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (urls.length === 0 || !secret) {
    return [];
  }

  return urls.map((url) => ({ url, secret }));
}
