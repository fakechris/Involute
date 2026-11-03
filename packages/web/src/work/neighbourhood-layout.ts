/**
 * The radial layout of one item's neighbourhood (INV-1496).
 *
 * A list says *what* is around an item; a map says *what shape* it is. The
 * shape is the thing a person actually wants to know: "am I alone here, is
 * the milestone mostly done, is the thing blocking me one step away or three".
 *
 * The map is a hub with five sectors:
 *
 * ```text
 *            ancestors (up)
 *                  ▽
 *   siblings  ◀    ●    ▶  blockers
 *    (left)   focus      (upper right)
 *                  ▽
 *            children (down)     dependents (lower right)
 * ```
 *
 * The layout is **pure and deterministic**: the same neighbourhood always
 * draws the same way, so a reader who comes back to an item finds it where
 * they left it, and so the arrangement can be unit-tested instead of being
 * eyeballed. Nothing here reads the DOM or the clock.
 *
 * Every node hangs off the hub by an edge that means something:
 *
 * - **hierarchy** — a real CONTAINS edge (ancestors above, children below).
 * - **peer** — the siblings share a parent, so the link to the hub is a
 *   dashed "same parent" hint, not a typed edge. It is drawn differently on
 *   purpose.
 * - **open / violated / resolved** — a real BLOCKS edge, coloured by the same
 *   three-state rule the project graph uses.
 */

import type { GraphEdge, GraphNode } from './graph-model';
import { classifyBlockEdge } from './graph-model';
import type { Neighbourhood } from './neighbourhood-model';

export type NeighbourhoodRole = 'focus' | 'ancestor' | 'sibling' | 'child' | 'blocker' | 'dependent';

/** How an edge on the map reads. */
export type MapEdgeKind = 'hierarchy' | 'peer' | 'open' | 'violated' | 'resolved';

export interface PlacedNode {
  id: string;
  role: NeighbourhoodRole;
  x: number;
  y: number;
  r: number;
  /** Degrees from the hub, 0 = right, 90 = down. */
  angle: number;
  node: GraphNode;
}

export interface PlacedEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: MapEdgeKind;
  /** An SVG path, ready to draw, from `fromId` to `toId` (the arrow points at `toId`). */
  path: string;
  /** What the link says, written on it (INV-1546); null for the dashed same-parent hint. */
  label: 'parent' | 'blocks' | null;
  /** Where the label sits: the middle of the curve. */
  labelAt: { x: number; y: number };
}

export interface NeighbourhoodMapLayout {
  width: number;
  height: number;
  /** Where the focus sits. */
  hub: { x: number; y: number };
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** How many items each sector could not show. */
  hidden: Record<Exclude<NeighbourhoodRole, 'focus'>, number>;
}

export interface NeighbourhoodMapCaps {
  ancestor?: number;
  sibling?: number;
  child?: number;
  blocker?: number;
  dependent?: number;
}

/**
 * The sector each role occupies, in degrees (0 = right, 90 = down, 180 =
 * left, 270 = up). The sectors do not overlap, so a node's role is readable
 * from where it sits without reading a legend.
 */
const SECTORS: Record<Exclude<NeighbourhoodRole, 'focus'>, { from: number; to: number }> = {
  ancestor: { from: 247, to: 293 },
  blocker: { from: 300, to: 354 },
  dependent: { from: 6, to: 60 },
  child: { from: 64, to: 116 },
  sibling: { from: 138, to: 222 },
};

/** How far from the hub a node sits, as a share of the drawing's short side. */
const RING_SHARE = 0.33;
/** The focus is bigger than everything around it: it is the subject. */
const HUB_RADIUS = 13;
const NODE_RADIUS = 8;

function degreesToPoint(cx: number, cy: number, radius: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + Math.cos(radians) * radius, y: cy + Math.sin(radians) * radius };
}

/**
 * Places one role's items inside its sector.
 *
 * A single item sits in the middle of its sector; several spread across it.
 * The ancestor sector is the exception: a chain reads better as a zigzag that
 * grows away from the hub than as a flat row, so its members alternate
 * between the near and the far ring.
 */
function placeRole(
  role: Exclude<NeighbourhoodRole, 'focus'>,
  items: GraphNode[],
  cx: number,
  cy: number,
  radius: number,
): Array<{ node: GraphNode; x: number; y: number; angle: number }> {
  const sector = SECTORS[role];
  return items.map((node, index) => {
    if (role === 'ancestor') {
      const depth = items.length - 1 - index;
      const angle = (sector.from + sector.to) / 2 + (depth % 2 === 0 ? -15 : 15);
      const ring = radius + (depth % 2) * radius * 0.34;
      const point = degreesToPoint(cx, cy, ring, angle);
      return { node, x: point.x, y: point.y, angle };
    }
    const angle =
      items.length === 1
        ? (sector.from + sector.to) / 2
        : sector.from + ((sector.to - sector.from) * index) / (items.length - 1);
    const point = degreesToPoint(cx, cy, radius, angle);
    return { node, x: point.x, y: point.y, angle };
  });
}

/**
 * A curve between two placed nodes, bowed away from the hub.
 *
 * The bow is what turns a star into a map: straight spokes read as a wheel,
 * curved ones read as a shape with a centre.
 */
function curveBetween(
  from: { x: number; y: number; r: number },
  to: { x: number; y: number; r: number },
  hub: { x: number; y: number },
): { path: string; middle: { x: number; y: number } } {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = mx - hub.x;
  const dy = my - hub.y;
  const length = Math.hypot(dx, dy) || 1;
  const bow = Math.min(length * 0.3, 30);
  const controlX = mx + (dx / length) * bow;
  const controlY = my + (dy / length) * bow;

  // Start and end on the rim of the node rather than in its middle.
  const start = pointOnRim(from, controlX, controlY);
  // The arrowhead sits on the target's rim, so the curve stops a little short.
  const end = pointOnRim({ ...to, r: to.r + 2 }, controlX, controlY);
  // The middle of a quadratic curve: where its label goes.
  const middle = {
    x: round(0.25 * start.x + 0.5 * controlX + 0.25 * end.x),
    y: round(0.25 * start.y + 0.5 * controlY + 0.25 * end.y),
  };
  return {
    path: `M${round(start.x)},${round(start.y)} Q${round(controlX)},${round(controlY)} ${round(end.x)},${round(end.y)}`,
    middle,
  };
}

function pointOnRim(node: { x: number; y: number; r: number }, towardsX: number, towardsY: number) {
  const dx = towardsX - node.x;
  const dy = towardsY - node.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: node.x + (dx / length) * node.r, y: node.y + (dy / length) * node.r };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Lays the neighbourhood out as a radial map.
 *
 * `caps` says how many items of each role fit; the rest are counted as hidden
 * so the view can say "+4 more" instead of silently dropping them.
 */
export function layoutNeighbourhood(input: {
  neighbourhood: Neighbourhood;
  edges: GraphEdge[];
  width: number;
  height: number;
  caps?: NeighbourhoodMapCaps | undefined;
}): NeighbourhoodMapLayout {
  const { neighbourhood, edges, width, height } = input;
  const caps = input.caps ?? {};
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * RING_SHARE;

  const focus = neighbourhood.focus;
  const placed: PlacedNode[] = [
    { id: focus.id, role: 'focus', x: cx, y: cy, r: HUB_RADIUS, angle: 0, node: focus },
  ];

  const hidden: Record<Exclude<NeighbourhoodRole, 'focus'>, number> = {
    ancestor: 0,
    sibling: 0,
    child: 0,
    blocker: 0,
    dependent: 0,
  };

  // Each item is drawn once, in the role that says the most about it
  // (INV-1546): a sibling that also blocks the focus is a blocker on the map.
  const taken = new Set<string>([focus.id]);
  const claim = (items: GraphNode[]) =>
    items.filter((node) => {
      if (taken.has(node.id)) return false;
      taken.add(node.id);
      return true;
    });
  const ancestors = claim(neighbourhood.ancestors);
  const blockers = claim(neighbourhood.blockers);
  const dependents = claim(neighbourhood.dependents);
  const children = claim(neighbourhood.children);
  const siblings = claim(neighbourhood.siblings);
  const roleItems: Record<Exclude<NeighbourhoodRole, 'focus'>, GraphNode[]> = {
    ancestor: ancestors,
    sibling: siblings,
    child: children,
    blocker: blockers,
    dependent: dependents,
  };

  for (const role of ['ancestor', 'sibling', 'child', 'blocker', 'dependent'] as const) {
    const items = roleItems[role];
    const cap = caps[role] ?? items.length;
    const shown = items.slice(0, Math.max(cap, 0));
    hidden[role] = items.length - shown.length;
    for (const spot of placeRole(role, shown, cx, cy, radius)) {
      placed.push({
        id: spot.node.id,
        role,
        x: spot.x,
        y: spot.y,
        r: NODE_RADIUS,
        angle: spot.angle,
        node: spot.node,
      });
    }
  }

  const byId = new Map(placed.map((node) => [node.id, node]));
  const hub = byId.get(focus.id)!;
  const drawn: PlacedEdge[] = [];

  const push = (id: string, fromId: string, toId: string, kind: MapEdgeKind) => {
    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (!from || !to) return;
    const curve = curveBetween(from, to, { x: cx, y: cy });
    const label = kind === 'peer' ? null : kind === 'hierarchy' ? 'parent' : 'blocks';
    drawn.push({ id, fromId, toId, kind, path: curve.path, label, labelAt: curve.middle });
  };

  // The hierarchy: each ancestor hangs off the one below it, the nearest one
  // off the focus itself. Children hang off the focus. The edge is drawn in
  // the direction the link actually has — a CONTAINS edge points from parent
  // to child, so the edge between the focus and its own parent points *at*
  // the focus.
  neighbourhood.ancestors.forEach((ancestor, index) => {
    const neighbour = neighbourhood.ancestors[index + 1] ?? focus;
    const edge = edges.find(
      (candidate) =>
        candidate.type === 'CONTAINS' &&
        ((candidate.fromId === ancestor.id && candidate.toId === neighbour.id) ||
          (candidate.fromId === neighbour.id && candidate.toId === ancestor.id)),
    );
    if (edge) {
      push(edge.id, edge.fromId, edge.toId, 'hierarchy');
    } else {
      push(`contains:${ancestor.id}:${neighbour.id}`, ancestor.id, neighbour.id, 'hierarchy');
    }
  });
  for (const child of children) {
    const edge = edges.find(
      (candidate) => candidate.type === 'CONTAINS' && candidate.toId === child.id && candidate.fromId === focus.id,
    );
    push(edge?.id ?? `contains:${focus.id}:${child.id}`, focus.id, child.id, 'hierarchy');
  }

  // Peers: the link is a hint, not a typed edge, and is drawn dashed.
  for (const sibling of siblings) {
    push(`peer:${focus.id}:${sibling.id}`, focus.id, sibling.id, 'peer');
  }

  // Dependencies: real BLOCKS edges, coloured by the rule the graph uses.
  for (const blocker of blockers) {
    const edge = edges.find(
      (candidate) => candidate.type === 'BLOCKS' && candidate.toId === focus.id && candidate.fromId === blocker.id,
    );
    push(edge?.id ?? `blocks:${blocker.id}:${focus.id}`, blocker.id, focus.id, classifyBlockEdge(blocker, focus));
  }
  for (const dependent of dependents) {
    const edge = edges.find(
      (candidate) => candidate.type === 'BLOCKS' && candidate.fromId === focus.id && candidate.toId === dependent.id,
    );
    push(edge?.id ?? `blocks:${focus.id}:${dependent.id}`, focus.id, dependent.id, classifyBlockEdge(focus, dependent));
  }

  return { width, height, hub: { x: cx, y: cy }, nodes: placed, edges: drawn, hidden };
}
