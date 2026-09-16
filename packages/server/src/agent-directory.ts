import { toWireState } from './agent-request-state.js';

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

export interface AgentProfile {
  actor: User;
  counts: AgentActivityCounts;
  timeline: AgentTimelineEntry[];
}

/** AGENT actors, most recently active first — the directory behind `@`. */
export async function listAgentActors(
  prisma: PrismaClient,
  input: { teamKey?: string | null } = {},
): Promise<User[]> {
  return prisma.user.findMany({
    where: {
      actorKind: 'AGENT',
      ...(input.teamKey
        ? { memberships: { some: { team: { key: input.teamKey } } } }
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
    prisma.workAudit.count({ where: { actorId: actor.id, revision: 1 } }),
  ]);

  return {
    actor,
    counts: { answeredRequests, evidence, openRequests, proposedWork, runs },
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
      where: { actorId, revision: 1 },
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

/**
 * The actor that created this work. Already recorded — revision 1's audit is
 * the creation — but never surfaced, so nobody could tell which agent proposed
 * an INV.
 */
export async function findProposingActor(
  prisma: PrismaClient,
  workId: string,
): Promise<User | null> {
  const creation = await prisma.workAudit.findFirst({
    where: { workId },
    orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }],
    select: { actor: true },
  });

  return creation?.actor ?? null;
}
