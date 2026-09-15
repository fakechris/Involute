import { extractMentionHandles } from './mention-parser.js';

import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface ResolvedMention {
  actorId: string;
  handle: string;
}

/**
 * Resolves the `@handle`s in a comment body to AGENT actors.
 *
 * Only AGENT actors resolve: a mention is the addressing half of an agent
 * request (docs/54 §B1), and human notification routing is a separate surface.
 * Unknown handles resolve to nothing and are not an error — a typo must not
 * fail the comment write.
 */
export async function resolveMentionedActors(
  db: DatabaseClient,
  body: string,
): Promise<ResolvedMention[]> {
  const handles = extractMentionHandles(body);

  if (handles.length === 0) {
    return [];
  }

  const actors = await db.user.findMany({
    where: { actorKind: 'AGENT', handle: { in: handles } },
    select: { handle: true, id: true },
  });

  const byHandle = new Map(
    actors.flatMap((actor) => (actor.handle ? [[actor.handle, actor.id] as const] : [])),
  );

  return handles.flatMap((handle) => {
    const actorId = byHandle.get(handle);
    return actorId ? [{ actorId, handle }] : [];
  });
}

/**
 * Makes the stored mentions of `commentId` match `body` exactly, by difference:
 * new `@`s are added, withdrawn ones are deleted, unchanged ones keep their
 * original `createdAt`. Called on create today; edits reuse it unchanged once
 * a comment-edit path exists (handoff B1).
 *
 * Must run inside the same transaction as the comment write, so a reader never
 * sees a comment whose mentions have not been resolved yet.
 */
export async function syncCommentMentions(
  db: DatabaseClient,
  commentId: string,
  body: string,
): Promise<ResolvedMention[]> {
  const resolved = await resolveMentionedActors(db, body);
  const desired = new Set(resolved.map((mention) => mention.actorId));

  const existing = await db.commentMention.findMany({
    where: { commentId },
    select: { actorId: true },
  });
  const current = new Set(existing.map((mention) => mention.actorId));

  const removed = [...current].filter((actorId) => !desired.has(actorId));
  if (removed.length > 0) {
    await db.commentMention.deleteMany({
      where: { actorId: { in: removed }, commentId },
    });
  }

  const added = resolved.filter((mention) => !current.has(mention.actorId));
  if (added.length > 0) {
    await db.commentMention.createMany({
      data: added.map((mention) => ({ actorId: mention.actorId, commentId })),
      skipDuplicates: true,
    });
  }

  return resolved;
}
