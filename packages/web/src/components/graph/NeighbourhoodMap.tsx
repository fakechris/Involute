import { useId, useMemo, useState, type ReactNode } from 'react';

import type { GraphEdge, GraphNode } from '../../work/graph-model';
import { buildNeighbourhood } from '../../work/neighbourhood-model';
import { useWorkHoverCard } from '../WorkReference';
import { layoutNeighbourhood, type MapEdgeKind, type NeighbourhoodMapCaps, type NeighbourhoodRole, type PlacedNode } from '../../work/neighbourhood-layout';

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

/**
 * What each role is called in the legend (INV-1546): the relation in words,
 * not a colour to decode.
 */
const ROLE_LABEL = {
  ancestor: { one: 'parent chain', many: 'parent chain' },
  blocker: { one: 'blocks this', many: 'block this' },
  dependent: { one: 'blocked by this', many: 'blocked by this' },
  child: { one: 'sub-issue', many: 'sub-issues' },
  sibling: { one: 'same parent', many: 'same parent' },
} as const;

/**
 * A role is told apart by its shape, not only its colour (INV-1546): the
 * parent chain is square, dependencies are diamonds, sub-issues solid dots,
 * peers hollow rings, and the focus the big dot in the middle.
 */
function RoleShape({ role, x, y, r, className }: { role: NeighbourhoodRole; x: number; y: number; r: number; className: string }): ReactNode {
  if (role === 'ancestor') {
    const side = r * 1.7;
    return <rect x={x - side / 2} y={y - side / 2} width={side} height={side} rx={1.5} className={className} />;
  }
  if (role === 'blocker' || role === 'dependent') {
    const d = r * 1.25;
    return <polygon points={`${x},${y - d} ${x + d},${y} ${x},${y + d} ${x - d},${y}`} className={className} />;
  }
  return <circle cx={x} cy={y} r={role === 'sibling' ? r * 0.8 : r} className={className} />;
}

/** The legend's small copy of a shape. */
function LegendShape({ role }: { role: NeighbourhoodRole }) {
  return (
    <svg className="issue-neighbourhood__map-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <RoleShape role={role} x={8} y={8} r={5} className={`issue-neighbourhood__map-dot issue-neighbourhood__map-dot--${role}`} />
    </svg>
  );
}

/** Edge kinds that are real links, drawn with an arrowhead pointing at the target. */
const ARROWED: readonly MapEdgeKind[] = ['hierarchy', 'open', 'violated', 'resolved'];

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
  // Arrowhead markers are ids in the document; two maps on a page must not share them.
  const markerPrefix = useId().replace(/:/g, '');
  // The same work card as a reference in text (INV-1544), not a native tooltip.
  const hover = useWorkHoverCard();

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
        <defs>
          {ARROWED.map((kind) => (
            <marker
              key={kind}
              id={`${markerPrefix}-${kind}`}
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={4.5}
              markerHeight={4.5}
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 Z" className={`issue-neighbourhood__map-arrow issue-neighbourhood__map-arrow--${kind}`} />
            </marker>
          ))}
        </defs>
        <g>
          {layout.edges.map((edge) => {
            const faded = highlightedEdges ? !highlightedEdges.has(edge.id) : false;
            return (
              <g key={edge.id} data-edge-kind={edge.kind} data-edge-from={edge.fromId} data-edge-to={edge.toId}>
                <path
                  d={edge.path}
                  markerEnd={ARROWED.includes(edge.kind) ? `url(#${markerPrefix}-${edge.kind})` : undefined}
                  className={[
                    'issue-neighbourhood__map-edge',
                    `issue-neighbourhood__map-edge--${edge.kind}`,
                    faded ? 'issue-neighbourhood__map-edge--faded' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
                {/* What the link says, on the link (INV-1546). */}
                {edge.label ? (
                  <text
                    x={edge.labelAt.x}
                    y={edge.labelAt.y}
                    textAnchor="middle"
                    className={['issue-neighbourhood__map-edge-label', faded ? 'issue-neighbourhood__map-edge--faded' : ''].filter(Boolean).join(' ')}
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
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
                onMouseEnter={(event) => {
                  setHovered(node.id);
                  hover.anchorProps(node.node.identifier).onMouseEnter(event);
                }}
                onMouseLeave={hover.anchorProps(node.node.identifier).onMouseLeave}
                onFocus={(event) => {
                  setHovered(node.id);
                  hover.anchorProps(node.node.identifier).onFocus(event);
                }}
                onBlur={() => {
                  setHovered(null);
                  hover.hideNow();
                }}
                aria-describedby={hover.describedBy(node.node.identifier)}
                onClick={() => onSelect?.(node.id)}
                onDoubleClick={() => onOpen?.(node.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelect?.(node.id);
                }}
              >
                <RoleShape
                  role={node.role}
                  x={node.x}
                  y={node.y}
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
      {hover.card}

      {showLegend ? (
        <div className="issue-neighbourhood__map-legend-wrap">
          <ul className="issue-neighbourhood__map-legend" aria-label="Neighbourhood key">
            {(['ancestor', 'blocker', 'dependent', 'child', 'sibling'] as const).map((role) => {
              const hidden = layout.hidden[role];
              if (counts[role] === 0 && hidden === 0) return null;
              return (
                <li key={role} className="issue-neighbourhood__map-key" data-role={role}>
                  <LegendShape role={role} />
                  {counts[role]} {counts[role] === 1 ? ROLE_LABEL[role].one : ROLE_LABEL[role].many}
                  {hidden > 0 ? ` (+${hidden} more)` : ''}
                </li>
              );
            })}
          </ul>
          {layout.edges.length > 0 ? (
            <p className="issue-neighbourhood__map-note">A → B: A contains B, or A blocks B. Dashed: same parent.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
