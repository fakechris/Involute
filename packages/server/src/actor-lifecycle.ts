import { assertHumanOwner } from './agent-credentials.js';
import { createNotFoundError, createValidationError } from './errors.js';

import type { Prisma, PrismaClient, User } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const ACTOR_NOT_FOUND_MESSAGE = 'Actor not found.';
export const ACTOR_ALREADY_DEACTIVATED_MESSAGE = 'Actor is already deactivated.';
export const ACTOR_NOT_DEACTIVATED_MESSAGE = 'Actor is not deactivated.';
export const ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE =
  'Only a human may deactivate or reactivate an actor, or transfer its ownership.';
export const ACTOR_DELETE_FORBIDDEN_MESSAGE =
  'Actors are never deleted: their id must stay valid for the audit trail. Deactivate instead.';

export interface LifecycleActor {
  actorId: string;
  actorKind: 'HUMAN' | 'AGENT' | 'SERVICE';
}

/**
 * Lifecycle of an actor (INV-586).
 *
 * Two rules, both there so that history keeps pointing at something real:
 *
 * 1. **Deactivate, never delete.** `WorkAudit.actor` and `ActorAudit.subject`
 *    are `Restrict`, so the database refuses to delete an actor with history.
 *    Deactivation keeps the id, the handle and every audit row; it only ends
 *    the actor's ability to act — credentials stop resolving, mentions stop
 *    resolving.
 * 2. **Every lifecycle change is itself recorded**, in `ActorAudit`, by the
 *    human who made it. Ownership is responsibility; changing who is
 *    responsible must be visible.
 */
export async function deactivateActor(
  prisma: PrismaClient,
  input: { actorId: string; by: LifecycleActor; reason?: string | null },
  now: Date = new Date(),
): Promise<User> {
  if (input.by.actorKind !== 'HUMAN') {
    throw createValidationError(ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const actor = await tx.user.findUnique({ where: { id: input.actorId } });
    if (!actor) {
      throw createNotFoundError(ACTOR_NOT_FOUND_MESSAGE);
    }
    if (actor.deactivatedAt) {
      throw createValidationError(ACTOR_ALREADY_DEACTIVATED_MESSAGE);
    }

    const updated = await tx.user.update({
      where: { id: actor.id },
      data: { deactivatedAt: now },
    });

    // Credentials are revoked rather than deleted, for the same reason the
    // actor is not deleted: the record of what could act as this actor stays.
    await tx.agentCredential.updateMany({
      where: { revokedAt: null, userId: actor.id },
      data: { revokedAt: now },
    });

    await recordActorAudit(tx, {
      action: 'deactivated',
      after: { deactivatedAt: now.toISOString() },
      before: { deactivatedAt: null },
      byActorId: input.by.actorId,
      reason: input.reason ?? null,
      subjectId: actor.id,
    });

    return updated;
  });
}

/**
 * Reactivation undoes the flag, not the revocations: the credentials that
 * were live before deactivation stay revoked, and the actor gets a fresh one
 * through the normal issuance path. Otherwise a token that someone believed
 * dead could quietly come back to life.
 */
export async function reactivateActor(
  prisma: PrismaClient,
  input: { actorId: string; by: LifecycleActor; reason?: string | null },
): Promise<User> {
  if (input.by.actorKind !== 'HUMAN') {
    throw createValidationError(ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const actor = await tx.user.findUnique({ where: { id: input.actorId } });
    if (!actor) {
      throw createNotFoundError(ACTOR_NOT_FOUND_MESSAGE);
    }
    if (!actor.deactivatedAt) {
      throw createValidationError(ACTOR_NOT_DEACTIVATED_MESSAGE);
    }

    const updated = await tx.user.update({
      where: { id: actor.id },
      data: { deactivatedAt: null },
    });

    await recordActorAudit(tx, {
      action: 'reactivated',
      after: { deactivatedAt: null },
      before: { deactivatedAt: actor.deactivatedAt.toISOString() },
      byActorId: input.by.actorId,
      reason: input.reason ?? null,
      subjectId: actor.id,
    });

    return updated;
  });
}

export async function transferActorOwner(
  prisma: PrismaClient,
  input: { actorId: string; by: LifecycleActor; newOwnerId: string; reason?: string | null },
): Promise<User> {
  if (input.by.actorKind !== 'HUMAN') {
    throw createValidationError(ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const actor = await tx.user.findUnique({ where: { id: input.actorId } });
    if (!actor) {
      throw createNotFoundError(ACTOR_NOT_FOUND_MESSAGE);
    }
    if (actor.actorKind === 'HUMAN') {
      throw createValidationError('Humans do not have owners.');
    }

    await assertHumanOwner(tx, input.newOwnerId);

    const updated = await tx.user.update({
      where: { id: actor.id },
      data: { ownerId: input.newOwnerId },
    });

    await recordActorAudit(tx, {
      action: 'owner-transferred',
      after: { ownerId: input.newOwnerId },
      before: { ownerId: actor.ownerId },
      byActorId: input.by.actorId,
      reason: input.reason ?? null,
      subjectId: actor.id,
    });

    return updated;
  });
}

export async function recordActorAudit(
  db: DatabaseClient,
  input: {
    action: string;
    after: Prisma.InputJsonValue;
    before?: Prisma.InputJsonValue | null;
    byActorId: string | null;
    reason?: string | null;
    subjectId: string;
  },
): Promise<void> {
  await db.actorAudit.create({
    data: {
      action: input.action,
      after: input.after,
      ...(input.before === undefined || input.before === null ? {} : { before: input.before }),
      byActorId: input.byActorId,
      reason: input.reason ?? null,
      subjectId: input.subjectId,
    },
  });
}
