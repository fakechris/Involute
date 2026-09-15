import { CLAIMABLE_REQUEST_STATES } from './agent-request-state.js';
import { enqueueWorkEvent } from './event-outbox.js';

import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Bounded so one sweep cannot monopolise the database. */
export const EXPIRY_BATCH_SIZE = 50;

export const SYSTEM_ACTOR_EMAIL = 'system@involute.local';
export const SYSTEM_ACTOR_NAME = 'Involute';

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
  const existing = await db.user.findUnique({
    where: { email: SYSTEM_ACTOR_EMAIL },
    select: { id: true },
  });

  if (existing) {
    return existing;
  }

  return db.user.create({
    data: { actorKind: 'SERVICE', email: SYSTEM_ACTOR_EMAIL, name: SYSTEM_ACTOR_NAME },
    select: { id: true },
  });
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
            successorActor: { select: { handle: true, id: true, name: true } },
          },
        },
        work: { select: { id: true, identifier: true, teamId: true } },
      },
    });

    const teamContacts = request.targetActor.successorActor
      ? []
      : await listTeamContacts(tx, request.work.teamId);

    const notice = buildExpiryNotice({
      askedHandle: request.targetActor.handle,
      askedName: request.targetActor.name,
      successorHandle: request.targetActor.successorActor?.handle ?? null,
      successorName: request.targetActor.successorActor?.name ?? null,
      teamContacts,
    });

    const systemActor = await ensureSystemActor(tx);

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
        successorActorId: request.targetActor.successorActor?.id ?? null,
        targetActorId: request.targetActor.id,
      },
      type: 'agent.request_expired',
      workId: request.work.id,
      workIdentifier: request.work.identifier,
    });

    // The asker is the one left waiting, so the asker is who gets told —
    // not the team's owners by default.
    const asker = await tx.user.findUnique({
      where: { id: request.requestedByActorId },
      select: { actorKind: true, id: true },
    });

    if (asker?.actorKind === 'HUMAN') {
      await tx.notification.createMany({
        data: [{
          payload: {
            advice: notice.fallbackAdvice,
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
        }],
        skipDuplicates: true,
      });
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
