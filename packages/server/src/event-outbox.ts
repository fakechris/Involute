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

  const pending = await prisma.eventOutbox.findMany({
    where: {
      deliveredAt: null,
      deadLetteredAt: null,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let delivered = 0;
  let failed = 0;

  for (const event of pending) {
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt.toISOString(),
      ...(event.payload as object),
    });

    const targetResults: boolean[] = [];
    const targetErrors: string[] = [];
    for (const target of targets) {
      const targetHash = createHash('sha256').update(target.url).digest('hex');
      const delivery = await prisma.eventOutboxDelivery.upsert({
        where: { eventId_targetHash: { eventId: event.id, targetHash } },
        create: { eventId: event.id, targetHash },
        update: {},
      });
      if (delivery.deliveredAt) {
        targetResults.push(true);
        continue;
      }
      if (delivery.attempts >= 8) {
        targetResults.push(false);
        targetErrors.push(delivery.lastError ?? `Webhook ${target.url} exhausted retries`);
        continue;
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
        });

        if (!response.ok) {
          throw new Error(`Webhook ${target.url} returned ${response.status}`);
        }
        await prisma.eventOutboxDelivery.update({
          where: { id: delivery.id },
          data: { attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null },
        });
        targetResults.push(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.eventOutboxDelivery.update({
          where: { id: delivery.id },
          data: { attempts: { increment: 1 }, lastError: message },
        });
        targetResults.push(false);
        targetErrors.push(message);
      }
    }

    if (targetResults.every(Boolean)) {
      await prisma.eventOutbox.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          deliveredAt: new Date(),
          lastError: null,
        },
      });
      delivered += 1;
    } else {
      failed += 1;
      const deliveries = await prisma.eventOutboxDelivery.findMany({
        where: {
          eventId: event.id,
          targetHash: { in: targets.map((target) => createHash('sha256').update(target.url).digest('hex')) },
        },
      });
      const deadLettered = deliveries.some((delivery) => !delivery.deliveredAt && delivery.attempts >= 8);
      await prisma.eventOutbox.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          ...(deadLettered ? { deadLetteredAt: new Date() } : {}),
          lastError: targetErrors.join('; '),
        },
      });
    }
  }

  return { delivered, failed };
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
