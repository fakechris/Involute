import { toWireState } from './agent-request-state.js';

import { Prisma } from '@prisma/client';
import type { PrismaClient, User } from '@prisma/client';

export const MAX_TIMELINE_ENTRIES = 25;

export interface AgentActivityCounts {
  answeredRequests: number;
  evidence: number;
  openRequests: number;
  proposedWork: number;
  runs: number;
}

export interface AgentTimelineEntry {
  at: Date;
  detail: string | null;
  kind: 'proposed' | 'claimed' | 'run' | 'evidence' | 'answered' | 'asked';
  workId: string | null;
  workIdentifier: string | null;
}

export interface AgentCredentialSummary {
  createdAt: Date;
  expiresAt: Date | null;
  id: string;
  name: string;
  revokedAt: Date | null;
  scopes: string[];
  teamKey: string | null;
}

export interface AgentProfile {
  actor: User;
  counts: AgentActivityCounts;
  /**
   * Where this actor came from. A credential is the only record of an agent
   * being brought into existence — when, under what name, with which rights —
   * so without it "what is this thing and who made it" is unanswerable.
   */
  credentials: AgentCredentialSummary[];
  timeline: AgentTimelineEntry[];
}

/**
 * Non-human actors, most recently active first — the directory behind `@`.
 * SERVICE actors are listed too (INV-586): they are actors with owners, and
 * the directory is where you find out what a thing is. Deactivated actors are
 * hidden unless asked for; they keep their page, they just stop being current.
 */
export async function listAgentActors(
  prisma: PrismaClient,
  input: { includeDeactivated?: boolean; kinds?: Array<'AGENT' | 'SERVICE'>; teamKey?: string | null } = {},
): Promise<User[]> {
  return prisma.user.findMany({
    where: {
      actorKind: { in: input.kinds ?? ['AGENT', 'SERVICE'] },
      ...(input.includeDeactivated ? {} : { deactivatedAt: null }),
      // Bound to the team by a live credential — or, for rows that predate
      // INV-592 and were never re-issued, still on the roster.
      ...(input.teamKey
        ? {
            OR: [
              { agentCredentials: { some: { revokedAt: null, team: { key: input.teamKey } } } },
              { memberships: { some: { team: { key: input.teamKey } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ lastSeenAt: 'desc' }, { name: 'asc' }],
  });
}

export async function findAgentActor(
  prisma: PrismaClient,
  handleOrId: string,
): Promise<User | null> {
  const byHandle = await prisma.user.findUnique({
    where: { handle: handleOrId.replace(/^@/, '').toLowerCase() },
  });

  if (byHandle) {
    return byHandle;
  }

  try {
    return await prisma.user.findUnique({ where: { id: handleOrId } });
  } catch {
    return null;
  }
}

/**
 * What this actor is and what it has actually done.
 *
 * None of this needs new storage: every edge already exists (WorkAudit records
 * who proposed, WorkClaim who leased, WorkRun what it did, WorkEvidence what it
 * produced, AgentRequest who was asked). What was missing was somewhere that
 * reads them together, so "Mia" in a thread stops being an opaque name.
 */
export async function getAgentProfile(
  prisma: PrismaClient,
  handleOrId: string,
): Promise<AgentProfile | null> {
  const actor = await findAgentActor(prisma, handleOrId);

  if (!actor) {
    return null;
  }

  const [
    openRequests,
    answeredRequests,
    runs,
    evidence,
    proposedWork,
  ] = await Promise.all([
    prisma.agentRequest.count({
      where: { state: { in: ['SUBMITTED', 'WORKING', 'INPUT_REQUIRED'] }, targetActorId: actor.id },
    }),
    prisma.agentRequest.count({ where: { state: 'COMPLETED', targetActorId: actor.id } }),
    prisma.workRun.count({ where: { actorId: actor.id } }),
    prisma.workEvidence.count({ where: { actorId: actor.id } }),
    // A creation audit has no `before`. Counting "revision 1" instead would
    // also count a webhook moving a freshly-proposed item, once those writes
    // are audited (INV-587).
    prisma.workAudit.count({ where: { actorId: actor.id, before: { equals: Prisma.DbNull } } }),
  ]);

  const credentials = await prisma.agentCredential.findMany({
    where: { userId: actor.id },
    select: {
      createdAt: true,
      expiresAt: true,
      id: true,
      name: true,
      revokedAt: true,
      scopes: true,
      team: { select: { key: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    actor,
    counts: { answeredRequests, evidence, openRequests, proposedWork, runs },
    credentials: credentials.map((credential) => ({
      createdAt: credential.createdAt,
      expiresAt: credential.expiresAt,
      id: credential.id,
      name: credential.name,
      revokedAt: credential.revokedAt,
      scopes: credential.scopes,
      teamKey: credential.team?.key ?? null,
    })),
    timeline: await buildTimeline(prisma, actor.id),
  };
}

async function buildTimeline(
  prisma: PrismaClient,
  actorId: string,
): Promise<AgentTimelineEntry[]> {
  const take = MAX_TIMELINE_ENTRIES;

  const [proposals, claims, runs, evidence, requests] = await Promise.all([
    // revision 1 is the row that created the work, so its actor is the proposer.
    prisma.workAudit.findMany({
      where: { actorId, before: { equals: Prisma.DbNull } },
      select: { createdAt: true, work: { select: { id: true, identifier: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.workClaim.findMany({
      where: { actorId },
      select: { createdAt: true, work: { select: { id: true, identifier: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.workRun.findMany({
      where: { actorId },
      select: {
        createdAt: true,
        status: true,
        summary: true,
        work: { select: { id: true, identifier: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.workEvidence.findMany({
      where: { actorId },
      select: {
        createdAt: true,
        kind: true,
        url: true,
        work: { select: { id: true, identifier: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    }),
    prisma.agentRequest.findMany({
      where: { targetActorId: actorId },
      select: {
        createdAt: true,
        state: true,
        updatedAt: true,
        work: { select: { id: true, identifier: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take,
    }),
  ]);

  const entries: AgentTimelineEntry[] = [
    ...proposals.map((row) => ({
      at: row.createdAt,
      detail: row.work.title,
      kind: 'proposed' as const,
      workId: row.work.id,
      workIdentifier: row.work.identifier,
    })),
    ...claims.map((row) => ({
      at: row.createdAt,
      detail: row.work.title,
      kind: 'claimed' as const,
      workId: row.work.id,
      workIdentifier: row.work.identifier,
    })),
    ...runs.map((row) => ({
      at: row.createdAt,
      detail: row.summary ?? row.status,
      kind: 'run' as const,
      workId: row.work.id,
      workIdentifier: row.work.identifier,
    })),
    ...evidence.map((row) => ({
      at: row.createdAt,
      detail: `${row.kind}: ${row.url}`,
      kind: 'evidence' as const,
      workId: row.work.id,
      workIdentifier: row.work.identifier,
    })),
    ...requests.map((row) => ({
      at: row.updatedAt,
      detail: toWireState(row.state),
      kind: (row.state === 'COMPLETED' ? 'answered' : 'asked') as 'answered' | 'asked',
      workId: row.work.id,
      workIdentifier: row.work.identifier,
    })),
  ];

  return entries
    .sort((left, right) => right.at.getTime() - left.at.getTime())
    .slice(0, MAX_TIMELINE_ENTRIES);
}

export interface WorkProvenance {
  actor: User | null;
  actorKind: string | null;
  source: string | null;
  surface: string | null;
}

/**
 * Where this work came from. Revision 1's audit is the creation, so its actor
 * is the proposer.
 *
 * The actor can legitimately be null: internal paths (the hotfix reflex, and
 * other service writes) record `actorKind: SERVICE` with no actor row. Returning
 * only the actor made the UI silent in exactly those cases, which reads as a
 * bug rather than as "nothing identified itself" — so the kind, the surface and
 * the source come back too, and the UI can always say something true.
 */
export async function findWorkProvenance(
  prisma: PrismaClient,
  workId: string,
): Promise<WorkProvenance> {
  const creation = await prisma.workAudit.findFirst({
    where: { workId },
    orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }],
    select: { actor: true, actorKind: true, surface: true },
  });

  return {
    actor: creation?.actor ?? null,
    actorKind: creation?.actorKind ?? null,
    source: null,
    surface: creation?.surface ?? null,
  };
}
