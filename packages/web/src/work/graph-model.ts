/**
 * Pure model for the project graph view (INV-681): outline tree, blocker
 * classification, focus neighbourhoods, milestone roll-up and a layered DAG
 * layout. Kept free of React so every rule is unit-tested on its own.
 */

import type { WorkflowStateType } from '../board/types';
import type { WorkKind, WorkLinkType } from './types';

export interface GraphNode {
  id: string;
  identifier: string;
  title: string;
  kind: WorkKind;
  commitmentStatus: 'CANDIDATE' | 'COMMITTED' | 'REJECTED';
  stateName: string;
  stateType: WorkflowStateType;
  assigneeName: string | null;
  /** Linked from the project but belongs elsewhere. */
  external: boolean;
}

export interface GraphEdge {
  id: string;
  type: WorkLinkType;
  fromId: string;
  toId: string;
}

const CLOSED: ReadonlySet<WorkflowStateType> = new Set(['COMPLETED', 'CANCELED']);
const UNDER_WAY: ReadonlySet<WorkflowStateType> = new Set(['STARTED', 'REVIEW', 'COMPLETED']);

export function isClosed(node: Pick<GraphNode, 'stateType'>): boolean {
  return CLOSED.has(node.stateType);
}

/** Same rule as the ready gate: a committed blocker neither Done nor Canceled. */
export function isOpenBlocker(node: Pick<GraphNode, 'stateType' | 'commitmentStatus'>): boolean {
  return node.commitmentStatus === 'COMMITTED' && !isClosed(node);
}

export type BlockEdgeStatus = 'resolved' | 'open' | 'violated';

/**
 * resolved: the blocker is closed (or only a candidate, which never gates).
 * violated: the blocker is still open yet the blocked work already started.
 * open: the blocker is open and the blocked work is correctly waiting.
 */
export function classifyBlockEdge(from: GraphNode, to: GraphNode): BlockEdgeStatus {
  if (!isOpenBlocker(from)) return 'resolved';
  return UNDER_WAY.has(to.stateType) ? 'violated' : 'open';
}

export function openBlockersOf(nodeId: string, edges: GraphEdge[], byId: Map<string, GraphNode>): GraphNode[] {
  return edges
    .filter((edge) => edge.type === 'BLOCKS' && edge.toId === nodeId)
    .map((edge) => byId.get(edge.fromId))
    .filter((node): node is GraphNode => Boolean(node && isOpenBlocker(node)));
}

// ---------------------------------------------------------------------------
// Outline (CONTAINS tree)

export interface OutlineItem {
  node: GraphNode;
  children: OutlineItem[];
  /** State-type counts over leaf descendants (the node itself when it is a leaf). */
  rollup: Partial<Record<WorkflowStateType, number>>;
  leafCount: number;
}

export interface Outline {
  roots: OutlineItem[];
  /** In-scope work no CONTAINS edge places under the project root. */
  unplaced: OutlineItem[];
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  const kindRank = (kind: WorkKind) => (kind === 'PROJECT' ? 0 : kind === 'MILESTONE' ? 1 : kind === 'EPIC' ? 2 : 3);
  return (
    kindRank(left.kind) - kindRank(right.kind) ||
    left.identifier.localeCompare(right.identifier, undefined, { numeric: true })
  );
}

export function buildOutline(nodes: GraphNode[], edges: GraphEdge[], rootId: string | null): Outline {
  const byId = new Map(nodes.filter((node) => !node.external).map((node) => [node.id, node]));
  const childIds = new Map<string, string[]>();
  const parentIds = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'CONTAINS' || !byId.has(edge.fromId) || !byId.has(edge.toId)) continue;
    childIds.set(edge.fromId, [...(childIds.get(edge.fromId) ?? []), edge.toId]);
    parentIds.set(edge.toId, [...(parentIds.get(edge.toId) ?? []), edge.fromId]);
  }

  const placed = new Set<string>();
  function build(node: GraphNode, path: Set<string>): OutlineItem {
    placed.add(node.id);
    const nextPath = new Set(path).add(node.id);
    const children = (childIds.get(node.id) ?? [])
      .filter((id) => !nextPath.has(id))
      .map((id) => byId.get(id)!)
      .sort(compareNodes)
      .map((child) => build(child, nextPath));
    const rollup: Partial<Record<WorkflowStateType, number>> = {};
    let leafCount = 0;
    if (children.length === 0) {
      rollup[node.stateType] = 1;
      leafCount = 1;
    } else {
      for (const child of children) {
        leafCount += child.leafCount;
        for (const [type, count] of Object.entries(child.rollup) as Array<[WorkflowStateType, number]>) {
          rollup[type] = (rollup[type] ?? 0) + count;
        }
      }
    }
    return { node, children, rollup, leafCount };
  }

  const rootNode = rootId ? byId.get(rootId) : undefined;
  const roots = rootNode
    ? [build(rootNode, new Set())]
    : [...byId.values()].filter((node) => !parentIds.has(node.id)).sort(compareNodes).map((node) => build(node, new Set()));
  // Everything the root does not reach: start from the tops of what is left
  // (nothing left above them), then from any survivor of a CONTAINS cycle.
  const unplaced: OutlineItem[] = [];
  for (;;) {
    const remaining = [...byId.values()].filter((node) => !placed.has(node.id));
    if (remaining.length === 0) break;
    const remainingIds = new Set(remaining.map((node) => node.id));
    const tops = remaining.filter((node) => !(parentIds.get(node.id) ?? []).some((id) => remainingIds.has(id)));
    for (const node of (tops.length ? tops : remaining.slice(0, 1)).sort(compareNodes)) {
      if (!placed.has(node.id)) unplaced.push(build(node, new Set()));
    }
  }
  return { roots, unplaced };
}

/** Nearest MILESTONE ancestor along CONTAINS, or null. */
export function milestoneIndex(nodes: GraphNode[], edges: GraphEdge[]): Map<string, GraphNode | null> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === 'CONTAINS' && !parentOf.has(edge.toId)) parentOf.set(edge.toId, edge.fromId);
  }
  const result = new Map<string, GraphNode | null>();
  for (const node of nodes) {
    let current = parentOf.get(node.id);
    const seen = new Set([node.id]);
    let found: GraphNode | null = null;
    while (current && !seen.has(current)) {
      seen.add(current);
      const candidate = byId.get(current);
      if (candidate?.kind === 'MILESTONE') {
        found = candidate;
        break;
      }
      current = parentOf.get(current);
    }
    result.set(node.id, node.kind === 'MILESTONE' ? node : found);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dependency view

/** Work within `hops` BLOCKS steps upstream or downstream of `focusId` (Infinity = whole chain). */
export function blockNeighbourhood(focusId: string, edges: GraphEdge[], hops: number): Set<string> {
  const blocks = edges.filter((edge) => edge.type === 'BLOCKS');
  const result = new Set([focusId]);
  for (const direction of ['up', 'down'] as const) {
    let frontier = [focusId];
    const seen = new Set([focusId]);
    for (let step = 0; step < hops && frontier.length; step += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of blocks) {
          const neighbour = direction === 'up' ? (edge.toId === id ? edge.fromId : null) : edge.fromId === id ? edge.toId : null;
          if (neighbour && !seen.has(neighbour)) {
            seen.add(neighbour);
            result.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
  }
  return result;
}

export interface MilestoneRollup {
  nodes: GraphNode[];
  edges: Array<GraphEdge & { count: number; status: BlockEdgeStatus }>;
}

const STATUS_RANK: Record<BlockEdgeStatus, number> = { resolved: 0, open: 1, violated: 2 };

/**
 * BLOCKS edges lifted to milestone level: milestone A blocks milestone B when
 * any item under A blocks any item under B. Items with no milestone keep
 * their own node. The lifted edge takes its worst member's status.
 */
export function rollUpToMilestones(nodes: GraphNode[], edges: GraphEdge[]): MilestoneRollup {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const milestones = milestoneIndex(nodes, edges);
  const representative = (id: string) => milestones.get(id) ?? byId.get(id) ?? null;
  const lifted = new Map<string, GraphEdge & { count: number; status: BlockEdgeStatus }>();
  for (const edge of edges) {
    if (edge.type !== 'BLOCKS') continue;
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    const fromRep = representative(edge.fromId);
    const toRep = representative(edge.toId);
    if (!from || !to || !fromRep || !toRep || fromRep.id === toRep.id) continue;
    const key = `${fromRep.id}>${toRep.id}`;
    const status = classifyBlockEdge(from, to);
    const existing = lifted.get(key);
    if (existing) {
      existing.count += 1;
      if (STATUS_RANK[status] > STATUS_RANK[existing.status]) existing.status = status;
    } else {
      lifted.set(key, { id: key, type: 'BLOCKS', fromId: fromRep.id, toId: toRep.id, count: 1, status });
    }
  }
  const used = new Set([...lifted.values()].flatMap((edge) => [edge.fromId, edge.toId]));
  return { nodes: [...used].map((id) => byId.get(id)!).filter(Boolean), edges: [...lifted.values()] };
}

export interface LayoutNode {
  id: string;
  layer: number;
  order: number;
  x: number;
  y: number;
}

export interface Layout {
  nodes: Map<string, LayoutNode>;
  width: number;
  height: number;
}

export const LAYOUT = { nodeWidth: 188, nodeHeight: 46, columnGap: 52, rowGap: 12, padding: 20 } as const;

/**
 * Layered left-to-right layout: each node sits one layer right of its deepest
 * blocker (longest path, so a chain reads left to right), then a few
 * barycenter sweeps order each layer to reduce crossings. Cycles cannot be
 * stored for BLOCKS, but the layering still terminates if one appears.
 */
export function layoutDag(nodeIds: string[], edges: Array<Pick<GraphEdge, 'fromId' | 'toId'>>): Layout {
  const ids = new Set(nodeIds);
  const incoming = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const outgoing = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.fromId) || !ids.has(edge.toId) || edge.fromId === edge.toId) continue;
    incoming.get(edge.toId)!.push(edge.fromId);
    outgoing.get(edge.fromId)!.push(edge.toId);
  }

  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...incoming.get(id)!.map(depth)) + 1;
    visiting.delete(id);
    layer.set(id, value);
    return value;
  }
  nodeIds.forEach(depth);
  // A source (nothing blocks it) sits just left of its earliest dependent
  // rather than in column 0, so a late prerequisite is drawn next to what it
  // gates instead of across the whole chart. It has no incoming edge, so
  // moving it right never breaks the left-to-right order.
  for (const id of nodeIds) {
    const successors = outgoing.get(id)!;
    if (incoming.get(id)!.length === 0 && successors.length > 0) {
      layer.set(id, Math.max(0, Math.min(...successors.map((successor) => layer.get(successor)!)) - 1));
    }
  }

  const layers: string[][] = [];
  for (const id of nodeIds) {
    const index = layer.get(id)!;
    (layers[index] ??= []).push(id);
  }

  for (let index = 0; index < layers.length; index += 1) layers[index] ??= [];
  const position = new Map<string, number>();
  const refreshPositions = () => layers.forEach((ids) => ids.forEach((id, index) => position.set(id, index)));
  refreshPositions();
  const barycenter = (id: string, neighbours: Map<string, string[]>) => {
    const values = neighbours.get(id)!.map((other) => position.get(other)!).filter((value) => value !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : position.get(id)!;
  };
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward ? layers.keys() : [...layers.keys()].reverse();
    for (const index of order) {
      const current = layers[index];
      if (!current) continue;
      const neighbours = downward ? incoming : outgoing;
      const scored = current.map((id) => ({ id, score: barycenter(id, neighbours) }));
      scored.sort((left, right) => left.score - right.score);
      layers[index] = scored.map((entry) => entry.id);
      refreshPositions();
    }
  }

  const nodes = new Map<string, LayoutNode>();
  let tallest = 0;
  layers.forEach((ids, layerIndex) => {
    tallest = Math.max(tallest, ids.length);
    ids.forEach((id, order) => {
      nodes.set(id, {
        id,
        layer: layerIndex,
        order,
        x: LAYOUT.padding + layerIndex * (LAYOUT.nodeWidth + LAYOUT.columnGap),
        y: LAYOUT.padding + order * (LAYOUT.nodeHeight + LAYOUT.rowGap),
      });
    });
  });
  const columns = layers.length;
  return {
    nodes,
    width: LAYOUT.padding * 2 + Math.max(0, columns * LAYOUT.nodeWidth + (columns - 1) * LAYOUT.columnGap),
    height: LAYOUT.padding * 2 + Math.max(0, tallest * LAYOUT.nodeHeight + (tallest - 1) * LAYOUT.rowGap),
  };
}
