import type { Issue, Prisma, PrismaClient } from '@prisma/client';

import { dependencyWordedReferences, extractTeamReferences } from './mention-links.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const RESEARCH_LABEL = 'research';
const NO_ACTIONABLE = /无可执行点|no actionable/i;
const LIST_LIMIT = 200;

export interface ReferencePair {
  from: Issue;
  to: Issue;
}

export interface WorkHygiene {
  unplaced: Issue[];
  unplacedCount: number;
  unlinkedMentions: ReferencePair[];
  unlinkedMentionCount: number;
  dependencyWithoutBlocks: ReferencePair[];
  dependencyWithoutBlocksCount: number;
  researchWithoutDownstream: Issue[];
}

function contractTexts(issue: Issue): Array<string | null> {
  return [issue.description, issue.outcome, issue.scope, issue.constraints, issue.acceptance, issue.verification];
}

/**
 * Where the work graph falls short of norm v1 (INV-718/721), for one team's
 * committed work: items no PROJECT contains, references in text with no edge,
 * dependencies written in prose without BLOCKS, and finished research nothing
 * derives from. Computed in memory from one read; lists are capped, counts are not.
 */
export async function loadWorkHygiene(
  prisma: DatabaseClient,
  input: { teamId: string; teamKey: string },
): Promise<WorkHygiene> {
  const issues = await prisma.issue.findMany({
    where: { teamId: input.teamId, commitmentStatus: 'COMMITTED' },
    include: { labels: { select: { name: true } }, state: { select: { type: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ids = issues.map((issue) => issue.id);
  const links = ids.length
    ? await prisma.workLink.findMany({
        where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] },
        select: { type: true, fromId: true, toId: true },
      })
    : [];
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
  const aliases = issues.filter((issue) => issue.kind === 'PROJECT' && issue.alias).map((issue) => issue.alias!);

  const parentOf = new Map<string, string>();
  for (const issue of issues) if (issue.parentId) parentOf.set(issue.id, issue.parentId);
  for (const link of links) if (link.type === 'CONTAINS' && !parentOf.has(link.toId)) parentOf.set(link.toId, link.fromId);
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const anyLink = new Set(links.map((link) => pairKey(link.fromId, link.toId)));
  for (const [child, parent] of parentOf) anyLink.add(pairKey(child, parent));
  const blocksLink = new Set(links.filter((link) => link.type === 'BLOCKS').map((link) => pairKey(link.fromId, link.toId)));
  const derivedTargets = new Set(links.filter((link) => link.type === 'DERIVED_FROM').map((link) => link.toId));

  const unplaced: Issue[] = [];
  for (const issue of issues) {
    if (issue.kind === 'PROJECT') continue;
    const seen = new Set([issue.id]);
    let current: string | undefined = parentOf.get(issue.id);
    let top: Issue | undefined;
    while (current && !seen.has(current)) {
      seen.add(current);
      top = byId.get(current);
      current = parentOf.get(current);
    }
    // A project of another repository does not place it either (e.g. a
    // cross-repo parent), matching the 2026-09-26 baseline (INV-717).
    const crossRepository = Boolean(top?.repository && issue.repository && top.repository !== issue.repository);
    if (!top || top.kind !== 'PROJECT' || crossRepository) unplaced.push(issue);
  }

  const unlinkedMentions: ReferencePair[] = [];
  const dependencyWithoutBlocks: ReferencePair[] = [];
  for (const issue of issues) {
    const texts = contractTexts(issue);
    for (const identifier of extractTeamReferences(texts, input.teamKey, aliases)) {
      const target = byIdentifier.get(identifier);
      if (!target || target.id === issue.id) continue;
      if (!anyLink.has(pairKey(issue.id, target.id))) unlinkedMentions.push({ from: issue, to: target });
    }
    for (const identifier of dependencyWordedReferences(texts, input.teamKey, aliases)) {
      const target = byIdentifier.get(identifier);
      if (!target || target.id === issue.id) continue;
      if (!blocksLink.has(pairKey(issue.id, target.id))) dependencyWithoutBlocks.push({ from: issue, to: target });
    }
  }

  const researchWithoutDownstream = issues.filter(
    (issue) =>
      issue.labels.some((label) => label.name.toLowerCase() === RESEARCH_LABEL) &&
      (issue.state.type === 'REVIEW' || issue.state.type === 'COMPLETED') &&
      !derivedTargets.has(issue.id) &&
      !contractTexts(issue).some((text) => text && NO_ACTIONABLE.test(text)),
  );

  return {
    unplaced: unplaced.slice(0, LIST_LIMIT),
    unplacedCount: unplaced.length,
    unlinkedMentions: unlinkedMentions.slice(0, LIST_LIMIT),
    unlinkedMentionCount: unlinkedMentions.length,
    dependencyWithoutBlocks: dependencyWithoutBlocks.slice(0, LIST_LIMIT),
    dependencyWithoutBlocksCount: dependencyWithoutBlocks.length,
    researchWithoutDownstream,
  };
}

/**
 * For a research item reaching Review: true when nothing derives from it and
 * it does not say it had no actionable outcome (norm v1 C, INV-721).
 */
export async function researchLacksDownstream(prisma: DatabaseClient, workId: string, extraText?: string | null): Promise<boolean> {
  const work = await prisma.issue.findUnique({ where: { id: workId }, include: { labels: { select: { name: true } } } });
  if (!work || !work.labels.some((label) => label.name.toLowerCase() === RESEARCH_LABEL)) return false;
  const derived = await prisma.workLink.count({ where: { type: 'DERIVED_FROM', toId: workId } });
  if (derived > 0) return false;
  return ![...contractTexts(work), extraText ?? null].some((text) => text && NO_ACTIONABLE.test(text));
}
