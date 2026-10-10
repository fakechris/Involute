import { extractMentionHandles, isValidHandle, normalizeHandle } from './mention-parser.js';

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
    where: { actorKind: 'AGENT', deactivatedAt: null, handle: { in: handles } },
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

/** The handle a person is mentioned by: their own handle, else the local part of their email (INV-1119). */
export function humanMentionHandle(user: { email: string; handle: string | null }): string | null {
  if (user.handle) return user.handle;
  const local = normalizeHandle(user.email.split('@')[0] ?? '');
  return isValidHandle(local) ? local : null;
}

/**
 * Resolves the `@handle`s in a comment body to *people* (INV-1119), so a
 * mention of a person notifies them. Kept apart from resolveMentionedActors:
 * a mention of an agent opens a request (docs/54 §B1), a mention of a person
 * only tells them. A person is matched by their handle, or by the local part
 * of their email when exactly one active person has it and no agent holds
 * that handle — an ambiguous spelling resolves to nobody rather than to the
 * wrong person.
 */
export async function resolveMentionedHumans(db: DatabaseClient, body: string): Promise<ResolvedMention[]> {
  const handles = extractMentionHandles(body);
  if (handles.length === 0) return [];
  const [people, agents] = await Promise.all([
    db.user.findMany({
      where: {
        actorKind: 'HUMAN',
        deactivatedAt: null,
        OR: [{ handle: { in: handles } }, ...handles.map((handle) => ({ email: { startsWith: `${handle}@`, mode: 'insensitive' as const } }))],
      },
      select: { email: true, handle: true, id: true },
    }),
    db.user.findMany({ where: { actorKind: { not: 'HUMAN' }, handle: { in: handles } }, select: { handle: true } }),
  ]);
  const agentHandles = new Set(agents.map((agent) => agent.handle));
  return handles.flatMap((handle) => {
    if (agentHandles.has(handle)) return [];
    const byHandle = people.find((person) => person.handle === handle);
    if (byHandle) return [{ actorId: byHandle.id, handle }];
    const byEmail = people.filter((person) => !person.handle && humanMentionHandle(person) === handle);
    return byEmail.length === 1 ? [{ actorId: byEmail[0]!.id, handle }] : [];
  });
}
