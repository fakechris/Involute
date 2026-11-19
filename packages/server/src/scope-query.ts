import type { Prisma, PrismaClient } from '@prisma/client';

import { createValidationError, exposeErrorMessages } from './errors.js';
import {
  replayMilestoneScope,
  scopeWindow,
  type ScopeHistoryResult,
  type ScopeSnapshot,
  type ScopeWindowInput,
} from './scope-history.js';

const NOT_FOUND = 'Readable milestone not found.';
const WRONG_KIND = 'Burndown requires a MILESTONE.';
exposeErrorMessages([NOT_FOUND, WRONG_KIND]);

function snapshot(value: Prisma.JsonValue): ScopeSnapshot {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const field = (key: string) => typeof row[key] === 'string' ? row[key] as string : null;
  return {
    parentId: field('parentId'),
    commitmentStatus: field('commitmentStatus'),
    stateId: field('stateId'),
    kind: field('kind'),
  };
}

export interface MilestoneBurndownResult extends ScopeHistoryResult {
  milestone: { id: string; identifier: string };
}

async function candidateIds(
  prisma: PrismaClient,
  readable: Prisma.IssueWhereInput,
  milestone: { id: string; teamId: string },
): Promise<string[]> {
  const visited = new Set([milestone.id]);
  let frontier = [milestone.id];
  while (frontier.length > 0) {
    const historicalParents: Prisma.WorkAuditWhereInput[] = frontier.flatMap(id => [
      { before: { path: ['parentId'], equals: id } },
      { after: { path: ['parentId'], equals: id } },
    ]);
    const children = await prisma.issue.findMany({
      where: {
        AND: [readable, {
          teamId: milestone.teamId,
          id: { notIn: [...visited] },
          OR: [
            { parentId: { in: frontier } },
            { incomingLinks: { some: { type: 'CONTAINS', fromId: { in: frontier } } } },
            { audits: { some: { OR: historicalParents } } },
          ],
        }],
      },
      select: { id: true },
    });
    frontier = children.map(child => child.id);
    for (const id of frontier) visited.add(id);
  }
  visited.delete(milestone.id);
  return [...visited];
}

export async function loadMilestoneBurndown(
  prisma: PrismaClient,
  readable: Prisma.IssueWhereInput,
  input: ScopeWindowInput & { milestoneId: string },
  now = new Date(),
): Promise<MilestoneBurndownResult> {
  try {
    scopeWindow(input);
  } catch (error) {
    const message = (error as Error).message;
    exposeErrorMessages([message]);
    throw createValidationError(message);
  }
  const selector: Prisma.IssueWhereInput = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.milestoneId)
    ? { id: input.milestoneId } : { identifier: { equals: input.milestoneId, mode: 'insensitive' } };
  const milestone = await prisma.issue.findFirst({
    where: { AND: [readable, selector] },
    select: { id: true, identifier: true, kind: true, teamId: true },
  });
  if (!milestone) throw createValidationError(NOT_FOUND);
  if (milestone.kind !== 'MILESTONE') throw createValidationError(WRONG_KIND);
  const ids = await candidateIds(prisma, readable, milestone);
  const candidates = await prisma.issue.findMany({
    where: { AND: [readable, { id: { in: ids } }] },
    select: {
      id: true,
      identifier: true,
      audits: {
        select: {
          id: true,
          workId: true,
          createdAt: true,
          before: true,
          after: true,
          surface: true,
          actorKind: true,
          actorId: true,
          reason: true,
        },
      },
    },
  });
  const audits = candidates.flatMap(row => row.audits.map(audit => ({
    ...audit,
    before: audit.before === null ? null : snapshot(audit.before),
    after: snapshot(audit.after),
  })));
  const states = await prisma.workflowState.findMany({
    where: { teamId: milestone.teamId },
    select: { id: true, type: true },
  });
  return {
    milestone: { id: milestone.id, identifier: milestone.identifier },
    ...replayMilestoneScope({
      ...input,
      milestoneId: milestone.id,
      now,
      works: candidates.map(row => ({ id: row.id, identifier: row.identifier })),
      audits,
      states: new Map(states.map(s => [s.id, s.type])),
    }),
  };
}
