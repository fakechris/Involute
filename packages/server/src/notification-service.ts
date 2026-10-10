import type { Issue, Prisma, PrismaClient } from '@prisma/client';

import type { AttentionKind } from './attention-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

// Recipient cap: an ownerless work must not fan out to an unbounded set of
// humans when notifications are projected inside a write transaction.
const MAX_RECIPIENTS = 10;

/**
 * Human-gate recipients for a work item: the human assignee when there is
 * one, otherwise every human OWNER of the team.
 *
 * Agents are not listed here because their delivery path is the outbox
 * (webhook when a consumer is subscribed, `agent_inbox` when none is) — not
 * because they are excluded from being told things (INV-562). Notifications
 * addressed to a specific person, such as an expired request, resolve their
 * own recipient instead of going through this helper.
 */
export async function resolveHumanRecipients(
  prisma: DatabaseClient,
  work: Pick<Issue, 'assigneeId' | 'teamId'>,
): Promise<string[]> {
  if (work.assigneeId) {
    const assignee = await prisma.user.findUnique({
      where: { id: work.assigneeId },
      select: { actorKind: true, id: true },
    });
    if (assignee?.actorKind === 'HUMAN') {
      return [assignee.id];
    }
  }

  const owners = await prisma.teamMembership.findMany({
    where: { role: 'OWNER', teamId: work.teamId, user: { actorKind: 'HUMAN' } },
    select: { userId: true },
    take: MAX_RECIPIENTS,
  });
  return owners.map((owner) => owner.userId);
}

export interface WorkNotificationInput {
  eventId: string;
  /** Event type, e.g. `decision.requested`, `run.completed`, `work.accepted`. */
  type: string;
  work: Pick<Issue, 'assigneeId' | 'id' | 'teamId'>;
  payload: Prisma.InputJsonValue;
}

/**
 * Project notifications for a work event. Call inside the same transaction
 * that mutated the work row and enqueued the outbox event; the
 * (sourceEventId, userId) unique constraint makes replays and concurrent
 * projections no-ops.
 */
export async function projectWorkNotifications(
  prisma: DatabaseClient,
  input: WorkNotificationInput,
): Promise<void> {
  const userIds = await resolveHumanRecipients(prisma, input.work);
  if (userIds.length === 0) {
    return;
  }
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      payload: input.payload,
      sourceEventId: input.eventId,
      teamId: input.work.teamId,
      type: input.type,
      userId,
      workId: input.work.id,
    })),
    skipDuplicates: true,
  });
}

/**
 * Notify the subscription creator (falling back to human administrators)
 * that a webhook subscription was disabled after persistent delivery
 * failures. Called right after the `webhook.disabled` outbox event is
 * enqueued; `eventId` links the rows to that event.
 */
export async function projectWebhookDisabledNotifications(
  prisma: DatabaseClient,
  input: {
    eventId: string;
    subscription: {
      consecutiveFailures: number;
      createdById?: string | null;
      id: string;
      label: string | null;
      url: string;
    };
  },
): Promise<void> {
  let recipientIds: string[] = [];
  if (input.subscription.createdById) {
    const creator = await prisma.user.findUnique({
      where: { id: input.subscription.createdById },
      select: { actorKind: true, id: true },
    });
    if (creator?.actorKind === 'HUMAN') {
      recipientIds = [creator.id];
    }
  }
  if (recipientIds.length === 0) {
    const admins = await prisma.user.findMany({
      where: { actorKind: 'HUMAN', globalRole: 'ADMIN' },
      select: { id: true },
      take: MAX_RECIPIENTS,
    });
    recipientIds = admins.map((admin) => admin.id);
  }
  if (recipientIds.length === 0) {
    return;
  }
  await prisma.notification.createMany({
    data: recipientIds.map((userId) => ({
      payload: {
        consecutiveFailures: input.subscription.consecutiveFailures,
        label: input.subscription.label,
        // Re-enabling it resolves this notification (INV-1093).
        subscriptionId: input.subscription.id,
        url: input.subscription.url,
      },
      sourceEventId: input.eventId,
      type: 'webhook.disabled',
      userId,
    })),
    skipDuplicates: true,
  });
}

/**
 * Who proposed a work item: the actor on its first audit row. Every surface
 * that creates work (work_propose, workPropose, issueCreate, bug reports)
 * writes that row in the same transaction, so it is the record of authorship.
 * Null when the work was written by the internal actor.
 */
export async function resolveProposerId(prisma: DatabaseClient, workId: string): Promise<string | null> {
  const first = await prisma.workAudit.findFirst({
    where: { workId },
    orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }],
    select: { actorId: true },
  });
  return first?.actorId ?? null;
}

/** The decisions a proposer (and, on review, the run's actor) is told about (INV-968). */
export const DECISION_NOTIFICATION_TYPES = [
  'work.committed',
  'work.rejected',
  'work.uncommitted',
  'work.accepted',
  'work.review_rejected',
  // Delivery authorization decided (INV-990): the delivery proposer may not be the work's proposer.
  'delivery.approved',
  'delivery.declined',
  // Every item derived from a research item is committed; its proposer can close it (INV-1001).
  'research.closable',
  // Every follow-up of an incident is committed; its declarer and Incident Lead can close it (INV-1126).
  'incident.closable',
] as const;
export type DecisionNotificationType = (typeof DECISION_NOTIFICATION_TYPES)[number];

export interface DecisionNotificationInput {
  eventId: string;
  type: DecisionNotificationType;
  work: Pick<Issue, 'id' | 'teamId'>;
  payload: Prisma.InputJsonValue;
  /** Whoever made the decision; never told about their own decision. */
  deciderId: string | null | undefined;
  /** Others the decision is about besides the proposer, e.g. the run's actor on a review. */
  alsoNotify?: ReadonlyArray<string | null | undefined>;
}

/**
 * Tell the actors a decision is about that it was made (INV-968).
 *
 * The proposer is subscribed to their own proposal, the way Linear subscribes
 * an issue's creator. Agents included: a session agent has no webhook, and
 * without this row it can only find out by asking the person who already
 * decided. Delivery is the same Notification table people read in the Inbox;
 * agents read it through agent_inbox. The (sourceEventId, userId) constraint
 * makes a replayed event a no-op.
 */
export async function projectDecisionNotifications(
  prisma: DatabaseClient,
  input: DecisionNotificationInput,
): Promise<void> {
  const proposerId = await resolveProposerId(prisma, input.work.id);
  const ids = new Set(
    [proposerId, ...(input.alsoNotify ?? [])].filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (input.deciderId) ids.delete(input.deciderId);
  if (ids.size === 0) return;
  const recipients = await prisma.user.findMany({
    where: { deactivatedAt: null, id: { in: [...ids] } },
    select: { id: true },
  });
  if (recipients.length === 0) return;
  await prisma.notification.createMany({
    data: recipients.map((recipient) => ({
      payload: input.payload,
      sourceEventId: input.eventId,
      teamId: input.work.teamId,
      type: input.type,
      userId: recipient.id,
      workId: input.work.id,
    })),
    skipDuplicates: true,
  });
}

/**
 * Mark one of the caller's notifications read. Scoped to the caller: someone
 * else's notification is reported as not found, never silently marked.
 * Already-read is a success, so a retry is harmless.
 */
export async function markNotificationRead(
  prisma: DatabaseClient,
  input: { id: string; userId: string },
): Promise<Prisma.NotificationGetPayload<{ include: { work: true } }> | null> {
  await prisma.notification.updateMany({
    where: { id: input.id, readAt: null, userId: input.userId },
    data: { readAt: new Date() },
  });
  return prisma.notification.findFirst({
    include: { work: true },
    where: { id: input.id, userId: input.userId },
  });
}

/**
 * The caller's unread notifications, newest first: what agent_inbox shows an
 * agent next to its open requests. A team-bound agent credential sees the
 * notifications of its team (and the unscoped ones), like its requests.
 */
export async function readUnreadNotifications(
  prisma: DatabaseClient,
  input: { first: number; since: Date | null; teamId: string | null; userId: string },
) {
  return prisma.notification.findMany({
    include: { work: { select: { commitmentStatus: true, identifier: true, title: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.first,
    where: {
      readAt: null,
      userId: input.userId,
      ...(input.since ? { createdAt: { gt: input.since } } : {}),
      ...(input.teamId ? { OR: [{ teamId: input.teamId }, { teamId: null }] } : {}),
    },
  });
}

/**
 * Notifications that ask a person to decide something (INV-1093), with the
 * decision that answers them. Everything else is information. The Needs you
 * queue is the list of open decisions; these rows are how a person was told,
 * and they are resolved — read for everyone, with who decided and how — in
 * the transaction that makes the decision.
 */
export const ACTIONABLE_NOTIFICATION_KINDS = {
  'agent.request_handed_off': 'AGENT_REQUEST',
  'agent.request_input_required': 'AGENT_REQUEST',
  'needinfo.requested': 'AGENT_REQUEST',
  'bug.reported': 'CANDIDATE_COMMIT',
  'contract.amendment_proposed': 'CONTRACT_AMENDMENT',
  'decision.requested': 'DECISION_REQUESTED',
  'delivery.proposed': 'DELIVERY_CHANGE',
  'review.overdue': 'WORK_REVIEW',
  'run.completed': 'WORK_REVIEW',
  'webhook.disabled': 'OPS',
  'work.proposed_batch': 'CANDIDATE_COMMIT',
} as const satisfies Record<string, AttentionKind>;

export function isActionableNotification(type: string): boolean {
  return Object.hasOwn(ACTIONABLE_NOTIFICATION_KINDS, type);
}

function typesOfKind(kind: AttentionKind): string[] {
  return Object.entries(ACTIONABLE_NOTIFICATION_KINDS)
    .filter(([, of]) => of === kind)
    .map(([type]) => type);
}

/**
 * A decision was made: every recipient's notification asking for it is
 * resolved and read, whoever decided (INV-1093). Matched by the work it is
 * about, or, for decisions that are not a work item's (a request, a
 * webhook), by an id in the payload. Rows already resolved keep their first
 * resolution. Returns how many rows were resolved.
 */
export async function resolveAttentionNotifications(
  prisma: DatabaseClient,
  input: {
    kind: AttentionKind;
    resolution: string;
    resolvedById: string | null | undefined;
    workId?: string | null;
    payload?: { key: string; value: string };
    /** Narrow to some of the kind's types, e.g. only the request a reply answers. */
    types?: string[];
  },
): Promise<number> {
  const types = input.types ?? typesOfKind(input.kind);
  if (!input.workId && !input.payload) return 0;
  const where: Prisma.NotificationWhereInput = {
    resolvedAt: null,
    type: { in: types },
    ...(input.workId ? { workId: input.workId } : {}),
    ...(input.payload ? { payload: { equals: input.payload.value, path: [input.payload.key] } } : {}),
  };
  const now = new Date();
  // Read first, only where unread, so a time a person already read it is kept.
  await prisma.notification.updateMany({ data: { readAt: now }, where: { ...where, readAt: null } });
  const resolved = await prisma.notification.updateMany({
    data: { resolution: input.resolution, resolvedAt: now, resolvedById: input.resolvedById ?? null },
    where,
  });
  return resolved.count;
}

/**
 * New candidates, told to the people who decide them at most once an hour per
 * team (INV-1093): one open row per person collects every proposal until it
 * is read or an hour passes, so an agent proposing twenty items is one line.
 * Decided candidates leave its list; when none is left it is resolved.
 */
export async function projectProposedBatch(
  prisma: DatabaseClient,
  input: { eventId: string; proposerId: string | null | undefined; work: Pick<Issue, 'assigneeId' | 'id' | 'identifier' | 'teamId' | 'title'> },
): Promise<void> {
  // A person proposing work is not told about it.
  const recipients = (await resolveHumanRecipients(prisma, input.work)).filter((id) => id !== input.proposerId);
  const since = new Date(Date.now() - PROPOSED_BATCH_WINDOW_MS);
  const entry = { id: input.work.id, identifier: input.work.identifier, title: input.work.title };
  for (const userId of recipients) {
    const open = await prisma.notification.findFirst({
      where: { createdAt: { gte: since }, readAt: null, teamId: input.work.teamId, type: 'work.proposed_batch', userId },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      const items = batchItems(open.payload);
      if (!items.some((item) => item.id === entry.id) && items.length < PROPOSED_BATCH_LIMIT) items.push(entry);
      await prisma.notification.update({ where: { id: open.id }, data: { payload: { count: items.length, items } } });
    } else {
      await prisma.notification.createMany({
        data: [{ payload: { count: 1, items: [entry] }, sourceEventId: input.eventId, teamId: input.work.teamId, type: 'work.proposed_batch', userId }],
        skipDuplicates: true,
      });
    }
  }
}

/** A candidate was committed or declined: batches listing only decided candidates are resolved. */
export async function settleProposedBatches(
  prisma: DatabaseClient,
  input: { resolvedById: string | null | undefined; work: Pick<Issue, 'id' | 'teamId'> },
): Promise<void> {
  const open = await prisma.notification.findMany({
    where: { resolvedAt: null, teamId: input.work.teamId, type: 'work.proposed_batch' },
    select: { id: true, payload: true },
  });
  const containing = open.filter((row) => batchItems(row.payload).some((item) => item.id === input.work.id));
  for (const row of containing) {
    const ids = batchItems(row.payload).map((item) => item.id);
    const waiting = await prisma.issue.count({ where: { commitmentStatus: 'CANDIDATE', id: { in: ids } } });
    if (waiting > 0) continue;
    const now = new Date();
    await prisma.notification.updateMany({ data: { readAt: now }, where: { id: row.id, readAt: null } });
    await prisma.notification.updateMany({
      data: { resolution: 'decided', resolvedAt: now, resolvedById: input.resolvedById ?? null },
      where: { id: row.id, resolvedAt: null },
    });
  }
}

const PROPOSED_BATCH_WINDOW_MS = 60 * 60_000;
const PROPOSED_BATCH_LIMIT = 50;

function batchItems(payload: Prisma.JsonValue): Array<{ id: string; identifier: string; title: string }> {
  const items = (payload as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Array<{ id: string; identifier: string; title: string }>) : [];
}
