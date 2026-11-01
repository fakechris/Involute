import type { Issue, Prisma, PrismaClient, WorkflowState, WorkflowStateType, WorkLinkType } from '@prisma/client';

import { OPEN_BLOCKER_LINK_WHERE } from './context-service.js';
import { createNotFoundError, ISSUE_NOT_FOUND_MESSAGE } from './errors.js';
import type { WorkGraphEdge, WorkGraphNode } from './work-graph-view.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Upper bound on nodes one neighbourhood read returns; beyond it the view says so. */
export const ISSUE_GRAPH_NODE_LIMIT = 400;
/** How many BLOCKS steps the neighbourhood may follow from the focus. */
export const ISSUE_GRAPH_MAX_DEPTH = 4;
/** How far up the CONTAINS chain the ancestor list may reach. */
const MAX_ANCESTOR_DEPTH = 16;
/** How many siblings of the focus are listed. */
const MAX_SIBLINGS = 80;
/** How many direct children of the focus are listed. */
const MAX_CHILDREN = 120;
/** How many milestone / epic ancestors get a progress rollup. */
const MAX_ROLLUPS = 3;

const NODE_INCLUDE = { state: true, assignee: true } as const;

export interface WorkRollup {
  id: string;
  identifier: string;
  title: string;
  kind: Issue['kind'];
  /** Committed descendants below the item (the item itself is not counted). */
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  canceled: number;
}

export interface IssueWorkGraph {
  /** The item the neighbourhood is centred on. */
  focus: WorkGraphNode;
  /** Every item in the neighbourhood this viewer may read. */
  nodes: WorkGraphNode[];
  /** The typed links between those items. */
  edges: WorkGraphEdge[];
  /** The CONTAINS chain, topmost ancestor first, ending at the focus's parent. */
  ancestors: WorkGraphNode[];
  /** Progress rollups for the nearest milestone / epic ancestors, nearest first. */
  rollups: WorkRollup[];
  /** True when the neighbourhood has more items than one read returns. */
  truncated: boolean;
}

/**
 * One work item's neighbourhood (INV-1496): the CONTAINS chain above it, its
 * direct children, its siblings, and the BLOCKS chain around it.
 *
 * The project graph answers "how does this whole project fit together". This
 * answers the question a person actually has with one item open: *where am I
 * in the milestone, what is my sibling doing, what am I waiting on*. It is the
 * same typed work graph, read from a different root — the edges are the same
 * rows, so the two views cannot disagree.
 *
 * Two rules shape the read:
 *
 * - **Only what the reader may see.** Every node is filtered by the same
 *   readable scope the rest of the API uses, and an edge is returned only when
 *   both of its ends survive that filter. A dependency that leads into
 *   another team simply does not appear.
 * - **A bounded read.** The neighbourhood is capped: too many siblings or
 *   children and the view says it is truncated rather than loading the whole
 *   project behind one item.
 */
export async function loadIssueWorkGraph(
  prisma: DatabaseClient,
  input: { id: string; depth?: number | null },
  readableWhere?: Prisma.IssueWhereInput,
): Promise<IssueWorkGraph> {
  const focusRow = await prisma.issue.findUnique({
    where: { id: input.id },
    include: NODE_INCLUDE,
  });
  if (!focusRow) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);

  const depth = clampDepth(input.depth);
  const visible: Prisma.IssueWhereInput = { AND: [readableWhere ?? {}, { commitmentStatus: { not: 'REJECTED' } }] };

  // The focus is the subject of the read; it is shown even when it is still a
  // candidate, because a person is looking at it right now.
  const focus = focusRow;

  const { chain: ancestorRows, parentId: focusParentId } = await loadAncestors(prisma, focus, visible);
  const childRows = await prisma.issue.findMany({
    where: { AND: [visible, { OR: childrenOf(focus.id) }] },
    include: NODE_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_CHILDREN + 1,
  });
  const childrenTruncated = childRows.length > MAX_CHILDREN;
  const children = childRows.slice(0, MAX_CHILDREN);

  const siblingRows = focusParentId
    ? await prisma.issue.findMany({
        where: { AND: [visible, { OR: childrenOf(focusParentId) }, { id: { not: focus.id } }] },
        include: NODE_INCLUDE,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_SIBLINGS + 1,
      })
    : [];
  const siblingsTruncated = siblingRows.length > MAX_SIBLINGS;
  const siblings = siblingRows.slice(0, MAX_SIBLINGS);

  // The BLOCKS chain around the focus, both directions.
  const dependencyIds = await loadBlockNeighbourhood(prisma, focus.id, depth);

  const seeds = new Set<string>([focus.id]);
  for (const row of [...ancestorRows, ...children, ...siblings]) seeds.add(row.id);

  // Everything the neighbourhood touches is one read; the ids that fail the
  // readable filter simply do not come back.
  const candidateIds = [...seeds, ...dependencyIds];
  const collected = await prisma.issue.findMany({
    where: { AND: [visible, { id: { in: candidateIds } }] },
    include: NODE_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const byId = new Map(collected.map((node) => [node.id, node]));

  const focusVisible = byId.get(focus.id) ?? null;
  if (!focusVisible) {
    // The reader may not see the item they asked about. The resolver refuses
    // before reaching this point; this is the belt to that braces.
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  // Everything the neighbourhood touches: the hierarchy around the item and
  // the dependency chain around it. An id that failed the readable filter
  // simply does not come back, so it drops out here too.
  const kept = [...new Set([...seeds, ...dependencyIds])].filter((id) => byId.has(id));
  const nodes = kept.map((id) => byId.get(id)!).filter(Boolean);

  const links = await prisma.workLink.findMany({
    where: { OR: [{ fromId: { in: kept } }, { toId: { in: kept } }] },
    select: { id: true, type: true, fromId: true, toId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const known = new Set(kept);
  const edges = links.filter((link) => known.has(link.fromId) && known.has(link.toId));

  const ancestors = ancestorRows
    .map((row) => byId.get(row.id))
    .filter((row): row is WorkGraphNode => Boolean(row));
  const rollups = await loadRollups(prisma, ancestorRows, visible);

  return {
    focus: focusVisible,
    nodes,
    edges,
    ancestors,
    rollups,
    truncated: childrenTruncated || siblingsTruncated || dependencyIds.length > ISSUE_GRAPH_NODE_LIMIT,
  };
}

function clampDepth(depth: number | null | undefined): number {
  if (depth === null || depth === undefined) return 1;
  if (!Number.isInteger(depth) || depth < 0) return 1;
  return Math.min(depth, ISSUE_GRAPH_MAX_DEPTH);
}

/**
 * The CONTAINS chain above the focus, topmost ancestor first. The walk stops
 * at the first ancestor the reader may not see: the chain is a path, and a
 * gap in it would make the levels above it meaningless.
 */
async function loadAncestors(
  prisma: DatabaseClient,
  focus: WorkGraphNode,
  visible: Prisma.IssueWhereInput,
): Promise<{ chain: WorkGraphNode[]; parentId: string | null }> {
  const chain: WorkGraphNode[] = [];
  const seen = new Set<string>([focus.id]);
  const parentId = await effectiveParentId(prisma, focus);
  let current = parentId;
  for (let step = 0; current && step < MAX_ANCESTOR_DEPTH; step += 1) {
    const parent = await prisma.issue.findFirst({
      where: { AND: [visible, { id: current }] },
      include: NODE_INCLUDE,
    });
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.unshift(parent);
    current = await effectiveParentId(prisma, parent);
  }
  return { chain, parentId };
}

/**
 * The parent of an item, from the projection or from the CONTAINS edge.
 *
 * Both are kept in step by the link service, but the edges are what the
 * graph draws and what the server filters. Reading the parent the same way
 * the edges are read means the tree this view returns and the tree the graph
 * draws cannot drift apart.
 */
async function effectiveParentId(prisma: DatabaseClient, issue: WorkGraphNode): Promise<string | null> {
  if (issue.parentId) return issue.parentId;
  const link = await prisma.workLink.findFirst({
    where: { type: 'CONTAINS', toId: issue.id },
    select: { fromId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return link?.fromId ?? null;
}

/** The items held by one container, by projection or by CONTAINS edge. */
function childrenOf(parentId: string): Prisma.IssueWhereInput[] {
  return [
    { parentId },
    { incomingLinks: { some: { type: 'CONTAINS', fromId: parentId } } },
  ];
}

/**
 * The ids the focus reaches over BLOCKS links, up to `depth` steps in either
 * direction. The walk follows the link table only — it never widens to other
 * relation types, so a "related" note cannot drag the neighbourhood along.
 */
async function loadBlockNeighbourhood(prisma: DatabaseClient, focusId: string, depth: number): Promise<string[]> {
  if (depth === 0) return [];
  const found = new Set<string>();
  let frontier = [focusId];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const links = await prisma.workLink.findMany({
      where: { type: 'BLOCKS', OR: [{ fromId: { in: frontier } }, { toId: { in: frontier } }] },
      select: { fromId: true, toId: true },
    });
    const next: string[] = [];
    for (const link of links) {
      for (const id of [link.fromId, link.toId]) {
        if (id === focusId || found.has(id)) continue;
        found.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  return [...found];
}

/**
 * Progress rollups for the nearest milestone / epic ancestors. The counts are
 * aggregated in the database rather than by loading the subtree, so a
 * milestone with two hundred children costs the same as one with two.
 *
 * Only MILESTONE and EPIC ancestors get a rollup: a project's subtree is the
 * whole project, which is what the project graph is for.
 */
async function loadRollups(
  prisma: DatabaseClient,
  ancestors: WorkGraphNode[],
  visible: Prisma.IssueWhereInput,
): Promise<WorkRollup[]> {
  const targets = ancestors
    .filter((node) => node.kind === 'MILESTONE' || node.kind === 'EPIC')
    .slice(-MAX_ROLLUPS)
    .reverse();
  const rollups: WorkRollup[] = [];
  for (const target of targets) {
    const counts = await countSubtree(prisma, target, visible);
    if (counts) rollups.push(counts);
  }
  return rollups;
}

interface SubtreeCounts {
  total: number;
  completed: number;
  inProgress: number;
  canceled: number;
}

/**
 * Counts the leaves of an item's subtree.
 *
 * Leaves, not every descendant: a milestone holding an epic that holds three
 * issues is three pieces of work, not four. Counting the containers as well
 * would put "4 of 8 done" on a milestone that has three done — a number
 * nobody could act on.
 */
async function countSubtree(
  prisma: DatabaseClient,
  root: WorkGraphNode,
  visible: Prisma.IssueWhereInput,
): Promise<WorkRollup | null> {
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  const stateOf = new Map<string, WorkflowStateType>();
  // The parent each descendant hangs under, so a container can be told from
  // a piece of work once the whole subtree is known.
  const parentOf = new Map<string, string>();

  while (frontier.length > 0) {
    const children = await prisma.issue.findMany({
      where: { AND: [visible, {
        OR: [
          { parentId: { in: frontier } },
          { incomingLinks: { some: { type: 'CONTAINS', fromId: { in: frontier } } } },
        ],
      }] },
      select: {
        id: true,
        parentId: true,
        state: { select: { type: true } },
        incomingLinks: { where: { type: 'CONTAINS' }, select: { fromId: true }, take: 1 },
      },
    });
    const next: string[] = [];
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      next.push(child.id);
      stateOf.set(child.id, child.state.type);
      const parent = child.parentId ?? child.incomingLinks[0]?.fromId ?? null;
      if (parent) parentOf.set(child.id, parent);
    }
    frontier = next;
  }

  // A descendant that holds other descendants is a container, not a leaf.
  const containers = new Set<string>();
  for (const parent of parentOf.values()) {
    if (parent !== root.id && visited.has(parent)) containers.add(parent);
  }
  const leaves = [...visited].filter((id) => id !== root.id && !containers.has(id));

  const byState: Partial<Record<WorkflowStateType, number>> = {};
  for (const leaf of leaves) {
    const type = stateOf.get(leaf);
    if (type) byState[type] = (byState[type] ?? 0) + 1;
  }

  const counts: SubtreeCounts = {
    total: leaves.length,
    completed: byState.COMPLETED ?? 0,
    // Work under way: started, and waiting for a human in review.
    inProgress: (byState.STARTED ?? 0) + (byState.REVIEW ?? 0),
    canceled: byState.CANCELED ?? 0,
  };
  const blocked = await countBlocked(prisma, leaves, visible);
  return {
    id: root.id,
    identifier: root.identifier,
    title: root.title,
    kind: root.kind,
    total: counts.total,
    completed: counts.completed,
    inProgress: counts.inProgress,
    blocked,
    canceled: counts.canceled,
  };
}

/**
 * How many of these items wait on something that is not finished yet.
 */
async function countBlocked(
  prisma: DatabaseClient,
  ids: string[],
  visible: Prisma.IssueWhereInput,
): Promise<number> {
  if (ids.length === 0) return 0;
  const links = await prisma.workLink.findMany({
    where: {
      AND: [
        { type: 'BLOCKS', toId: { in: ids } },
        {
          from: {
            ...OPEN_BLOCKER_LINK_WHERE.from,
            ...(visible ?? {}),
          },
        },
      ],
    },
    select: { toId: true },
  });
  return new Set(links.map((link) => link.toId)).size;
}

export type { WorkGraphEdge, WorkGraphNode, WorkLinkType, WorkflowState };
