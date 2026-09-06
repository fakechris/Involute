import { createHash, createHmac } from 'node:crypto';

import { compileIqlPredicate, parseIqlOrThrow } from './iql-compile.js';

import type { Issue, Prisma, PrismaClient, WorkflowStateType } from '@prisma/client';

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
  'webhook.disabled',
] as const;

export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
// How long a flush claim on an outbox row is honored before another flush
// tick may steal it (crash recovery). The claim is always released when the
// event finishes processing, so this only matters if a process dies mid-flush.
export const OUTBOX_CLAIM_LEASE_MS = 60_000;
// Retry schedule per failed delivery (base delays, ±20% jitter). Five
// attempts spread over roughly half a day: transient receiver outages no
// longer burn all retries in seconds, and stubborn endpoints dead-letter
// instead of retrying forever.
export const BACKOFF_SCHEDULE_MS = [60_000, 300_000, 1_800_000, 7_200_000, 36_000_000] as const;
export const BACKOFF_JITTER_RATIO = 0.2;
const MAX_DELIVERY_ATTEMPTS = BACKOFF_SCHEDULE_MS.length;
// HTTP statuses that mean "stop calling us" rather than "try again": retrying
// a 400/401/404 wastes the whole schedule. 408 (timeout) and 429 (rate limit)
// explicitly ask the caller to come back later.
const NON_RETRYABLE_STATUS_MIN = 400;
const RETRYABLE_4XX_STATUSES = new Set([408, 429]);

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
  /** IQL filter evaluated against the work snapshot at delivery time. */
  filterQuery?: string | null;
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
): Promise<{ id: string }> {
  const event = await prisma.eventOutbox.create({
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
    select: { id: true },
  });
  return { id: event.id };
}

// Internal event for subscription auto-disable (no work node behind it).
// Consumed by the notification projector and by any all-teams subscription.
export async function enqueueWebhookDisabledEvent(
  prisma: PrismaClient,
  subscription: { id: string; url: string; label: string | null; consecutiveFailures: number },
): Promise<{ id: string }> {
  const event = await prisma.eventOutbox.create({
    data: {
      type: 'webhook.disabled',
      payload: {
        type: 'webhook.disabled',
        subscription: {
          id: subscription.id,
          url: subscription.url,
          label: subscription.label,
          consecutiveFailures: subscription.consecutiveFailures,
        },
      },
    },
    select: { id: true },
  });
  return { id: event.id };
}

interface DeliveryOutcome {
  attempts: number;
  error: string;
  ok: boolean;
  // True when the delivery is healthy but waiting on its backoff window; the
  // event must stay open without counting this as another failure.
  pending: boolean;
}

export interface FlushOutboxOptions {
  // Test clock: overrides "now" for backoff due-checks and retry scheduling.
  now?: number;
}

export async function flushEventOutbox(
  prisma: PrismaClient,
  targets: WebhookTarget[],
  fetchImpl: typeof fetch = fetch,
  limit = 20,
  options: FlushOutboxOptions = {},
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
  const now = options.now ?? Date.now();
  const pending = await prisma.eventOutbox.findMany({
    where: {
      deliveredAt: null,
      deadLetteredAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: claimCutoff } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  // Skip events whose deliveries are all mid-backoff without claiming them:
  // claiming would churn the row every tick until the backoff elapses.
  const dueEventIds = await filterDueEventIds(prisma, pending, now);

  const eventTeams = await loadEventTeams(prisma, pending);
  const workSnapshots = await loadWorkSnapshots(prisma, pending);

  let delivered = 0;
  let failed = 0;

  for (const event of pending) {
    if (!dueEventIds.has(event.id)) {
      continue;
    }

    // Mutual exclusion: overlapping ticks or multiple replicas race here; only
    // the winner processes the event. Losers skip silently. The claim
    // timestamp fences the final write below: if another worker stole the
    // claim mid-delivery (lease expiry after a >60s stall), our finalization
    // is skipped and the owner retries. Duplicate POSTs across such stalls
    // remain possible by design (at-least-once); receivers dedupe on the
    // stable involute-event-id / event_id.
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

    // Subscription routing: env targets match everything; subscriptions match
    // on team (null = all teams) and event type (empty = all types). Events
    // nobody subscribes to are marked delivered so they never wedge the queue.
    const eventWorkId = (event.payload as { work?: { id?: unknown } } | null)?.work?.id;
    const eventWork = typeof eventWorkId === 'string' ? workSnapshots.get(eventWorkId) ?? null : null;
    const eventTargets = distinctTargets.filter((target) =>
      targetMatchesEvent(target, event.type, eventTeams.get(event.id) ?? null, eventWork),
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
      eventTargets.map(async (target) => deliverToTarget(prisma, event, target, fetchImpl, now)),
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
      // delivered or exhausted). Pending backoff keeps the event open: a
      // target waiting on its next retry slot must not starve or kill the
      // others.
      const allResolved =
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
          ...(allResolved && anyExhausted ? { deadLetteredAt: new Date() } : {}),
          lastError: outcomes.filter((outcome) => !outcome.ok && !outcome.pending).map((outcome) => outcome.error).join('; ')
            || outcomes.find((outcome) => outcome.pending)?.error
            || null,
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

async function filterDueEventIds(
  prisma: PrismaClient,
  events: Array<{ id: string }>,
  now: number,
): Promise<Set<string>> {
  const due = new Set<string>();
  if (events.length === 0) {
    return due;
  }

  const deliveries = await prisma.eventOutboxDelivery.findMany({
    where: { eventId: { in: events.map((event) => event.id) } },
    select: { eventId: true, deliveredAt: true, attempts: true, nextAttemptAt: true },
  });
  const deliveriesByEvent = new Map<string, typeof deliveries>();
  for (const delivery of deliveries) {
    const bucket = deliveriesByEvent.get(delivery.eventId) ?? [];
    bucket.push(delivery);
    deliveriesByEvent.set(delivery.eventId, bucket);
  }

  for (const event of events) {
    const eventDeliveries = deliveriesByEvent.get(event.id);
    // No delivery rows yet: first delivery attempt, always due.
    if (!eventDeliveries || eventDeliveries.length === 0) {
      due.add(event.id);
      continue;
    }
    if (
      eventDeliveries.some(
        (delivery) =>
          !delivery.deliveredAt &&
          delivery.attempts < MAX_DELIVERY_ATTEMPTS &&
          (!delivery.nextAttemptAt || delivery.nextAttemptAt.getTime() <= now),
      )
    ) {
      due.add(event.id);
    }
  }
  return due;
}

export type WorkSnapshot = Issue & {
  state: { id: string; name: string; type: WorkflowStateType } | null;
  assignee: { id: string; actorKind: string } | null;
  labels: Array<{ name: string }>;
};

function targetMatchesEvent(
  target: WebhookTarget,
  eventType: string,
  eventTeamId: string | null,
  work: WorkSnapshot | null,
): boolean {
  if (!target.subscriptionId) {
    return true;
  }
  if (target.teamId && target.teamId !== eventTeamId) {
    return false;
  }
  if (target.eventTypes && target.eventTypes.length > 0 && !target.eventTypes.includes(eventType)) {
    return false;
  }
  // Per-subscription IQL filter, evaluated against the work snapshot. A work
  // row can no longer be resolved (deleted between enqueue and flush) only
  // matches filters that reject everything anyway — skip such subscriptions.
  if (target.filterQuery?.trim()) {
    if (!work) {
      return false;
    }
    try {
      const predicate = compileIqlPredicate(parseIqlOrThrow(target.filterQuery), { viewerId: null });
      if (!predicate(work)) {
        return false;
      }
    } catch {
      // Malformed saved filters must not wedge the delivery pipeline.
      return false;
    }
  }
  return true;
}

async function loadEventTeams(
  prisma: PrismaClient,
  events: Array<{ id: string; payload: unknown }>,
): Promise<Map<string, string>> {
  const teams = new Map<string, string>();
  const snapshots = await loadWorkSnapshots(prisma, events);
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
  for (const [workId, eventIdList] of eventIdsByWorkId) {
    const snapshot = snapshots.get(workId);
    if (!snapshot) {
      continue;
    }
    for (const eventId of eventIdList) {
      teams.set(eventId, snapshot.teamId);
    }
  }
  return teams;
}

// Snapshots back both team routing and IQL subscription filters; one query
// covers the whole flush batch.
async function loadWorkSnapshots(
  prisma: PrismaClient,
  events: Array<{ id: string; payload: unknown }>,
): Promise<Map<string, WorkSnapshot>> {
  const snapshots = new Map<string, WorkSnapshot>();
  const workIds = new Set<string>();
  for (const event of events) {
    const workId = (event.payload as { work?: { id?: unknown } } | null)?.work?.id;
    if (typeof workId === 'string') {
      workIds.add(workId);
    }
  }
  if (workIds.size === 0) {
    return snapshots;
  }
  const issues = await prisma.issue.findMany({
    where: { id: { in: [...workIds] } },
    include: {
      state: { select: { id: true, name: true, type: true } },
      assignee: { select: { id: true, actorKind: true } },
      labels: { select: { name: true } },
    },
  });
  for (const issue of issues) {
    snapshots.set(issue.id, issue as WorkSnapshot);
  }
  return snapshots;
}

async function accountSubscriptionOutcomes(
  prisma: PrismaClient,
  targets: WebhookTarget[],
  outcomes: DeliveryOutcome[],
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
    if (outcome.pending) {
      continue;
    }
    // Only exhausted deliveries count toward auto-disable; transient failures
    // keep retrying without penalty, mirroring Linear's persistent-failure rule.
    if (outcome.attempts >= MAX_DELIVERY_ATTEMPTS) {
      const subscription = await prisma.webhookSubscription.update({
        where: { id: target.subscriptionId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true, url: true, label: true },
      });
      if (subscription.consecutiveFailures >= WEBHOOK_AUTO_DISABLE_THRESHOLD) {
        const disabled = await prisma.webhookSubscription.update({
          where: { id: target.subscriptionId },
          data: { enabled: false },
        });
        const event = await enqueueWebhookDisabledEvent(prisma, {
          id: disabled.id,
          url: disabled.url,
          label: disabled.label,
          consecutiveFailures: disabled.consecutiveFailures,
        });
        const { projectWebhookDisabledNotifications } = await import('./notification-service.js');
        await projectWebhookDisabledNotifications(prisma, {
          eventId: event.id,
          subscription: {
            consecutiveFailures: disabled.consecutiveFailures,
            createdById: disabled.createdById,
            label: disabled.label,
            url: disabled.url,
          },
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

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const clamped = Math.min(Math.max(attempt - 1, 0), BACKOFF_SCHEDULE_MS.length - 1);
  const base = BACKOFF_SCHEDULE_MS[clamped] ?? BACKOFF_SCHEDULE_MS[0]!;
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER_RATIO;
  return Math.round(base * jitter);
}

async function deliverToTarget(
  prisma: PrismaClient,
  event: { id: string; type: string; payload: unknown; createdAt: Date },
  target: WebhookTarget,
  fetchImpl: typeof fetch,
  now: number,
): Promise<DeliveryOutcome> {
  const targetHash = targetHashFor(target);
  const delivery = await prisma.eventOutboxDelivery.upsert({
    where: { eventId_targetHash: { eventId: event.id, targetHash } },
    create: { eventId: event.id, targetHash },
    update: {},
  });
  if (delivery.deliveredAt) {
    return { attempts: delivery.attempts, error: '', ok: true, pending: false };
  }
  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { attempts: delivery.attempts, error: delivery.lastError ?? `Webhook ${target.url} exhausted retries`, ok: false, pending: false };
  }
  if (delivery.nextAttemptAt && delivery.nextAttemptAt.getTime() > now) {
    return { attempts: delivery.attempts, error: delivery.lastError ?? '', ok: false, pending: true };
  }

  const attemptNumber = delivery.attempts + 1;
  // event_id is stable across retries (receiver-side dedupe); delivery_id is
  // unique per attempt so duplicate POSTs from claim races stay
  // distinguishable.
  const deliveryId = `${delivery.id}:${attemptNumber}`;
  const body = JSON.stringify({
    ...(event.payload as object),
    id: event.id,
    event_id: event.id,
    delivery_id: deliveryId,
    occurred_at: event.createdAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
  });

  try {
    const signature = createHmac('sha256', target.secret).update(body).digest('hex');
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'involute-delivery': deliveryId,
        'involute-event': event.type,
        'involute-event-id': event.id,
        'involute-attempt': String(attemptNumber),
        'involute-signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const retryable =
        response.status >= 500 || RETRYABLE_4XX_STATUSES.has(response.status);
      if (!retryable) {
        // 4xx (except 408/429) means the receiver rejects the payload; burning
        // the remaining schedule on it would only spam their logs.
        const message = `Webhook ${target.url} returned ${response.status} (not retryable)`;
        await prisma.eventOutboxDelivery.update({
          where: { id: delivery.id },
          data: { attempts: MAX_DELIVERY_ATTEMPTS, lastError: message },
        });
        return { attempts: MAX_DELIVERY_ATTEMPTS, error: message, ok: false, pending: false };
      }
      throw new Error(`Webhook ${target.url} returned ${response.status}`);
    }
    const recorded = await prisma.eventOutboxDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attemptNumber,
        deliveredAt: new Date(),
        nextAttemptAt: null,
        lastError: null,
      },
    });
    return { attempts: recorded.attempts, error: '', ok: true, pending: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attemptNumber >= MAX_DELIVERY_ATTEMPTS;
    await prisma.eventOutboxDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attemptNumber,
        lastError: message,
        ...(exhausted ? {} : { nextAttemptAt: new Date(now + backoffDelayMs(attemptNumber)) }),
      },
    });
    return { attempts: attemptNumber, error: message, ok: false, pending: false };
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
    filterQuery: subscription.filterQuery,
    secret: subscription.secret,
    subscriptionId: subscription.id,
    teamId: subscription.teamId,
    url: subscription.url,
  }));
}
