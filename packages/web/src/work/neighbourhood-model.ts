/**
 * The neighbourhood of one work item (INV-1496), as pure data.
 *
 * The server returns the nodes and the typed links between them; this module
 * decides what that means for the item in the middle. Keeping it free of React
 * means every rule here is unit-tested on its own, the way the project graph
 * model is.
 *
 * Six groups make up a neighbourhood, and they answer six different questions:
 *
 * - **ancestors** — the chain from the top of the hierarchy down to the item's
 *   parent. "Which milestone am I in?"
 * - **siblings** — the other children of the item's parent. "What are my
 *   peers doing?"
 * - **children** — the item's own sub-issues. "What is waiting under me?"
 * - **blockers** — what the item waits on. "What is holding me up?"
 * - **dependents** — what waits on the item. "What am I holding up?"
 * - **rollups** — the progress of the nearest milestone and epic. "How far
 *   along is the thing I belong to?"
 */

import type { GraphEdge, GraphNode } from './graph-model';
import { classifyBlockEdge, isOpenBlocker } from './graph-model';

export interface Neighbourhood {
  focus: GraphNode;
  /** The chain from the topmost ancestor down to the focus's parent. */
  ancestors: GraphNode[];
  /** The other children of the focus's parent. */
  siblings: GraphNode[];
  /** The focus's own sub-issues. */
  children: GraphNode[];
  /** Work that blocks the focus, open blockers first. */
  blockers: GraphNode[];
  /** Work the focus blocks. */
  dependents: GraphNode[];
}

export interface NeighbourhoodEdge {
  edge: GraphEdge;
  /** How the edge reads: an open blocker, a broken rule, a settled one. */
  status: 'open' | 'violated' | 'resolved';
}

/**
 * Builds the neighbourhood of one item.
 *
 * The hierarchy comes from CONTAINS edges rather than from a parent pointer,
 * because the edges are what the graph draws and what the server filters — one
 * source of truth, so the tree and the links cannot disagree.
 */
export function buildNeighbourhood(
  nodes: GraphNode[],
  edges: GraphEdge[],
  focusId: string,
): Neighbourhood | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const focus = byId.get(focusId);
  if (!focus) return null;

  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'CONTAINS') continue;
    if (!byId.has(edge.fromId) || !byId.has(edge.toId)) continue;
    parentOf.set(edge.toId, edge.fromId);
    childrenOf.set(edge.fromId, [...(childrenOf.get(edge.fromId) ?? []), edge.toId]);
  }

  const ancestors: GraphNode[] = [];
  const seen = new Set<string>([focus.id]);
  let current = parentOf.get(focus.id);
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = byId.get(current);
    if (!node) break;
    ancestors.unshift(node);
    current = parentOf.get(current);
  }

  const parentId = parentOf.get(focus.id);
  const siblings = parentId
    ? (childrenOf.get(parentId) ?? [])
        .filter((id) => id !== focus.id)
        .map((id) => byId.get(id))
        .filter((node): node is GraphNode => Boolean(node))
    : [];

  const children = (childrenOf.get(focus.id) ?? [])
    .map((id) => byId.get(id))
    .filter((node): node is GraphNode => Boolean(node));

  const blockers: GraphNode[] = [];
  const dependents: GraphNode[] = [];
  for (const edge of edges) {
    if (edge.type !== 'BLOCKS') continue;
    if (edge.toId === focus.id) {
      const node = byId.get(edge.fromId);
      if (node) blockers.push(node);
    } else if (edge.fromId === focus.id) {
      const node = byId.get(edge.toId);
      if (node) dependents.push(node);
    }
  }

  // An open blocker is the one that matters, so it sorts first: the reader
  // wants to see what is holding them up before what already finished.
  blockers.sort((left, right) => Number(isOpenBlocker(right)) - Number(isOpenBlocker(left)));

  return { focus, ancestors, siblings, children, blockers, dependents };
}

/**
 * The neighbourhood's BLOCKS edges, each with the status the graph draws.
 * The status says whether a rule was followed: an item that started while its
 * blocker was still open is a broken dependency, not a healthy one.
 */
export function neighbourhoodBlockEdges(
  neighbourhood: Neighbourhood,
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
): NeighbourhoodEdge[] {
  const result: NeighbourhoodEdge[] = [];
  for (const edge of edges) {
    if (edge.type !== 'BLOCKS') continue;
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) continue;
    const touchesFocus = edge.fromId === neighbourhood.focus.id || edge.toId === neighbourhood.focus.id;
    if (!touchesFocus) continue;
    result.push({ edge, status: classifyBlockEdge(from, to) });
  }
  return result;
}

/** One line of progress over an item's descendants. */
export interface RollupLine {
  id: string;
  identifier: string;
  title: string;
  kind: string;
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  canceled: number;
  /** 0–1; a container with nothing under it has no progress to speak of. */
  ratio: number;
  /** "3 of 8 done" — the plain reading of the row. */
  label: string;
}

/**
 * Reads a rollup as a line of progress. The counts stay separate rather than
 * being collapsed into one percentage: "3 of 8 done" and "2 in flight" answer
 * different questions, and a reader deciding whether to help wants both.
 */
export function toRollupLine(rollup: {
  id: string;
  identifier: string;
  title: string;
  kind: string;
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  canceled: number;
}): RollupLine {
  const ratio = rollup.total > 0 ? rollup.completed / rollup.total : 0;
  return {
    ...rollup,
    ratio,
    label: rollup.total > 0 ? `${rollup.completed} of ${rollup.total} done` : 'nothing under it yet',
  };
}
