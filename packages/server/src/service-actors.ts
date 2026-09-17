import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Registered identities for the system's own writers (INV-573).
 *
 * The hotfix reflex, the webhook ingestor and the sync engine are not agents,
 * but they are actors. Writing as `SERVICE` with a null actorId made their work
 * read as "nobody did this", which is why INV-583 names no one.
 *
 * These are `SERVICE`, not `AGENT`, and since INV-573 `assertActorCan` denies
 * SERVICE the human gates — so naming them grants nothing it did not already
 * have. They are deliberately credential-less: they run in-process and must not
 * be able to authenticate from outside.
 */
export interface ServiceActorSpec {
  description: string;
  email: string;
  handle: string;
  name: string;
  /** Recorded as the audit surface, so the write says where it came from. */
  surface: string;
}

export const HOTFIX_REFLEX_ACTOR: ServiceActorSpec = {
  description:
    'Files the work item for an unplanned fix made while delivering something else (AGENTS.md §7).',
  email: 'hotfix-reflex@services.involute.local',
  handle: 'hotfix-reflex',
  name: 'Hotfix Reflex',
  surface: 'hotfix-reflex',
};

export const SERVICE_ACTORS: readonly ServiceActorSpec[] = [HOTFIX_REFLEX_ACTOR];

/**
 * Find-or-create the actor row for one of the system's writers.
 *
 * Idempotent on `email`, so a service can call it on every run without
 * accumulating rows or racing itself.
 */
export async function ensureServiceActor(
  db: DatabaseClient,
  spec: ServiceActorSpec,
): Promise<{ actorId: string; actorKind: 'SERVICE'; surface: string }> {
  const actor = await db.user.upsert({
    where: { email: spec.email },
    create: {
      actorKind: 'SERVICE',
      description: spec.description,
      email: spec.email,
      handle: spec.handle,
      name: spec.name,
    },
    // Keep the descriptive fields current without ever reassigning identity.
    update: { description: spec.description, name: spec.name },
    select: { id: true },
  });

  return { actorId: actor.id, actorKind: 'SERVICE', surface: spec.surface };
}
