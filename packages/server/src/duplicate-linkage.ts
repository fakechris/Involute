import type { Prisma, PrismaClient, WorkLink } from '@prisma/client';

import { notifyDuplicateMarked, postDuplicateNote } from './duplicate-notes.js';
import { createNotFoundError, WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE } from './errors.js';
import { createWorkLinkDetailed, type CreateWorkLinkInput } from './link-service.js';
import { closeWorkAsDuplicate } from './work-close.js';
import { INTERNAL_WRITE_ACTOR, type WriteActor } from './work-service.js';

/**
 * What marking A DUPLICATE_OF B did (INV-1124), returned to the caller so an
 * agent learns whether A was closed or waits for a person.
 */
export interface DuplicateLinkOutcome {
  closed: boolean;
  note: string;
}

/**
 * Who may close the duplicate: only a person. Rejecting a candidate is a human
 * gate and agents never set CANCELED (AGENTS.md §4.6), so a link made by an
 * agent (or a service) records the relation, leaves both notes and tells the
 * people who decide the duplicate to decline it — it does not close anything.
 * Linking already required write access to both items.
 */
export function mayCloseDuplicate(actor: WriteActor): boolean {
  return actor.actorKind === 'HUMAN';
}

/**
 * Side effects of a new DUPLICATE_OF edge from `duplicateId` to `originalId`,
 * in the caller's transaction: close the duplicate when the actor may (resolution
 * DUPLICATE; the bug SLA stops with it), a note on both items, and the
 * duplicate's reporter (plus, while it stays open, its deciders) notified.
 * Later state changes of the original reach that reporter through the audit
 * writer (`notifyDuplicateReporters`).
 */
export async function applyDuplicateOf(
  tx: Prisma.TransactionClient,
  input: { duplicateId: string; originalId: string; actor: WriteActor },
): Promise<DuplicateLinkOutcome> {
  const [duplicate, original] = await Promise.all([
    tx.issue.findUnique({ where: { id: input.duplicateId }, include: { state: { select: { type: true } } } }),
    tx.issue.findUnique({ where: { id: input.originalId }, select: { id: true, identifier: true } }),
  ]);
  if (!duplicate || !original) throw createNotFoundError(WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE);
  const wasCandidate = duplicate.commitmentStatus === 'CANDIDATE';
  const alreadyClosed = duplicate.commitmentStatus === 'REJECTED' || duplicate.state.type === 'COMPLETED' || duplicate.state.type === 'CANCELED';

  let closed = false;
  if (!alreadyClosed && mayCloseDuplicate(input.actor)) {
    closed = (await closeWorkAsDuplicate(tx, { workId: duplicate.id, duplicateOfId: original.id, actor: input.actor })).closed;
  }
  const stillOpen = !alreadyClosed && !closed;

  const follow = `Follow ${original.identifier} for progress; whoever reported this is notified when it changes state.`;
  const note = closed
    ? `Closed as a duplicate of ${original.identifier} (resolution: duplicate). ${follow}`
    : stillOpen
      ? `Marked as a duplicate of ${original.identifier}. It stays open until a person declines it as a duplicate: an agent's link does not close work.`
      : `Marked as a duplicate of ${original.identifier}; it was already closed and stays as it is. ${follow}`;
  await postDuplicateNote(tx, { workId: duplicate.id, authorId: input.actor.actorId, body: note });
  await postDuplicateNote(tx, {
    workId: original.id,
    authorId: input.actor.actorId,
    body: `${duplicate.identifier} was marked as a duplicate of this item${closed ? ' and closed' : ''}.`,
  });
  await notifyDuplicateMarked(tx, {
    duplicate,
    original,
    closed,
    stillOpen,
    // A rejected candidate's proposer already hears it through work.rejected.
    includeReporter: !(closed && wasCandidate),
    actorId: input.actor.actorId,
  });
  return { closed, note };
}

/**
 * Create a link from a person's or agent's request (GraphQL workLink, MCP
 * work_link), applying the DUPLICATE_OF effects when the edge is new.
 */
export async function linkWork(
  prisma: PrismaClient,
  input: CreateWorkLinkInput,
): Promise<{ duplicate: DuplicateLinkOutcome | null; link: WorkLink }> {
  return prisma.$transaction(async (tx) => {
    const { created, link } = await createWorkLinkDetailed(tx, input);
    const duplicate = created && input.type === 'DUPLICATE_OF'
      ? await applyDuplicateOf(tx, { duplicateId: input.fromId, originalId: input.toId, actor: input.actor ?? INTERNAL_WRITE_ACTOR })
      : null;
    return { duplicate, link };
  });
}
