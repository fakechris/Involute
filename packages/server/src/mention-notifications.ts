import { enqueueWorkEvent } from './event-outbox.js';
import { resolveMentionedHumans } from './mention-service.js';

import type { Comment, Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * A person @mentioned in a comment is told (INV-1119): one inbox row each,
 * never the author. Information only — a question that must be answered is a
 * needinfo, which waits in Needs you until it is.
 */
export async function notifyMentionedHumans(
  db: DatabaseClient,
  input: { comment: Comment; work: { id: string; identifier: string; teamId: string } },
): Promise<string[]> {
  const people = (await resolveMentionedHumans(db, input.comment.body)).filter((mention) => mention.actorId !== input.comment.userId);
  if (people.length === 0) return [];
  const work = await db.issue.findUniqueOrThrow({ where: { id: input.work.id }, select: { title: true } });
  const payload = {
    authorId: input.comment.userId,
    commentId: input.comment.id,
    excerpt: input.comment.body.slice(0, 280),
    identifier: input.work.identifier,
    mentionedActorIds: people.map((mention) => mention.actorId),
    rootCommentId: input.comment.parentCommentId ?? input.comment.id,
    title: work.title,
  };
  const event = await enqueueWorkEvent(db, { payload, type: 'comment.mentioned', workId: input.work.id, workIdentifier: input.work.identifier });
  await db.notification.createMany({
    data: people.map((mention) => ({
      payload,
      sourceEventId: event.id,
      teamId: input.work.teamId,
      type: 'comment.mentioned',
      userId: mention.actorId,
      workId: input.work.id,
    })),
    skipDuplicates: true,
  });
  return people.map((mention) => mention.actorId);
}
