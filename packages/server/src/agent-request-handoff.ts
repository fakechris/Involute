import { recordRequestAudit } from './agent-request-service.js';
import { enqueueWorkEvent } from './event-outbox.js';

import type { AgentRequest, Prisma, User } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Hops before the chain is forced to a human. Three is generous for a chain of agents. */
export const MAX_HANDOFF_HOPS = 3;
/** Total wall-clock a chain may run before it is forced to a human. */
export const CHAIN_TOTAL_MS = 72 * 60 * 60_000;
/** Deadline granted to each handed-off request. */
export const HANDOFF_DEADLINE_MS = 24 * 60 * 60_000;

/** Audit event name. The request's failureReason stays what was observed — the deadline. */
export const HANDED_OFF_EVENT = 'handed-off';

export type SuccessorSource = 'successor' | 'owner' | 'team-owner';

export interface SuccessorPick {
  actor: Pick<User, 'actorKind' | 'handle' | 'id' | 'name'>;
  source: SuccessorSource;
}

export interface HandoffResult {
  /** The new request, or null when nobody eligible was found (the old request stays failed). */
  next: AgentRequest | null;
  pick: SuccessorPick | null;
  /** Actors considered and skipped, with why — surfaced in the notice so silence never hides a dead end. */
  skipped: Array<{ actorId: string; reason: string }>;
}

async function canReadThread(tx: Tx, actorId: string, teamId: string): Promise<boolean> {
  // A human reads it by membership; an agent by a live credential bound to
  // the team (INV-592). Either counts; neither is granted by being named.
  const [membership, binding] = await Promise.all([
    tx.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId: actorId } }, select: { id: true } }),
    tx.agentCredential.findFirst({ where: { revokedAt: null, teamId, userId: actorId }, select: { id: true } }),
  ]);
  return membership !== null || binding !== null;
}

/**
 * Who should receive the handed-off request.
 *
 * Order: declared successor → the target's owner → the team's human owners.
 * At the hop or time limit the first two are skipped and it goes straight to
 * a human. Every candidate is checked for the things that would make the
 * hand-off pointless: deactivated, already in this chain, cannot read the
 * thread, or a SERVICE actor (nothing to ask). Naming a successor grants it
 * nothing — it must already be able to see what it is being asked about.
 */
export async function pickSuccessor(
  tx: Tx,
  input: {
    forceHuman: boolean;
    target: Pick<User, 'id' | 'ownerId' | 'successorActorId'>;
    teamId: string;
    visited: Set<string>;
  },
): Promise<{ pick: SuccessorPick | null; skipped: Array<{ actorId: string; reason: string }> }> {
  const skipped: Array<{ actorId: string; reason: string }> = [];

  const consider = async (actorId: string | null, source: SuccessorSource): Promise<SuccessorPick | null> => {
    if (!actorId) return null;
    if (input.visited.has(actorId)) {
      skipped.push({ actorId, reason: 'already in this chain' });
      return null;
    }
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      select: { actorKind: true, deactivatedAt: true, handle: true, id: true, name: true },
    });
    if (!actor) return null;
    if (actor.deactivatedAt) {
      skipped.push({ actorId, reason: 'deactivated' });
      return null;
    }
    if (actor.actorKind === 'SERVICE') {
      skipped.push({ actorId, reason: 'a service; nothing to ask' });
      return null;
    }
    if (input.forceHuman && actor.actorKind !== 'HUMAN') {
      skipped.push({ actorId, reason: 'chain limit reached; escalating to a human' });
      return null;
    }
    if (!(await canReadThread(tx, actor.id, input.teamId))) {
      skipped.push({ actorId, reason: 'cannot read this thread' });
      return null;
    }
    return { actor, source };
  };

  const successor = await consider(input.target.successorActorId, 'successor');
  if (successor) return { pick: successor, skipped };

  const owner = await consider(input.target.ownerId, 'owner');
  if (owner) return { pick: owner, skipped };

  const owners = await tx.teamMembership.findMany({
    where: { role: 'OWNER', teamId: input.teamId, user: { actorKind: 'HUMAN', deactivatedAt: null } },
    select: { userId: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  for (const membership of owners) {
    const teamOwner = await consider(membership.userId, 'team-owner');
    if (teamOwner) return { pick: teamOwner, skipped };
  }

  return { pick: null, skipped };
}

/**
 * Hand an overdue request off. Must be called inside the transaction that
 * just moved `request` to FAILED via CAS — that CAS is what makes this
 * idempotent: a second sweep never sees the request as claimable, so it never
 * reaches here twice.
 *
 * Terminate-old (done by the caller's CAS), open-new and link happen in the
 * same transaction. The new request starts `submitted`, unclaimed, with a
 * fresh deadline; the successor takes it exactly like any other request, so a
 * late answer from the previous holder loses — its request is terminal and its
 * claim generation belongs to a closed request.
 */
export async function handOffRequest(
  tx: Tx,
  input: {
    request: AgentRequest & { work: { id: string; identifier: string; teamId: string } };
    target: Pick<User, 'id' | 'ownerId' | 'successorActorId'>;
  },
  now: Date = new Date(),
): Promise<HandoffResult> {
  const { request } = input;
  const rootRequestId = request.rootRequestId ?? request.id;

  // The chain so far: every target that has already held a request in it.
  const chain = await tx.agentRequest.findMany({
    where: { OR: [{ id: rootRequestId }, { rootRequestId }] },
    select: { targetActorId: true },
  });
  const visited = new Set(chain.map((r) => r.targetActorId));
  visited.add(request.targetActorId);

  const chainDeadlineAt = request.chainDeadlineAt ?? new Date(request.createdAt.getTime() + CHAIN_TOTAL_MS);
  const nextHop = request.hopCount + 1;
  const forceHuman = nextHop >= MAX_HANDOFF_HOPS || now >= chainDeadlineAt;

  const { pick, skipped } = await pickSuccessor(tx, {
    forceHuman,
    target: input.target,
    teamId: request.work.teamId,
    visited,
  });

  // Link the old request into the chain. Its failureReason is left as the
  // observed fact (the deadline passed); that it was then handed off is
  // recorded by handedOffFromId on the new request, the audit, and the event.
  await tx.agentRequest.update({
    where: { id: request.id },
    data: { rootRequestId },
  });

  if (!pick) {
    // Nobody eligible. The old request stays failed and the notice says so —
    // an explicit dead end, never a silent one.
    return { next: null, pick: null, skipped };
  }

  const next = await tx.agentRequest.create({
    data: {
      body: request.body,
      chainDeadlineAt,
      deadlineAt: new Date(Math.min(now.getTime() + HANDOFF_DEADLINE_MS, chainDeadlineAt.getTime())),
      handedOffFromId: request.id,
      hopCount: nextHop,
      idempotencyKey: `handoff:${request.id}`,
      payingPrincipal: request.payingPrincipal,
      requestedByActorId: request.requestedByActorId,
      rootCommentId: request.rootCommentId,
      rootRequestId,
      state: 'SUBMITTED',
      targetActorId: pick.actor.id,
      workId: request.workId,
    },
  });

  await enqueueWorkEvent(tx, {
    payload: {
      fromRequestId: request.id,
      hopCount: nextHop,
      previousTargetActorId: request.targetActorId,
      rootCommentId: request.rootCommentId,
      rootRequestId,
      successorSource: pick.source,
      targetActorId: pick.actor.id,
      toRequestId: next.id,
    },
    type: 'agent.request_handed_off',
    workId: request.work.id,
    workIdentifier: request.work.identifier,
  });

  return { next, pick, skipped };
}

export function describePick(pick: SuccessorPick): string {
  const name = pick.actor.handle ? `@${pick.actor.handle}` : pick.actor.name;
  switch (pick.source) {
    case 'successor':
      return `${name} (its declared successor)`;
    case 'owner':
      return `${name} (its owner)`;
    case 'team-owner':
      return `${name} (a team owner)`;
  }
}
