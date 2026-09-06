import type { Issue, Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

// Recipient cap: an ownerless work must not fan out to an unbounded set of
// humans when notifications are projected inside a write transaction.
const MAX_RECIPIENTS = 10;

/**
 * Human-gate recipients for a work item: the human assignee when there is
 * one, otherwise every human OWNER of the team. Agents never receive
 * notifications — their feedback surface is webhooks.
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
