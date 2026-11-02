import { useMemo, useState } from 'react';

import type { GraphEdge, GraphNode } from '../../work/graph-model';
import { buildNeighbourhood } from '../../work/neighbourhood-model';
import { layoutNeighbourhood, type NeighbourhoodMapCaps, type PlacedNode } from '../../work/neighbourhood-layout';

/**
 * One item's neighbourhood as a radial map (INV-1496).
 *
 * The list said *what* is around an item; this says *what shape* it is. The
 * shape is the question a person actually has: am I alone here, is the
 * milestone mostly done, is what blocks me one step away or three.
 *
 * The focus sits in the middle and everything else hangs off it in a sector
 * that says what it is — ancestors above, peers to the left, children below,
 * dependencies to the right. Hovering a node lights the edges that touch it
 * and fades the rest; clicking one picks it.
 *
 * The drawing is pure SVG: positions are attributes, not inline styles, so the
 * map follows the theme through the stylesheet alone.
 */

interface NeighbourhoodMapProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusId: string;
  /** The drawing's coordinate space; the SVG scales it to the container. */
  width?: number;
  height?: number;
  /** How many items of each role fit before the rest are counted as hidden. */
  caps?: NeighbourhoodMapCaps;
  /** Called when a node is picked. */
  onSelect?: (id: string) => void;
  /** Called when a node is opened (double click). */
  onOpen?: (id: string) => void;
  /** Draw the legend row under the map. */
  showLegend?: boolean;
}

const ROLE_LABEL = {
  ancestor: { one: 'ancestor', many: 'ancestors' },
  sibling: { one: 'sibling', many: 'siblings' },
  child: { one: 'child', many: 'children' },
  blocker: { one: 'blocker', many: 'blockers' },
  dependent: { one: 'dependent', many: 'dependents' },
} as const;

/** Where a node's label sits, and how it hangs off the dot. */
function labelSpot(
  node: PlacedNode,
  hub: { x: number; y: number },
): { x: number; y: number; anchor: 'inherit' | 'end' | 'start' | 'middle' } {
  const dx = node.x - hub.x;
  const dy = node.y - hub.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const offset = node.r + 5;
  return {
    x: node.x + ux * offset,
    y: node.y + uy * offset + 3,
    anchor: ux < -0.35 ? 'end' : ux > 0.35 ? 'start' : 'middle',
  };
}

export function NeighbourhoodMap({
  nodes,
  edges,
  focusId,
  width = 360,
  height = 250,
  caps,
  onSelect,
  onOpen,
  showLegend = true,
}: NeighbourhoodMapProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const neighbourhood = useMemo(() => buildNeighbourhood(nodes, edges, focusId), [nodes, edges, focusId]);
  const layout = useMemo(
    () => (neighbourhood ? layoutNeighbourhood({ neighbourhood, edges, width, height, caps }) : null),
    [neighbourhood, edges, width, height, caps],
  );

  const highlightedEdges = useMemo(() => {
    if (!layout || !hovered) return null;
    return new Set(
      layout.edges.filter((edge) => edge.fromId === hovered || edge.toId === hovered).map((edge) => edge.id),
    );
  }, [hovered, layout]);

  const highlightedNodes = useMemo(() => {
    if (!layout || !hovered) return null;
    const set = new Set<string>([hovered]);
    for (const edge of layout.edges) {
      if (edge.fromId === hovered || edge.toId === hovered) {
        set.add(edge.fromId);
        set.add(edge.toId);
      }
    }
    return set;
  }, [hovered, layout]);

  if (!neighbourhood || !layout) return null;

  const counts: Record<string, number> = { ancestor: 0, sibling: 0, child: 0, blocker: 0, dependent: 0 };
  for (const node of layout.nodes) {
    if (node.role !== 'focus') counts[node.role] = (counts[node.role] ?? 0) + 1;
  }

  return (
    <div className="issue-neighbourhood__map-wrap">
      <svg
        className="issue-neighbourhood__map"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label="Neighbourhood map"
        onMouseLeave={() => setHovered(null)}
      >
        <g>
          {layout.edges.map((edge) => {
            const faded = highlightedEdges ? !highlightedEdges.has(edge.id) : false;
            return (
              <path
                key={edge.id}
                d={edge.path}
                className={[
                  'issue-neighbourhood__map-edge',
                  `issue-neighbourhood__map-edge--${edge.kind}`,
                  faded ? 'issue-neighbourhood__map-edge--faded' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            );
          })}
        </g>
        <g>
          {layout.nodes.map((node) => {
            const faded = highlightedNodes ? !highlightedNodes.has(node.id) : false;
            const label = labelSpot(node, layout.hub);
            const title = `${node.node.identifier} ${node.node.title}`;
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={title}
                className={[
                  'issue-neighbourhood__map-node',
                  `issue-neighbourhood__map-node--${node.role}`,
                  faded ? 'issue-neighbourhood__map-node--faded' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseEnter={() => setHovered(node.id)}
                onFocus={() => setHovered(node.id)}
                onBlur={() => setHovered(null)}
                onClick={() => onSelect?.(node.id)}
                onDoubleClick={() => onOpen?.(node.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelect?.(node.id);
                }}
              >
                <title>{title}</title>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.r}
                  className={`issue-neighbourhood__map-dot issue-neighbourhood__map-dot--${node.role}`}
                />
                <text x={label.x} y={label.y} className="issue-neighbourhood__map-label" textAnchor={label.anchor}>
                  {node.node.identifier}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {showLegend ? (
        <ul className="issue-neighbourhood__map-legend" aria-label="Neighbourhood key">
          {(['ancestor', 'sibling', 'child', 'blocker', 'dependent'] as const).map((role) => {
            const hidden = layout.hidden[role];
            if (counts[role] === 0 && hidden === 0) return null;
            return (
              <li key={role} className={`issue-neighbourhood__map-key issue-neighbourhood__map-key--${role}`}>
                <span className="issue-neighbourhood__map-swatch" aria-hidden="true" />
                {counts[role]} {counts[role] === 1 ? ROLE_LABEL[role].one : ROLE_LABEL[role].many}
                {hidden > 0 ? ` (+${hidden})` : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
