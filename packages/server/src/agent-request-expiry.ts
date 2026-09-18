import { describePick, handOffRequest } from './agent-request-handoff.js';
import { recordRequestAudit } from './agent-request-service.js';
import { CLAIMABLE_REQUEST_STATES } from './agent-request-state.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { EXPIRY_SWEEPER_ACTOR, ensureServiceActor } from './service-actors.js';

import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Bounded so one sweep cannot monopolise the database. */
export const EXPIRY_BATCH_SIZE = 50;

// The sweep and the notice it posts are one act by one actor. Before INV-587
// the notice was authored by a separate "system" user while the sweep itself
// recorded nothing.
export const SYSTEM_ACTOR_EMAIL = EXPIRY_SWEEPER_ACTOR.email;
export const SYSTEM_ACTOR_NAME = EXPIRY_SWEEPER_ACTOR.name;

/**
 * Expiry copy.
 *
 * It states one observed fact — no answer arrived before the deadline — and
 * then says who to ask. It must never say, or let a reader infer, *why*: the
 * server knows the deadline passed and nothing else. "It isn't running" is a
 * guess, and docs/54 §D3 forbids it because a person acting on that guess
 * chases the wrong problem.
 */
export const DEADLINE_FAILURE_REASON = 'No answer within the deadline.';

export interface ExpiryNotice {
  body: string;
  fallbackAdvice: string;
}

/** The notice when the request was handed on (INV-589). */
export function buildHandoffNotice(input: {
  askedHandle: string | null;
  askedName: string;
  handedTo: string;
  skipped: Array<{ reason: string }>;
}): ExpiryNotice {
  const asked = input.askedHandle ? `@${input.askedHandle}` : input.askedName;
  const skippedNote = input.skipped.length > 0
    ? `\n\nSkipped on the way: ${input.skipped.map((s) => s.reason).join('; ')}.`
    : '';
  const advice = `Handed to ${input.handedTo}, who will answer in their own name from the record — not as ${asked}.`;
  return {
    body: `**${asked} has not replied within the deadline.**\n\n`
      + 'This says only that no answer arrived in time — not that the agent is unavailable.\n\n'
      + advice + skippedNote,
    fallbackAdvice: advice,
  };
}

export function buildExpiryNotice(input: {
  askedHandle: string | null;
  askedName: string;
  successorHandle: string | null;
  successorName: string | null;
  teamContacts: string[];
}): ExpiryNotice {
  const asked = input.askedHandle ? `@${input.askedHandle}` : input.askedName;

  const advice = input.successorName
    ? `Its declared successor is ${input.successorHandle ? `@${input.successorHandle}` : input.successorName}${
      input.successorHandle ? '' : ''
    } — ask there, or re-ask ${asked}.`
    : input.teamContacts.length > 0
      ? `No successor is declared for ${asked}. Ask ${input.teamContacts.join(' or ')}, or re-ask ${asked}.`
      : `No successor is declared for ${asked}, and no human contact is recorded for its team. Re-ask ${asked}, or declare a successor.`;

  return {
    body: `**${asked} has not replied within the deadline.**\n\n`
      + 'This says only that no answer arrived in time — not that the agent is unavailable.\n\n'
      + advice,
    fallbackAdvice: advice,
  };
}

/**
 * Find-or-create the actor that speaks for the system itself. Expiry notices
 * are posted by Involute, not attributed to a person or to the agent that did
 * not answer — impersonating either would be a lie in the audit trail.
 */
export async function ensureSystemActor(db: DatabaseClient): Promise<{ id: string }> {
  const sweeper = await ensureServiceActor(db, EXPIRY_SWEEPER_ACTOR);
  return { id: sweeper.actorId };
}

/**
 * Fails every overdue request and **says so where the question was asked**.
 *
 * A bulk `updateMany` would be one statement, but it is also silent: the person
 * who asked sees their question sit there forever. So each request is settled
 * individually, in its own transaction, and the settlement writes a comment on
 * the thread, an inbox notification for the asker, and an outbox event for
 * consumers.
 *
 * The state move is a CAS, which is what makes this idempotent: two servers
 * sweeping at once produce one notice, not two.
 */
export async function expireOverdueAgentRequests(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const overdue = await prisma.agentRequest.findMany({
    where: {
      deadlineAt: { lte: now },
      state: { in: [...CLAIMABLE_REQUEST_STATES] },
    },
    select: { id: true },
    orderBy: { deadlineAt: 'asc' },
    take: EXPIRY_BATCH_SIZE,
  });

  let expired = 0;

  for (const candidate of overdue) {
    if (await expireOneRequest(prisma, candidate.id, now)) {
      expired += 1;
    }
  }

  return expired;
}

async function expireOneRequest(
  prisma: PrismaClient,
  requestId: string,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // CAS first: whoever wins this is the one that posts the notice.
    const moved = await tx.agentRequest.updateMany({
      where: {
        id: requestId,
        deadlineAt: { lte: now },
        state: { in: [...CLAIMABLE_REQUEST_STATES] },
      },
      data: { failureReason: DEADLINE_FAILURE_REASON, state: 'FAILED' },
    });

    if (moved.count === 0) {
      return false;
    }

    const request = await tx.agentRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: {
        targetActor: {
          select: {
            handle: true,
            id: true,
            name: true,
            ownerId: true,
            successorActorId: true,
            successorActor: { select: { handle: true, id: true, name: true } },
          },
        },
        work: { select: { id: true, identifier: true, teamId: true } },
      },
    });

    // Hand off, not just fail (INV-589). Same transaction as the CAS above,
    // so a second sweep — which never sees the request as claimable — cannot
    // hand it off twice.
    const handoff = await handOffRequest(tx, {
      request,
      target: {
        id: request.targetActor.id,
        ownerId: request.targetActor.ownerId,
        successorActorId: request.targetActor.successorActorId,
      },
    }, now);

    const notice = handoff.pick
      ? buildHandoffNotice({
          askedHandle: request.targetActor.handle,
          askedName: request.targetActor.name,
          handedTo: describePick(handoff.pick),
          skipped: handoff.skipped,
        })
      : buildExpiryNotice({
          askedHandle: request.targetActor.handle,
          askedName: request.targetActor.name,
          successorHandle: null,
          successorName: null,
          teamContacts: await listTeamContacts(tx, request.work.teamId),
        });

    const systemActor = await ensureSystemActor(tx);

    await recordRequestAudit(tx, {
      actor: { actorId: systemActor.id, actorKind: 'SERVICE' },
      claimGeneration: request.claimGeneration,
      event: 'expired',
      request,
    });
    if (handoff.next) {
      await recordRequestAudit(tx, {
        actor: { actorId: systemActor.id, actorKind: 'SERVICE' },
        event: 'handed-off',
        request: handoff.next,
      });
    }

    // Posted into the thread the question was asked in, so the person who
    // asked sees the answer to "did anything happen" in the place they asked.
    await tx.comment.create({
      data: {
        body: notice.body,
        issueId: request.work.id,
        parentCommentId: request.rootCommentId,
        userId: systemActor.id,
      },
    });

    const event = await enqueueWorkEvent(tx, {
      payload: {
        deadlineAt: request.deadlineAt.toISOString(),
        reason: DEADLINE_FAILURE_REASON,
        requestId: request.id,
        rootCommentId: request.rootCommentId,
        handedOffToRequestId: handoff.next?.id ?? null,
        successorActorId: handoff.pick?.actor.id ?? null,
        targetActorId: request.targetActor.id,
      },
      type: 'agent.request_expired',
      workId: request.work.id,
      workIdentifier: request.work.identifier,
    });

    // Two people may need to hear about this, for two different reasons.
    // The person the request was handed to now has something to do: they
    // get the hand-off itself, addressed to them. The asker is left waiting
    // and gets the status update — which never substitutes for the first.
    const asker = await tx.user.findUnique({
      where: { id: request.requestedByActorId },
      select: { actorKind: true, id: true },
    });
    const notifications: Prisma.NotificationCreateManyInput[] = [];

    if (handoff.next && handoff.pick?.actor.actorKind === 'HUMAN') {
      notifications.push({
        payload: {
          body: request.body,
          fromRequestId: request.id,
          hopCount: handoff.next.hopCount,
          previousTargetActorId: request.targetActor.id,
          requestId: handoff.next.id,
          rootCommentId: request.rootCommentId,
          workIdentifier: request.work.identifier,
        },
        sourceEventId: event.id,
        teamId: request.work.teamId,
        type: 'agent.request_handed_off',
        userId: handoff.pick.actor.id,
        workId: request.work.id,
      });
    }

    if (asker?.actorKind === 'HUMAN' && asker.id !== handoff.pick?.actor.id) {
      notifications.push({
        payload: {
          advice: notice.fallbackAdvice,
          handedOffToRequestId: handoff.next?.id ?? null,
          reason: DEADLINE_FAILURE_REASON,
          requestId: request.id,
          rootCommentId: request.rootCommentId,
          workIdentifier: request.work.identifier,
        },
        sourceEventId: event.id,
        teamId: request.work.teamId,
        type: 'agent.request_expired',
        userId: asker.id,
        workId: request.work.id,
      });
    }

    if (notifications.length > 0) {
      await tx.notification.createMany({ data: notifications, skipDuplicates: true });
    }

    return true;
  });
}

const MAX_TEAM_CONTACTS = 3;

async function listTeamContacts(db: DatabaseClient, teamId: string): Promise<string[]> {
  const owners = await db.teamMembership.findMany({
    where: { role: 'OWNER', teamId, user: { actorKind: 'HUMAN' } },
    select: { user: { select: { name: true } } },
    take: MAX_TEAM_CONTACTS,
  });

  return owners.map((owner) => owner.user.name);
}
