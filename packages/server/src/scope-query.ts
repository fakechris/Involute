import type { Prisma, PrismaClient } from '@prisma/client';

import { createValidationError, exposeErrorMessages } from './errors.js';
import { replayMilestoneScope, scopeWindow, type ScopeSnapshot, type ScopeWindowInput } from './scope-history.js';

const NOT_FOUND = 'Readable milestone not found.';
const WRONG_KIND = 'Burndown requires a MILESTONE.';
exposeErrorMessages([NOT_FOUND, WRONG_KIND]);

function snapshot(value: Prisma.JsonValue): ScopeSnapshot {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const field = (key: string) => typeof row[key] === 'string' ? row[key] as string : null;
  return { parentId: field('parentId'), commitmentStatus: field('commitmentStatus'), stateId: field('stateId'), kind: field('kind') };
}

export async function loadMilestoneBurndown(prisma: PrismaClient, readable: Prisma.IssueWhereInput, input: ScopeWindowInput & { milestoneId: string }, now = new Date()) {
  try { scopeWindow(input); } catch (error) {
    const message = (error as Error).message;
    exposeErrorMessages([message]);
    throw createValidationError(message);
  }
  const selector: Prisma.IssueWhereInput = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.milestoneId)
    ? { id: input.milestoneId } : { identifier: { equals: input.milestoneId, mode: 'insensitive' } };
  const milestone = await prisma.issue.findFirst({ where: { AND: [readable, selector] }, select: { id: true, identifier: true, kind: true, teamId: true } });
  if (!milestone) throw createValidationError(NOT_FOUND);
  if (milestone.kind !== 'MILESTONE') throw createValidationError(WRONG_KIND);
  const rows = await prisma.issue.findMany({
    where: { AND: [readable, { teamId: milestone.teamId }] },
    select: { id: true, identifier: true, parentId: true,
      incomingLinks: { where: { type: 'CONTAINS' }, select: { fromId: true } },
      audits: { select: { id: true, workId: true, createdAt: true, before: true, after: true, surface: true, actorKind: true, actorId: true, reason: true } },
    },
  });
  const normalized = rows.map(row => ({ ...row, audits: row.audits.map(audit => ({ ...audit, before: audit.before === null ? null : snapshot(audit.before), after: snapshot(audit.after) })) }));
  const candidateIds = new Set([milestone.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of normalized) {
      if (candidateIds.has(row.id)) continue;
      const parents = [row.parentId, ...row.incomingLinks.map(l => l.fromId), ...row.audits.flatMap(a => [a.before?.parentId, a.after.parentId])];
      if (parents.some(id => id && candidateIds.has(id))) { candidateIds.add(row.id); changed = true; }
    }
  }
  const candidates = normalized.filter(row => row.id !== milestone.id && candidateIds.has(row.id));
  const states = await prisma.workflowState.findMany({ where: { teamId: milestone.teamId }, select: { id: true, type: true } });
  return { milestone: { id: milestone.id, identifier: milestone.identifier }, ...replayMilestoneScope({ ...input, milestoneId: milestone.id, now,
    works: candidates.map(row => ({ id: row.id, identifier: row.identifier })), audits: candidates.flatMap(row => row.audits), states: new Map(states.map(s => [s.id, s.type])),
  }) };
}
