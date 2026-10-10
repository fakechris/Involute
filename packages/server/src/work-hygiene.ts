import type { Issue, Prisma, PrismaClient } from '@prisma/client';

import { dependencyWordedReferences, extractTeamReferences } from './mention-links.js';
import { incidentNeedsPostmortem } from './incident-closure.js';
import { INCIDENT_LABEL_NAME } from './labels.js';
import { contractTexts, missingCloseRequirements, saysNoActionable } from './work-closure.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const RESEARCH_LABEL = 'research';
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
  researchWithoutDownstreamCount: number;
  /** Research in Review whose derived items are all committed: nothing left to wait for (INV-1001). */
  researchClosable: Issue[];
  researchClosableCount: number;
  /** Research in Review or Done with no file attached: the report was never uploaded (INV-1128). */
  researchWithoutAttachment: Issue[];
  researchWithoutAttachmentCount: number;
  /** Incidents in Review or Done nothing derives from and that do not say "无可执行点" (INV-1126). */
  incidentsWithoutDownstream: Issue[];
  incidentsWithoutDownstreamCount: number;
  /** SEV1/SEV2 incidents in Review or Done with no attachment: the postmortem is missing (INV-1126). */
  incidentsWithoutPostmortem: Issue[];
  incidentsWithoutPostmortemCount: number;
}

function isResearch(issue: { labels: Array<{ name: string }> }): boolean {
  return issue.labels.some((label) => label.name.toLowerCase() === RESEARCH_LABEL);
}

function isIncident(issue: { labels: Array<{ name: string }> }): boolean {
  return issue.labels.some((label) => label.name.toLowerCase() === INCIDENT_LABEL_NAME.toLowerCase());
}

/** The ids among `issues` that have at least one attachment. */
async function attachedIds(prisma: DatabaseClient, issues: Issue[]): Promise<Set<string | null>> {
  if (!issues.length) return new Set();
  const rows = await prisma.attachment.findMany({ where: { issueId: { in: issues.map((issue) => issue.id) } }, select: { issueId: true }, distinct: ['issueId'] });
  return new Set(rows.map((row) => row.issueId));
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
  const derivedFrom = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== 'DERIVED_FROM') continue;
    derivedFrom.set(link.toId, [...(derivedFrom.get(link.toId) ?? []), link.fromId]);
  }

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

  // Only committed items are loaded, so a derived id missing from byId is a
  // candidate (or declined) item: the research still waits for it.
  const researchClosable = issues.filter(
    (issue) =>
      isResearch(issue) &&
      issue.state.type === 'REVIEW' &&
      (derivedFrom.get(issue.id) ?? []).length > 0 &&
      derivedFrom.get(issue.id)!.every((id) => byId.has(id)),
  );

  const researchWithoutDownstream = issues.filter(
    (issue) =>
      isResearch(issue) &&
      (issue.state.type === 'REVIEW' || issue.state.type === 'COMPLETED') &&
      !derivedTargets.has(issue.id) &&
      !saysNoActionable(contractTexts(issue)),
  );

  // Finished research should carry its report as a private file (INV-1003, INV-1128).
  const finishedResearch = issues.filter((issue) => isResearch(issue) && (issue.state.type === 'REVIEW' || issue.state.type === 'COMPLETED'));
  const researchAttached = await attachedIds(prisma, finishedResearch);
  const researchWithoutAttachment = finishedResearch.filter((issue) => !researchAttached.has(issue.id));

  // Incidents being closed or closed (INV-1126): the follow-ups and, for
  // SEV1/SEV2, the postmortem attachment the closing rule asks for.
  const closingIncidents = issues.filter((issue) => isIncident(issue) && (issue.state.type === 'REVIEW' || issue.state.type === 'COMPLETED'));
  const incidentsWithoutDownstream = closingIncidents.filter((issue) => !derivedTargets.has(issue.id) && !saysNoActionable(contractTexts(issue)));
  const needingPostmortem = closingIncidents.filter((issue) => incidentNeedsPostmortem(issue.severity));
  const attached = await attachedIds(prisma, needingPostmortem);
  const incidentsWithoutPostmortem = needingPostmortem.filter((issue) => !attached.has(issue.id));

  return {
    incidentsWithoutDownstream: incidentsWithoutDownstream.slice(0, LIST_LIMIT),
    incidentsWithoutDownstreamCount: incidentsWithoutDownstream.length,
    incidentsWithoutPostmortem: incidentsWithoutPostmortem.slice(0, LIST_LIMIT),
    incidentsWithoutPostmortemCount: incidentsWithoutPostmortem.length,
    unplaced: unplaced.slice(0, LIST_LIMIT),
    unplacedCount: unplaced.length,
    unlinkedMentions: unlinkedMentions.slice(0, LIST_LIMIT),
    unlinkedMentionCount: unlinkedMentions.length,
    dependencyWithoutBlocks: dependencyWithoutBlocks.slice(0, LIST_LIMIT),
    dependencyWithoutBlocksCount: dependencyWithoutBlocks.length,
    researchWithoutDownstream: researchWithoutDownstream.slice(0, LIST_LIMIT),
    researchWithoutDownstreamCount: researchWithoutDownstream.length,
    researchClosable: researchClosable.slice(0, LIST_LIMIT),
    researchClosableCount: researchClosable.length,
    researchWithoutAttachment: researchWithoutAttachment.slice(0, LIST_LIMIT),
    researchWithoutAttachmentCount: researchWithoutAttachment.length,
  };
}

/**
 * Research items `workId` was derived from that now have every derived item
 * committed and still sit in Review — the ones whose proposer can close them (INV-1001).
 */
export async function closableResearchSources(prisma: DatabaseClient, workId: string): Promise<Issue[]> {
  const links = await prisma.workLink.findMany({ where: { type: 'DERIVED_FROM', fromId: workId }, select: { toId: true } });
  const closable: Issue[] = [];
  for (const { toId } of links) {
    const research = await prisma.issue.findUnique({ where: { id: toId }, include: { labels: { select: { name: true } }, state: { select: { type: true } } } });
    if (!research || !isResearch(research) || research.state.type !== 'REVIEW' || research.commitmentStatus !== 'COMMITTED') continue;
    const derived = await prisma.workLink.findMany({ where: { type: 'DERIVED_FROM', toId }, select: { from: { select: { commitmentStatus: true } } } });
    if (derived.length > 0 && derived.every((link) => link.from.commitmentStatus === 'COMMITTED')) closable.push(research);
  }
  return closable;
}

/**
 * For a research item reaching Review: true when nothing derives from it and
 * it does not say it had no actionable outcome (norm v1 C, INV-721).
 */
export async function researchLacksDownstream(prisma: DatabaseClient, workId: string, extraText?: string | null): Promise<boolean> {
  const work = await prisma.issue.findUnique({ where: { id: workId }, include: { labels: { select: { name: true } } } });
  if (!work || !work.labels.some((label) => label.name.toLowerCase() === RESEARCH_LABEL)) return false;
  return (await missingCloseRequirements(prisma, work, ['downstream'], extraText)).length > 0;
}

/**
 * For a research item being completed or closed: true when no file is attached
 * to it — its report was not uploaded with work_attach_file (INV-1003, INV-1128).
 * A reminder, never a refusal.
 */
export async function researchLacksAttachment(prisma: DatabaseClient, workId: string): Promise<boolean> {
  const work = await prisma.issue.findUnique({ where: { id: workId }, include: { labels: { select: { name: true } } } });
  if (!work || !isResearch(work)) return false;
  return (await missingCloseRequirements(prisma, work, ['attachment'])).length > 0;
}
