import type { ActorKind, Prisma, PrismaClient } from '@prisma/client';

import { createValidationError, exposeErrorMessages } from './errors.js';
import {
  replayMilestoneScope,
  scopeWindow,
  type ScopeAudit,
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
  readableDeletions: Prisma.WorkDeletionWhereInput,
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
    // Deleted work keeps its place in history (INV-1929).
    const deleted = await prisma.workDeletion.findMany({
      where: {
        AND: [readableDeletions, {
          teamId: milestone.teamId,
          workId: { notIn: [...visited] },
          parentIds: { hasSome: frontier },
        }],
      },
      select: { workId: true },
    });
    frontier = [...new Set([...children.map(child => child.id), ...deleted.map(row => row.workId)])];
    for (const id of frontier) visited.add(id);
  }
  visited.delete(milestone.id);
  return [...visited];
}

const AUDIT_SELECT = {
  id: true,
  revision: true,
  workId: true,
  createdAt: true,
  before: true,
  after: true,
  surface: true,
  actorKind: true,
  actorId: true,
  reason: true,
} as const;

function deletedAudits(row: { workId: string; audits: Prisma.JsonValue }): ScopeAudit[] {
  const audits = Array.isArray(row.audits) ? row.audits : [];
  return audits.flatMap(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const audit = value as Record<string, Prisma.JsonValue>;
    if (typeof audit.id !== 'string' || typeof audit.createdAt !== 'string') return [];
    return [{
      id: audit.id,
      revision: typeof audit.revision === 'number' ? audit.revision : 0,
      workId: row.workId,
      createdAt: new Date(audit.createdAt),
      before: audit.before === null || audit.before === undefined ? null : snapshot(audit.before),
      after: snapshot(audit.after ?? null),
      surface: typeof audit.surface === 'string' ? audit.surface : null,
      actorKind: (typeof audit.actorKind === 'string' ? audit.actorKind : 'SERVICE') as ActorKind,
      actorId: typeof audit.actorId === 'string' ? audit.actorId : null,
      reason: typeof audit.reason === 'string' ? audit.reason : null,
    }];
  });
}

export async function loadMilestoneBurndown(
  prisma: PrismaClient,
  readable: Prisma.IssueWhereInput,
  input: ScopeWindowInput & { milestoneId: string },
  /** Deleted work this reader may see in history; omitted, none (INV-1929). */
  readableDeletions: Prisma.WorkDeletionWhereInput = { workId: { in: [] } },
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
  const ids = await candidateIds(prisma, readable, readableDeletions, milestone);
  const candidates = await prisma.issue.findMany({
    where: { AND: [readable, { id: { in: ids } }] },
    select: { id: true, identifier: true, audits: { select: AUDIT_SELECT } },
  });
  const deletions = await prisma.workDeletion.findMany({
    where: { AND: [readableDeletions, { teamId: milestone.teamId, workId: { in: ids } }] },
    orderBy: { deletedAt: 'asc' },
  });
  const audits: ScopeAudit[] = candidates.flatMap(row => row.audits.map(audit => ({
    ...audit,
    before: audit.before === null ? null : snapshot(audit.before),
    after: snapshot(audit.after),
  })));
  const live = new Set(candidates.map(row => row.id));
  const works = new Map(candidates.map(row => [row.id, { id: row.id, identifier: row.identifier, deletedAt: null as Date | null }]));
  // Each deletion carries the whole chain so far; replay one copy of each audit.
  const seen = new Set(audits.map(audit => audit.id));
  for (const deletion of deletions) {
    const final = snapshot(deletion.final);
    const chain = deletedAudits(deletion);
    if (!live.has(deletion.workId)) {
      for (const audit of chain) {
        if (seen.has(audit.id)) continue;
        seen.add(audit.id);
        audits.push(audit);
      }
      works.set(deletion.workId, {
        id: deletion.workId,
        identifier: deletion.identifier,
        deletedAt: chain.length === 0 ? deletion.deletedAt : null,
      });
    }
    // A deletion with no recorded chain is reported as a gap, not replayed.
    if (chain.length === 0 && !live.has(deletion.workId)) continue;
    const removed: ScopeSnapshot = { ...final, parentId: null };
    audits.push({
      id: deletion.id,
      revision: deletion.revision,
      workId: deletion.workId,
      createdAt: deletion.deletedAt,
      before: final,
      after: removed,
      surface: deletion.surface,
      actorKind: deletion.actorKind,
      actorId: deletion.actorId,
      reason: deletion.reason ?? 'Work item deleted',
    });
  }
  // A restore audit starts from nothing; it continues from its deletion.
  for (const deletion of deletions) {
    if (!deletion.restoredAt) continue;
    const restore = audits
      .filter(a => a.workId === deletion.workId && a.before === null && a.createdAt >= deletion.deletedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (restore) restore.before = { ...snapshot(deletion.final), parentId: null };
  }
  const known = new Set([milestone.id, ...works.keys()]);
  const named = new Set(audits.flatMap(a => [a.before?.parentId, a.after.parentId]).filter((id): id is string => !!id && !known.has(id)));
  const existing = named.size === 0 ? [] : await prisma.issue.findMany({ where: { id: { in: [...named] } }, select: { id: true } });
  const recorded = named.size === 0 ? [] : await prisma.workDeletion.findMany({ where: { workId: { in: [...named] } }, select: { workId: true } });
  for (const row of [...existing.map(r => r.id), ...recorded.map(r => r.workId)]) named.delete(row);
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
      works: [...works.values()],
      audits,
      unknownParents: named,
      states: new Map(states.map(s => [s.id, s.type])),
    }),
  };
}
