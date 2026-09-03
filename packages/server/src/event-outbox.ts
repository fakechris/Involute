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
  // Present for database-backed subscriptions (absent for legacy env targets,
  // which match every event). Mirrors Linear's per-webhook secret + team /
  // resource scoping.
  subscriptionId?: string;
  teamId?: string | null;
  eventTypes?: string[];
}

export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 10;

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

  // Subscriptions are distinct delivery identities even when they share a URL
  // (different secrets/teams): collapse only truly identical targets so one
  // slow webhook cannot head-of-line block the others and terminal evaluation
  // stays per identity.
  const distinctTargets = [...new Map(targets.map((target) => [targetIdentity(target), target])).values()];

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
  const eventTeams = await loadEventTeams(prisma, pending);

  let delivered = 0;
  let failed = 0;

  for (const event of pending) {
    // Mutual exclusion: overlapping ticks (2s interval) or multiple replicas
    // race here; only the winner processes the event. Losers skip silently.
    // The claim timestamp fences the final write below: if another worker
    // stole the claim mid-delivery (lease expiry after a >60s stall), our
    // finalization is skipped and the owner retries. Duplicate POSTs across
    // such stalls remain possible by design (at-least-once) and are deduped
    // by receivers on the involute-delivery header.
    const claimTime = new Date();
    const claimed = await prisma.eventOutbox.updateMany({
      where: {
        id: event.id,
        deliveredAt: null,
        deadLetteredAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lt: claimCutoff } }],
      },
      data: { claimedAt: claimTime },
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

    // Subscription routing: env targets match everything; subscriptions match
    // on team (null = all teams) and event type (empty = all types). Events
    // nobody subscribes to are marked delivered so they never wedge the queue.
    const eventTargets = distinctTargets.filter((target) =>
      targetMatchesEvent(target, event.type, eventTeams.get(event.id) ?? null),
    );
    if (eventTargets.length === 0) {
      await prisma.eventOutbox.updateMany({
        where: { id: event.id, claimedAt: claimTime },
        data: { attempts: { increment: 1 }, claimedAt: null, deliveredAt: new Date() },
      });
      delivered += 1;
      continue;
    }

    // Deliver to all targets concurrently: one slow webhook must not
    // head-of-line block the others.
    const outcomes = await Promise.all(
      eventTargets.map(async (target) => deliverToTarget(prisma, event, target, body, fetchImpl)),
    );
    const targetHashes = eventTargets.map((target) => targetHashFor(target));

    if (outcomes.every((outcome) => outcome.ok)) {
      const finalized = await prisma.eventOutbox.updateMany({
        where: { id: event.id, claimedAt: claimTime },
        data: {
          attempts: { increment: 1 },
          claimedAt: null,
          deliveredAt: new Date(),
          lastError: null,
        },
      });
      if (finalized.count === 1) {
        delivered += 1;
        await accountSubscriptionOutcomes(prisma, eventTargets, outcomes);
      }
    } else {
      const deliveries = await prisma.eventOutboxDelivery.findMany({
        where: { eventId: event.id, targetHash: { in: targetHashes } },
      });
      // Dead-letter only when NO target can still succeed (every target is
      // delivered or exhausted). A single exhausted target must not starve
      // the remaining retryable targets.
      const allTerminal =
        deliveries.length === eventTargets.length &&
        deliveries.every((delivery) => delivery.deliveredAt || delivery.attempts >= MAX_DELIVERY_ATTEMPTS);
      const anyExhausted = deliveries.some(
        (delivery) => !delivery.deliveredAt && delivery.attempts >= MAX_DELIVERY_ATTEMPTS,
      );
      const finalized = await prisma.eventOutbox.updateMany({
        where: { id: event.id, claimedAt: claimTime },
        data: {
          attempts: { increment: 1 },
          claimedAt: null,
          ...(allTerminal && anyExhausted ? { deadLetteredAt: new Date() } : {}),
          lastError: outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.error).join('; '),
        },
      });
      if (finalized.count === 1) {
        failed += 1;
        await accountSubscriptionOutcomes(prisma, eventTargets, outcomes);
      }
    }
  }

  return { delivered, failed };
}

function targetMatchesEvent(target: WebhookTarget, eventType: string, eventTeamId: string | null): boolean {
  if (!target.subscriptionId) {
    return true;
  }
  if (target.teamId && target.teamId !== eventTeamId) {
    return false;
  }
  if (target.eventTypes && target.eventTypes.length > 0 && !target.eventTypes.includes(eventType)) {
    return false;
  }
  return true;
}

async function loadEventTeams(
  prisma: PrismaClient,
  events: Array<{ id: string; payload: unknown }>,
): Promise<Map<string, string>> {
  // One work id can back many events (proposed/committed/claimed/...), so fan
  // out: every event sharing a work id gets that work's team. A work→single
  // event map would silently drop team-scoped deliveries for the losers.
  const eventIdsByWorkId = new Map<string, string[]>();
  for (const event of events) {
    const workId = (event.payload as { work?: { id?: unknown } } | null)?.work?.id;
    if (typeof workId === 'string') {
      const bucket = eventIdsByWorkId.get(workId) ?? [];
      bucket.push(event.id);
      eventIdsByWorkId.set(workId, bucket);
    }
  }
  if (eventIdsByWorkId.size === 0) {
    return new Map();
  }
  const issues = await prisma.issue.findMany({
    where: { id: { in: [...eventIdsByWorkId.keys()] } },
    select: { id: true, teamId: true },
  });
  const teams = new Map<string, string>();
  for (const issue of issues) {
    for (const eventId of eventIdsByWorkId.get(issue.id) ?? []) {
      teams.set(eventId, issue.teamId);
    }
  }
  return teams;
}

async function accountSubscriptionOutcomes(
  prisma: PrismaClient,
  targets: WebhookTarget[],
  outcomes: Array<{ attempts: number; ok: boolean }>,
): Promise<void> {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const outcome = outcomes[index];
    if (!target?.subscriptionId || !outcome) {
      continue;
    }
    if (outcome.ok) {
      await prisma.webhookSubscription.updateMany({
        where: { id: target.subscriptionId, consecutiveFailures: { gt: 0 } },
        data: { consecutiveFailures: 0 },
      });
      continue;
    }
    // Only exhausted deliveries count toward auto-disable; transient failures
    // keep retrying without penalty, mirroring Linear's persistent-failure rule.
    if (outcome.attempts >= MAX_DELIVERY_ATTEMPTS) {
      const subscription = await prisma.webhookSubscription.update({
        where: { id: target.subscriptionId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
      });
      if (subscription.consecutiveFailures >= WEBHOOK_AUTO_DISABLE_THRESHOLD) {
        await prisma.webhookSubscription.update({
          where: { id: target.subscriptionId },
          data: { enabled: false },
        });
      }
    }
  }
}

function targetIdentity(target: WebhookTarget): string {
  return [
    target.url,
    target.secret,
    target.subscriptionId ?? '',
    target.teamId ?? '',
    (target.eventTypes ?? []).join(','),
  ].join('\0');
}

function targetHashFor(target: WebhookTarget): string {
  // Subscription-scoped hash: two subscriptions sharing one URL keep separate
  // delivery rows so each secret-signed POST is tracked independently.
  return createHash('sha256').update(targetIdentity(target)).digest('hex');
}

async function deliverToTarget(
  prisma: PrismaClient,
  event: { id: string; type: string },
  target: WebhookTarget,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ attempts: number; error: string; ok: boolean }> {
  const targetHash = targetHashFor(target);
  const delivery = await prisma.eventOutboxDelivery.upsert({
    where: { eventId_targetHash: { eventId: event.id, targetHash } },
    create: { eventId: event.id, targetHash },
    update: {},
  });
  if (delivery.deliveredAt) {
    return { attempts: delivery.attempts, error: '', ok: true };
  }
  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { attempts: delivery.attempts, error: delivery.lastError ?? `Webhook ${target.url} exhausted retries`, ok: false };
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
    const recorded = await prisma.eventOutboxDelivery.update({
      where: { id: delivery.id },
      data: { attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null },
    });
    return { attempts: recorded.attempts, error: '', ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recorded = await prisma.eventOutboxDelivery.update({
      where: { id: delivery.id },
      data: { attempts: { increment: 1 }, lastError: message },
    });
    return { attempts: recorded.attempts, error: message, ok: false };
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

// Linear-style routing: database subscriptions win when any enabled one
// exists; otherwise fall back to the legacy shared env pair so existing
// deployments keep working without migration steps.
export async function collectOutboundWebhookTargets(
  prisma: PrismaClient,
  envUrl: string | null | undefined,
  envSecret: string | null | undefined,
): Promise<WebhookTarget[]> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  });
  if (subscriptions.length === 0) {
    return parseWebhookTargets(envUrl, envSecret);
  }
  return subscriptions.map((subscription) => ({
    eventTypes: subscription.eventTypes,
    secret: subscription.secret,
    subscriptionId: subscription.id,
    teamId: subscription.teamId,
    url: subscription.url,
  }));
}
