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
/**
 * Places each BLOCKS direction is offered before spare quota moves to the
 * other direction (INV-1765). The two reserves add up to the node limit.
 */
const DIRECTION_RESERVE = ISSUE_GRAPH_NODE_LIMIT / 2;
const FINISHED_STATE_TYPES: WorkflowStateType[] = ['COMPLETED', 'CANCELED'];
const KEEP_ORDER = [{ updatedAt: 'desc' as const }, { id: 'asc' as const }];

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

/** How many items each cap left out of one neighbourhood read (INV-1765). */
export interface IssueGraphOmitted {
  siblings: number;
  children: number;
  blockers: number;
  dependents: number;
  /** Readable ancestors past {@link MAX_ANCESTOR_DEPTH}. An unreadable gap is not counted. */
  ancestors: number;
  /** Milestone or epic ancestors past the nearest {@link MAX_ROLLUPS}. */
  rollups: number;
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
  /** True when any omitted count is above zero. */
  truncated: boolean;
  /** What the caps left out. Zero everywhere when the read is complete. */
  omitted: IssueGraphOmitted;
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
 * - **A bounded read.** Siblings, children and the BLOCKS chain are capped.
 *   What is kept, when there are more, is unfinished work first
 *   (state type other than COMPLETED or CANCELED), then most recently
 *   updated, with id ascending breaking a tie (INV-1765). The read says how
 *   many it left out rather than loading the whole project behind one item.
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

  const { chain: ancestorRows, parentId: focusParentId, omitted: ancestorsOmitted } = await loadAncestors(prisma, focus, visible);
  const childPick = await selectCapped(
    prisma,
    { AND: [visible, { OR: childrenOf(focus.id) }] },
    MAX_CHILDREN,
  );
  const children = childPick.rows;

  const siblingPick = focusParentId
    ? await selectCapped(
        prisma,
        { AND: [visible, { OR: childrenOf(focusParentId) }, { id: { not: focus.id } }] },
        MAX_SIBLINGS,
      )
    : { rows: [], omitted: 0 };
  const siblings = siblingPick.rows;

  // The BLOCKS chain around the focus, both directions.
  const dependencies = await loadBlockNeighbourhood(prisma, focus.id, depth, visible);

  const seeds = new Set<string>([focus.id]);
  for (const row of [...ancestorRows, ...children, ...siblings]) seeds.add(row.id);

  // Everything the neighbourhood touches is one read; the ids that fail the
  // readable filter simply do not come back.
  const candidateIds = [...seeds, ...dependencies.ids];
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
  const kept = [...new Set([...seeds, ...dependencies.ids])].filter((id) => byId.has(id));
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
  const { rollups, omitted: rollupsOmitted } = await loadRollups(prisma, ancestorRows, visible);
  const omitted: IssueGraphOmitted = {
    siblings: siblingPick.omitted,
    children: childPick.omitted,
    blockers: dependencies.blockersOmitted,
    dependents: dependencies.dependentsOmitted,
    ancestors: ancestorsOmitted,
    rollups: rollupsOmitted,
  };

  return {
    focus: focusVisible,
    nodes,
    edges,
    ancestors,
    rollups,
    truncated: omitted.siblings + omitted.children + omitted.blockers + omitted.dependents + omitted.ancestors + omitted.rollups > 0,
    omitted,
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
): Promise<{ chain: WorkGraphNode[]; parentId: string | null; omitted: number }> {
  const chain: WorkGraphNode[] = [];
  const seen = new Set<string>([focus.id]);
  const parentId = await effectiveParentId(prisma, focus);
  let current = parentId;
  for (let step = 0; current && step < MAX_ANCESTOR_DEPTH; step += 1) {
    const parent = await prisma.issue.findFirst({
      where: { AND: [visible, { id: current }] },
      include: NODE_INCLUDE,
    });
    // An ancestor the reader may not see ends the chain. The levels above
    // that gap are not a truncation: there is nothing readable left out.
    if (!parent || seen.has(parent.id)) {
      current = null;
      break;
    }
    seen.add(parent.id);
    chain.unshift(parent);
    current = await effectiveParentId(prisma, parent);
  }
  const omitted = current ? await countReadableAncestors(prisma, current, seen, visible) : 0;
  return { chain, parentId, omitted };
}

/** Readable ancestors still above the cap. Stops at the first one the reader may not see. */
async function countReadableAncestors(
  prisma: DatabaseClient,
  startId: string,
  seen: Set<string>,
  visible: Prisma.IssueWhereInput,
): Promise<number> {
  let count = 0;
  let current: string | null = startId;
  while (current && !seen.has(current)) {
    const parent = await prisma.issue.findFirst({
      where: { AND: [visible, { id: current }] },
      include: NODE_INCLUDE,
    });
    if (!parent) break;
    seen.add(parent.id);
    count += 1;
    current = await effectiveParentId(prisma, parent);
  }
  return count;
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
 * Keep up to `limit` items: unfinished first, then most recently updated.
 * The omitted count is the rest, from a count rather than an extra row.
 */
async function selectCapped(
  prisma: DatabaseClient,
  base: Prisma.IssueWhereInput,
  limit: number,
): Promise<{ rows: WorkGraphNode[]; omitted: number }> {
  const openWhere: Prisma.IssueWhereInput = { AND: [base, { state: { type: { notIn: FINISHED_STATE_TYPES } } }] };
  const finishedWhere: Prisma.IssueWhereInput = { AND: [base, { state: { type: { in: FINISHED_STATE_TYPES } } }] };
  const [openCount, finishedCount] = await Promise.all([
    prisma.issue.count({ where: openWhere }),
    prisma.issue.count({ where: finishedWhere }),
  ]);
  const openTake = Math.min(openCount, limit);
  const openRows = openTake
    ? await prisma.issue.findMany({ where: openWhere, include: NODE_INCLUDE, orderBy: KEEP_ORDER, take: openTake })
    : [];
  const finishedTake = Math.min(finishedCount, limit - openRows.length);
  const finishedRows = finishedTake
    ? await prisma.issue.findMany({ where: finishedWhere, include: NODE_INCLUDE, orderBy: KEEP_ORDER, take: finishedTake })
    : [];
  const rows = [...openRows, ...finishedRows];
  return { rows, omitted: openCount + finishedCount - rows.length };
}

/** Unfinished first, then newer `updatedAt`, then smaller id. */
function compareKeep(a: WorkGraphNode, b: WorkGraphNode): number {
  const tier = (node: WorkGraphNode) => (FINISHED_STATE_TYPES.includes(node.state.type) ? 1 : 0);
  const tierDelta = tier(a) - tier(b);
  if (tierDelta !== 0) return tierDelta;
  const timeDelta = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The ids the focus reaches over BLOCKS links, up to `depth` steps in either
 * direction.
 *
 * The walk has four rules, and the graph on the other side of the API depends
 * on all of them:
 *
 * - **It follows the link table only.** It never widens to other relation
 *   types, so a "related" note cannot drag the neighbourhood along.
 * - **It stops at what the reader may not see.** The readable scope is applied
 *   as the walk goes, the same way the ancestor chain stops at the first
 *   ancestor the reader may not see: a dependency leading into another team
 *   does not appear, and neither does the work behind it.
 * - **It walks one direction at a time.** Blockers form a chain upwards and
 *   dependents a chain downwards. A path that mixes the two — A blocks the
 *   focus *and* A blocks B — is not a dependency of the focus, so B is left
 *   out; this is exactly what the graph draws (`blockNeighbourhood`).
 * - **It is bounded.** Each direction is offered {@link DIRECTION_RESERVE}
 *   places first; a direction that needs fewer gives the spare places to the
 *   other. The two together stay within the node limit. Which items fill
 *   those places follows the same order as siblings and children, so two
 *   reads of the same rows return the same set.
 */
async function loadBlockNeighbourhood(
  prisma: DatabaseClient,
  focusId: string,
  depth: number,
  visible: Prisma.IssueWhereInput,
): Promise<{ ids: string[]; blockersOmitted: number; dependentsOmitted: number }> {
  if (depth === 0) return { ids: [], blockersOmitted: 0, dependentsOmitted: 0 };
  const up = await collectBlockDirection(prisma, focusId, depth, visible, 'up');
  const down = await collectBlockDirection(prisma, focusId, depth, visible, 'down');
  const upSorted = [...up].sort(compareKeep);
  const downSorted = [...down].sort(compareKeep);
  let upTake = Math.min(upSorted.length, DIRECTION_RESERVE);
  let downTake = Math.min(downSorted.length, DIRECTION_RESERVE);
  let remaining = ISSUE_GRAPH_NODE_LIMIT - upTake - downTake;
  const extraUp = Math.min(remaining, Math.max(0, upSorted.length - upTake));
  upTake += extraUp;
  remaining -= extraUp;
  const extraDown = Math.min(remaining, Math.max(0, downSorted.length - downTake));
  downTake += extraDown;
  const kept = new Set<string>([
    ...upSorted.slice(0, upTake).map((node) => node.id),
    ...downSorted.slice(0, downTake).map((node) => node.id),
  ]);
  return {
    ids: [...kept],
    blockersOmitted: upSorted.filter((node) => !kept.has(node.id)).length,
    dependentsOmitted: downSorted.filter((node) => !kept.has(node.id)).length,
  };
}

/** Every visible item reached in one BLOCKS direction, within `depth` steps. */
async function collectBlockDirection(
  prisma: DatabaseClient,
  focusId: string,
  depth: number,
  visible: Prisma.IssueWhereInput,
  direction: 'up' | 'down',
): Promise<WorkGraphNode[]> {
  const found = new Map<string, WorkGraphNode>();
  let frontier = [focusId];
  const seen = new Set<string>([focusId]);
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const links = await prisma.workLink.findMany({
      where:
        direction === 'up'
          ? { type: 'BLOCKS', toId: { in: frontier }, from: visible }
          : { type: 'BLOCKS', fromId: { in: frontier }, to: visible },
      select: { fromId: true, toId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const nextIds: string[] = [];
    for (const link of links) {
      const id = direction === 'up' ? link.fromId : link.toId;
      if (seen.has(id)) continue;
      seen.add(id);
      nextIds.push(id);
    }
    if (nextIds.length === 0) break;
    const rows = await prisma.issue.findMany({
      where: { AND: [visible, { id: { in: nextIds } }] },
      include: NODE_INCLUDE,
    });
    const loaded = new Set(rows.map((row) => row.id));
    for (const row of rows) found.set(row.id, row);
    frontier = nextIds.filter((id) => loaded.has(id));
  }
  return [...found.values()];
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
): Promise<{ rollups: WorkRollup[]; omitted: number }> {
  const containers = ancestors.filter((node) => node.kind === 'MILESTONE' || node.kind === 'EPIC');
  const targets = containers.slice(-MAX_ROLLUPS).reverse();
  const rollups: WorkRollup[] = [];
  for (const target of targets) {
    const counts = await countSubtree(prisma, target, visible);
    if (counts) rollups.push(counts);
  }
  return { rollups, omitted: Math.max(0, containers.length - MAX_ROLLUPS) };
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
 *
 * Only committed leaves count. A candidate is a proposal nobody has agreed to
 * yet, and letting it sit in the denominator would show a milestone as less
 * finished than the work under it actually is. This is the same rule the
 * project graph draws with, so the two views cannot disagree.
 */
async function countSubtree(
  prisma: DatabaseClient,
  root: WorkGraphNode,
  visible: Prisma.IssueWhereInput,
): Promise<WorkRollup | null> {
  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  const stateOf = new Map<string, WorkflowStateType>();
  const committed = new Set<string>();
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
        commitmentStatus: true,
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
      if (child.commitmentStatus === 'COMMITTED') committed.add(child.id);
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
  const leaves = [...visited].filter(
    (id) => id !== root.id && !containers.has(id) && committed.has(id),
  );

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
