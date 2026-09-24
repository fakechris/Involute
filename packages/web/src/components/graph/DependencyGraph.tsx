import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  blockNeighbourhood,
  classifyBlockEdge,
  layoutDag,
  LAYOUT,
  milestoneIndex,
  openBlockersOf,
  rollUpToMilestones,
  type BlockEdgeStatus,
  type GraphEdge,
  type GraphNode,
} from '../../work/graph-model';
import { StatusIcon } from '../StatusIcon';
import { milestoneHue, STATE_TYPE_COLOR } from './graph-colors';

export type FocusHops = 1 | 2 | 'all';

interface DependencyGraphProps {
  /** Project nodes plus linked work outside the project. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  rollup: boolean;
  showOtherLinks: boolean;
  focusId: string | null;
  hops: FocusHops;
  onRollupChange: (value: boolean) => void;
  onShowOtherLinksChange: (value: boolean) => void;
  onHopsChange: (value: FocusHops) => void;
  onFocus: (id: string | null) => void;
  onOpen: (id: string) => void;
}

interface DrawnEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: BlockEdgeStatus | 'other';
  label: string | null;
}

const OTHER_LINK_LABEL: Partial<Record<GraphEdge['type'], string>> = {
  RELATED_TO: 'related',
  DUPLICATE_OF: 'duplicate of',
  DERIVED_FROM: 'derived from',
  DISCOVERED_DURING: 'discovered during',
};

const EDGE_LEGEND: Array<{ kind: DrawnEdge['kind']; label: string }> = [
  { kind: 'open', label: 'Waiting on an open blocker' },
  { kind: 'violated', label: 'Started before its blocker closed' },
  { kind: 'resolved', label: 'Blocker done' },
  { kind: 'other', label: 'Related / duplicate / derived' },
];

/**
 * Read-only BLOCKS graph for one project (INV-681): layered left to right so a
 * chain reads as upstream → downstream. Clicking a node focuses its
 * neighbourhood; the side panel opens the issue.
 */
export function DependencyGraph({
  nodes,
  edges,
  rollup,
  showOtherLinks,
  focusId,
  hops,
  onRollupChange,
  onShowOtherLinksChange,
  onHopsChange,
  onFocus,
  onOpen,
}: DependencyGraphProps) {
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const milestones = useMemo(() => milestoneIndex(nodes, edges), [nodes, edges]);

  const view = useMemo(() => {
    if (rollup) {
      const lifted = rollUpToMilestones(nodes, edges);
      return {
        nodes: lifted.nodes,
        edges: lifted.edges.map<DrawnEdge>((edge) => ({
          id: edge.id,
          fromId: edge.fromId,
          toId: edge.toId,
          kind: edge.status,
          label: edge.count > 1 ? `×${edge.count}` : null,
        })),
      };
    }
    const drawn: DrawnEdge[] = [];
    for (const edge of edges) {
      const from = byId.get(edge.fromId);
      const to = byId.get(edge.toId);
      if (!from || !to) continue;
      if (edge.type === 'BLOCKS') {
        drawn.push({ id: edge.id, fromId: edge.fromId, toId: edge.toId, kind: classifyBlockEdge(from, to), label: null });
      } else if (showOtherLinks && OTHER_LINK_LABEL[edge.type]) {
        drawn.push({ id: edge.id, fromId: edge.fromId, toId: edge.toId, kind: 'other', label: OTHER_LINK_LABEL[edge.type]! });
      }
    }
    const used = new Set(drawn.flatMap((edge) => [edge.fromId, edge.toId]));
    return { nodes: nodes.filter((node) => used.has(node.id)), edges: drawn };
  }, [byId, edges, nodes, rollup, showOtherLinks]);

  // Only BLOCKS shapes the columns; other links are drawn over the result.
  const layout = useMemo(
    () => layoutDag(view.nodes.map((node) => node.id), view.edges.filter((edge) => edge.kind !== 'other')),
    [view],
  );

  // Start fitted to the available width (never enlarged, never below 50%),
  // and refit whenever the drawn set changes shape.
  const fitZoom = () => {
    const available = viewportRef.current?.clientWidth ?? 0;
    if (!available || !layout.width) return 1;
    // Below ~80% the labels stop being readable; scroll instead.
    return Math.max(0.8, Math.min(1, (available - 2) / layout.width));
  };
  useLayoutEffect(() => {
    setZoom(fitZoom());
  }, [layout.width]);

  const activeFocus = focusId && layout.nodes.has(focusId) ? focusId : null;

  // Keep the focused node on screen, including when the focus panel narrows the viewport.
  useEffect(() => {
    if (!activeFocus) return;
    const element = viewportRef.current?.querySelector<HTMLElement>(`[data-node-id="${activeFocus}"]`);
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeFocus, zoom]);
  const highlighted = useMemo(() => {
    if (!activeFocus) return null;
    const blockEdges = rollup
      ? view.edges.map((edge) => ({ id: edge.id, type: 'BLOCKS' as const, fromId: edge.fromId, toId: edge.toId }))
      : edges;
    return blockNeighbourhood(activeFocus, blockEdges, hops === 'all' ? Infinity : hops);
  }, [activeFocus, edges, hops, rollup, view.edges]);

  const options = (
    <div className="graph-options">
      <label>
        <input type="checkbox" checked={rollup} onChange={(event) => onRollupChange(event.target.checked)} />
        Milestones only
      </label>
      <label>
        <input
          type="checkbox"
          checked={showOtherLinks}
          disabled={rollup}
          onChange={(event) => onShowOtherLinksChange(event.target.checked)}
        />
        Related / duplicate links
      </label>
      <label>
        Focus depth
        <select
          aria-label="Focus depth"
          value={String(hops)}
          onChange={(event) => onHopsChange(event.target.value === 'all' ? 'all' : event.target.value === '1' ? 1 : 2)}
        >
          <option value="1">1 step</option>
          <option value="2">2 steps</option>
          <option value="all">Whole chain</option>
        </select>
      </label>
    </div>
  );

  if (view.nodes.length === 0) {
    return (
      <div className="dependency-graph">
        <div className="dependency-graph__toolbar">{options}</div>
        <div className="empty-state">
          <h3>No dependencies in this project</h3>
          <p>No BLOCKS links touch its work{showOtherLinks ? ', and no other typed links either' : ''}.</p>
        </div>
      </div>
    );
  }

  const focusNode = activeFocus ? byId.get(activeFocus) ?? null : null;

  return (
    <div className="dependency-graph">
      <div className="dependency-graph__toolbar">
        {options}
        <div className="dependency-graph__legend" aria-label="Edge legend">
          {EDGE_LEGEND.filter((entry) => entry.kind !== 'other' || (showOtherLinks && !rollup)).map((entry) => (
            <span key={entry.kind} className="dependency-graph__legend-item">
              <svg width="26" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="25" y2="4" className={`dependency-edge dependency-edge--${entry.kind}`} />
              </svg>
              {entry.label}
            </span>
          ))}
        </div>
        <div className="dependency-graph__zoom">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.4, value - 0.1))}>−</button>
          <span className="mono">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}>+</button>
          <button type="button" onClick={() => setZoom(fitZoom())}>Fit</button>
          <button type="button" onClick={() => setZoom(1)}>100%</button>
        </div>
      </div>

      <div className="dependency-graph__body">
        <div className="dependency-graph__viewport" role="region" aria-label="Dependency graph" ref={viewportRef}>
          <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div
              className="dependency-graph__canvas"
              style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
            >
              <svg width={layout.width} height={layout.height} className="dependency-graph__edges" aria-hidden="true">
                <defs>
                  {(['open', 'violated', 'resolved', 'other'] as const).map((kind) => (
                    <marker
                      key={kind}
                      id={`dep-arrow-${kind}`}
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,0 L8,4 L0,8 z" className={`dependency-arrow dependency-arrow--${kind}`} />
                    </marker>
                  ))}
                </defs>
                {view.edges.map((edge) => {
                  const from = layout.nodes.get(edge.fromId);
                  const to = layout.nodes.get(edge.toId);
                  if (!from || !to) return null;
                  const x1 = from.x + LAYOUT.nodeWidth;
                  const y1 = from.y + LAYOUT.nodeHeight / 2;
                  const x2 = to.x;
                  const y2 = to.y + LAYOUT.nodeHeight / 2;
                  // Same-column links (other types) bow out to the right.
                  const bend = x2 > x1 ? (x2 - x1) / 2 : LAYOUT.columnGap;
                  const path =
                    x2 > x1
                      ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
                      : `M${x1},${y1} C${x1 + bend},${y1} ${x1 + bend},${y2} ${x1},${y2}`;
                  const dimmed = highlighted && !(highlighted.has(edge.fromId) && highlighted.has(edge.toId));
                  return (
                    <g key={edge.id} className={dimmed ? 'dependency-graph__dimmed' : undefined} data-edge-kind={edge.kind}>
                      <path
                        d={path}
                        className={`dependency-edge dependency-edge--${edge.kind}`}
                        markerEnd={`url(#dep-arrow-${edge.kind})`}
                      />
                      {edge.label ? (
                        <text x={(x1 + (x2 > x1 ? x2 : x1 + bend)) / 2} y={(y1 + y2) / 2 - 4} className="dependency-edge__label">
                          {edge.label}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>

              {view.nodes.map((node) => {
                const position = layout.nodes.get(node.id);
                if (!position) return null;
                const milestone = rollup ? null : milestones.get(node.id) ?? null;
                const blockers = rollup ? [] : openBlockersOf(node.id, edges, byId);
                const dimmed = highlighted && !highlighted.has(node.id);
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-node-id={node.id}
                    className={[
                      'dependency-node',
                      node.external ? 'dependency-node--external' : '',
                      node.id === activeFocus ? 'dependency-node--focused' : '',
                      dimmed ? 'dependency-graph__dimmed' : '',
                    ].filter(Boolean).join(' ')}
                    style={{
                      left: position.x,
                      top: position.y,
                      width: LAYOUT.nodeWidth,
                      height: LAYOUT.nodeHeight,
                      borderLeftColor: milestone ? `hsl(${milestoneHue(milestone.id)} 60% 55%)` : undefined,
                    }}
                    aria-pressed={node.id === activeFocus}
                    aria-label={`Focus ${node.identifier} ${node.title}`}
                    title={`${node.identifier} ${node.title}\n${node.stateName}${milestone && milestone.id !== node.id ? ` · ${milestone.identifier} ${milestone.title}` : ''}${node.external ? '\nOutside this project' : ''}`}
                    onClick={() => onFocus(node.id === activeFocus ? null : node.id)}
                    onDoubleClick={() => onOpen(node.id)}
                  >
                    <span className="dependency-node__head">
                      <StatusIcon stateName={node.stateName} size={11} />
                      <span className="dependency-node__id">{node.identifier}</span>
                      {node.kind !== 'ISSUE' ? <span className="dependency-node__kind">{node.kind}</span> : null}
                      {blockers.length > 0 ? <span className="dependency-node__blocked">{blockers.length} open</span> : null}
                    </span>
                    <span className="dependency-node__title">{node.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {focusNode ? (
          <FocusPanel
            node={focusNode}
            edges={edges}
            byId={byId}
            milestone={milestones.get(focusNode.id) ?? null}
            onOpen={onOpen}
            onFocus={onFocus}
          />
        ) : null}
      </div>
    </div>
  );
}

interface FocusPanelProps {
  node: GraphNode;
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  milestone: GraphNode | null;
  onOpen: (id: string) => void;
  onFocus: (id: string | null) => void;
}

function FocusPanel({ node, edges, byId, milestone, onOpen, onFocus }: FocusPanelProps) {
  const upstream = edges.filter((edge) => edge.type === 'BLOCKS' && edge.toId === node.id).map((edge) => byId.get(edge.fromId));
  const downstream = edges.filter((edge) => edge.type === 'BLOCKS' && edge.fromId === node.id).map((edge) => byId.get(edge.toId));
  const list = (label: string, items: Array<GraphNode | undefined>) => (
    <div className="dependency-focus__group">
      <span className="issue-panel__label">{label} · {items.filter(Boolean).length}</span>
      {items.filter((item): item is GraphNode => Boolean(item)).map((item) => (
        <button key={item.id} type="button" className="dependency-focus__link" onClick={() => onFocus(item.id)}>
          <span className="dependency-dot" style={{ background: STATE_TYPE_COLOR[item.stateType] }} aria-hidden="true" />
          <span className="mono">{item.identifier}</span>
          <span className="dependency-focus__title">{item.title}</span>
        </button>
      ))}
    </div>
  );

  return (
    <aside className="dependency-focus" aria-label={`Focused ${node.identifier}`}>
      <div className="dependency-focus__header">
        <span className="mono">{node.identifier}</span>
        <button type="button" aria-label="Clear focus" onClick={() => onFocus(null)}>×</button>
      </div>
      <h3>{node.title}</h3>
      <p className="observation-hint">
        {node.stateName}
        {node.assigneeName ? ` · ${node.assigneeName}` : ''}
        {milestone && milestone.id !== node.id ? ` · ${milestone.identifier} ${milestone.title}` : ''}
        {node.external ? ' · outside this project' : ''}
      </p>
      {list('Blocked by', upstream)}
      {list('Blocking', downstream)}
      <button type="button" className="ui-action" onClick={() => onOpen(node.id)}>
        Open issue
      </button>
    </aside>
  );
}
