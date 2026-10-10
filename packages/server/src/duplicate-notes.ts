import type { Prisma, PrismaClient } from '@prisma/client';

import { enqueueCommentEvents } from './comment-events.js';
import { resolveHumanRecipients, resolveProposerId } from './notification-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Comments and notifications for DUPLICATE_OF (INV-1124). Kept apart from the
 * linking code so the audit writer can call `notifyDuplicateReporters` without
 * importing the link service.
 */

/** A note on a work item, written as the actor who made the change. Nobody to write as, no note. */
export async function postDuplicateNote(
  db: DatabaseClient,
  input: { workId: string; authorId: string | null | undefined; body: string },
): Promise<void> {
  if (!input.authorId) return;
  const work = await db.issue.findUnique({ where: { id: input.workId }, select: { id: true, identifier: true } });
  if (!work) return;
  const comment = await db.comment.create({ data: { body: input.body, issueId: work.id, userId: input.authorId } });
  await enqueueCommentEvents(db, { comment, mentions: [], work });
}

async function activeRecipients(db: DatabaseClient, ids: Iterable<string | null | undefined>, exclude: string | null | undefined): Promise<string[]> {
  const wanted = new Set([...ids].filter((id): id is string => typeof id === 'string' && id.length > 0));
  if (exclude) wanted.delete(exclude);
  if (wanted.size === 0) return [];
  const users = await db.user.findMany({ where: { deactivatedAt: null, id: { in: [...wanted] } }, select: { id: true } });
  return users.map((user) => user.id);
}

/**
 * Tells the people a duplicate concerns that it was marked: its reporter (they
 * will hear about the original from now on) and, while it is still open, the
 * people who decide it — an agent's link leaves the closing to them.
 */
export async function notifyDuplicateMarked(
  db: DatabaseClient,
  input: {
    duplicate: { id: string; identifier: string; teamId: string; assigneeId: string | null };
    original: { id: string; identifier: string };
    closed: boolean;
    stillOpen: boolean;
    includeReporter: boolean;
    actorId: string | null | undefined;
  },
): Promise<void> {
  const reporter = input.includeReporter ? await resolveProposerId(db, input.duplicate.id) : null;
  const deciders = input.stillOpen ? await resolveHumanRecipients(db, input.duplicate) : [];
  const recipients = await activeRecipients(db, [reporter, ...deciders], input.actorId);
  if (recipients.length === 0) return;
  const { duplicate, original } = input;
  const summary = input.closed
    ? `${duplicate.identifier} was closed as a duplicate of ${original.identifier}; you will hear when ${original.identifier} changes state.`
    : input.stillOpen
      ? `${duplicate.identifier} was marked as a duplicate of ${original.identifier}. It stays open until a person declines it as a duplicate.`
      : `${duplicate.identifier} was marked as a duplicate of ${original.identifier}; you will hear when ${original.identifier} changes state.`;
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      payload: {
        summary,
        closed: input.closed,
        duplicateId: duplicate.id,
        duplicateIdentifier: duplicate.identifier,
        originalId: original.id,
        originalIdentifier: original.identifier,
      },
      teamId: duplicate.teamId,
      type: 'duplicate.marked',
      userId,
      workId: duplicate.id,
    })),
  });
}

/**
 * The original moved to another state: whoever reported a duplicate of it
 * hears, in place of a watcher list (Bugzilla adds the reporter to the
 * original's CC). Called by the audit writer for every state change, so every
 * surface that moves work is covered; `auditId` makes a replay a no-op.
 */
export async function notifyDuplicateReporters(
  db: DatabaseClient,
  input: { workId: string; auditId: string; toStateId: string; actorId: string | null | undefined },
): Promise<void> {
  const links = await db.workLink.findMany({
    where: { toId: input.workId, type: 'DUPLICATE_OF' },
    select: { from: { select: { id: true, identifier: true } } },
  });
  if (links.length === 0) return;
  const [original, state] = await Promise.all([
    db.issue.findUnique({ where: { id: input.workId }, select: { id: true, identifier: true, teamId: true } }),
    db.workflowState.findUnique({ where: { id: input.toStateId }, select: { name: true, type: true } }),
  ]);
  if (!original || !state) return;
  const byReporter = new Map<string, string[]>();
  for (const { from } of links) {
    const reporter = await resolveProposerId(db, from.id);
    if (!reporter) continue;
    byReporter.set(reporter, [...(byReporter.get(reporter) ?? []), from.identifier]);
  }
  const recipients = await activeRecipients(db, byReporter.keys(), input.actorId);
  if (recipients.length === 0) return;
  await db.notification.createMany({
    data: recipients.map((userId) => {
      const duplicates = byReporter.get(userId) ?? [];
      return {
        payload: {
          summary: `${original.identifier}, which your ${duplicates.join(', ')} duplicates, moved to ${state.name}.`,
          duplicates,
          originalIdentifier: original.identifier,
          stateName: state.name,
          stateType: state.type,
        },
        sourceEventId: input.auditId,
        teamId: original.teamId,
        type: 'duplicate.original_changed',
        userId,
        workId: original.id,
      };
    }),
    skipDuplicates: true,
  });
}
