import { enqueueWorkEvent } from './event-outbox.js';
import { buildMentionPromptContext } from './mention-prompt-context.js';

import type { Comment, Prisma, PrismaClient } from '@prisma/client';
import type { ResolvedMention } from './mention-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface EnqueueCommentEventsInput {
  comment: Comment;
  mentions: ResolvedMention[];
  /** Ledger rows opened for this comment, keyed by target actorId (INV-560). */
  requestIdByActorId?: Map<string, string>;
  work: { id: string; identifier: string };
}

/**
 * Root of the thread this comment belongs to. Replies are one level deep
 * (INV-561), so the root is the parent when there is one and the comment itself
 * otherwise — no tree walk.
 */
function rootCommentIdOf(comment: Comment): string {
  return comment.parentCommentId ?? comment.id;
}

/**
 * Emits the two INV-559 events for a freshly written comment. Runs inside the
 * comment's transaction and reuses the existing outbox wholesale — HMAC
 * signing, the 60s claim lease, the five-step backoff, dead-lettering and
 * auto-disable all apply unchanged.
 *
 * `agent.mentioned` is emitted once per mentioned actor rather than once per
 * comment: the addressee is what a consumer filters on, and B3's request
 * ledger is per-target too.
 */
export async function enqueueCommentEvents(
  db: DatabaseClient,
  input: EnqueueCommentEventsInput,
): Promise<void> {
  const { comment, mentions, work } = input;
  const rootCommentId = rootCommentIdOf(comment);

  const author = await db.user.findUnique({
    where: { id: comment.userId },
    select: { actorKind: true, handle: true, id: true, name: true },
  });

  const speaker = {
    actorId: comment.userId,
    actorKind: author?.actorKind ?? null,
    handle: author?.handle ?? null,
    name: author?.name ?? null,
  };

  await enqueueWorkEvent(db, {
    payload: {
      comment: {
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        id: comment.id,
        rootCommentId,
      },
      mentionedActorIds: mentions.map((mention) => mention.actorId),
      speaker,
    },
    type: 'comment.created',
    workId: work.id,
    workIdentifier: work.identifier,
  });

  if (mentions.length === 0) {
    return;
  }

  // Built once and shared: every addressee of one comment gets the same
  // briefing, and it is a point-in-time snapshot either way.
  const promptContext = await buildMentionPromptContext(db, work.id);

  for (const mention of mentions) {
    await enqueueWorkEvent(db, {
      payload: {
        comment: {
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
          id: comment.id,
          rootCommentId,
        },
        promptContext,
        // Present when the mention opened a ledger row: the consumer claims
        // this id rather than inventing its own notion of "mine" (INV-560).
        requestId: input.requestIdByActorId?.get(mention.actorId) ?? null,
        speaker,
        target: {
          actorId: mention.actorId,
          handle: mention.handle,
        },
      },
      type: 'agent.mentioned',
      workId: work.id,
      workIdentifier: work.identifier,
    });
  }
}
