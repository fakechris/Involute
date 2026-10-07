import type { Issue, Prisma, PrismaClient } from '@prisma/client';

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
