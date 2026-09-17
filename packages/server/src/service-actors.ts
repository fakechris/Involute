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

// Moves work items in response to GitHub events: branch created, PR opened,
// PR merged. Until INV-587 these writes recorded no audit at all.
export const GITHUB_WEBHOOK_ACTOR: ServiceActorSpec = {
  description: 'Applies GitHub PR and branch events to work-item state (AGENTS.md §8.3).',
  email: 'github-webhook@services.involute.local',
  handle: 'github-webhook',
  name: 'GitHub Webhook',
  surface: 'github-webhook',
};

// Fails overdue requests and posts the notice (INV-562). It writes, so it has
// an identity like any other writer.
export const EXPIRY_SWEEPER_ACTOR: ServiceActorSpec = {
  description: 'Fails agent requests whose deadline passed and posts the notice on the thread.',
  email: 'expiry-sweeper@services.involute.local',
  handle: 'expiry-sweeper',
  name: 'Expiry Sweeper',
  surface: 'agent_request.expired',
};

export const SERVICE_ACTORS: readonly ServiceActorSpec[] = [
  HOTFIX_REFLEX_ACTOR,
  GITHUB_WEBHOOK_ACTOR,
  EXPIRY_SWEEPER_ACTOR,
];

/**
 * Find-or-create the actor row for one of the system's writers.
 *
 * Idempotent on `email`, so a service can call it on every run without
 * accumulating rows or racing itself.
 */
export async function ensureServiceActor(
  db: DatabaseClient,
  spec: ServiceActorSpec,
  options: { ownerId?: string | null } = {},
): Promise<{ actorId: string; actorKind: 'SERVICE'; surface: string }> {
  const actor = await db.user.upsert({
    where: { email: spec.email },
    create: {
      actorKind: 'SERVICE',
      description: spec.description,
      email: spec.email,
      handle: spec.handle,
      name: spec.name,
      ownerId: options.ownerId ?? null,
    },
    // Keep the descriptive fields current without ever reassigning identity
    // or silently changing who is accountable.
    update: { description: spec.description, name: spec.name },
    select: { deactivatedAt: true, id: true },
  });

  if (actor.deactivatedAt) {
    throw new Error(`Service actor @${spec.handle} is deactivated and cannot act.`);
  }

  return { actorId: actor.id, actorKind: 'SERVICE', surface: spec.surface };
}

/**
 * Provision a SERVICE actor from the operator CLI (INV-586). Unlike the
 * built-in specs above, an operator-provisioned service is an arbitrary
 * external program — CI, cron, a bridge — and must name its owner up front.
 * It receives a credential like an agent does, because it authenticates from
 * outside the process; it is still SERVICE, so it cannot pass the human gates
 * and cannot be asked anything.
 */
export async function provisionServiceActor(
  db: DatabaseClient,
  input: { description?: string | null; email?: string | null; handle: string; name: string; ownerId: string },
): Promise<{ actorId: string; handle: string }> {
  const owner = await db.user.findUnique({
    where: { id: input.ownerId },
    select: { actorKind: true, deactivatedAt: true },
  });
  if (!owner || owner.actorKind !== 'HUMAN' || owner.deactivatedAt) {
    throw new Error('Owner must be an active HUMAN actor.');
  }

  const handle = input.handle.trim().toLowerCase();
  const email = input.email?.trim().toLowerCase() || `${handle}@services.involute.local`;

  const actor = await db.user.upsert({
    where: { email },
    create: {
      actorKind: 'SERVICE',
      description: input.description ?? null,
      email,
      handle,
      name: input.name.trim(),
      ownerId: input.ownerId,
    },
    update: { ...(input.description ? { description: input.description } : {}), name: input.name.trim() },
    select: { id: true },
  });

  return { actorId: actor.id, handle };
}
