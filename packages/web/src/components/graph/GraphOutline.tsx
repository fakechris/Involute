import { useState } from 'react';

import { openBlockersOf, type GraphEdge, type GraphNode, type Outline, type OutlineItem } from '../../work/graph-model';
import { StatusIcon } from '../StatusIcon';
import { STATE_TYPE_COLOR, STATE_TYPE_LABEL, STATE_TYPE_ORDER } from './graph-colors';

interface GraphOutlineProps {
  outline: Outline;
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  onOpen: (id: string) => void;
  /** New work placed in this project, milestone or epic (INV-744). */
  onCreateIn?: (container: GraphNode) => void;
}

const CREATE_CONTAINERS = new Set(['PROJECT', 'MILESTONE', 'EPIC']);
const FINISHED = new Set(['COMPLETED', 'CANCELED']);

/** The project's CONTAINS tree with per-container progress and blocked markers. */
export function GraphOutline({ outline, edges, byId, onOpen, onCreateIn }: GraphOutlineProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderItems = (items: OutlineItem[], depth: number) =>
    items.map((item) => (
      <OutlineRow
        key={item.node.id}
        item={item}
        depth={depth}
        collapsed={collapsed}
        onToggle={toggle}
        onOpen={onOpen}
        {...(onCreateIn ? { onCreateIn } : {})}
        edges={edges}
        byId={byId}
        renderChildren={renderItems}
      />
    ));

  return (
    <div className="graph-outline" role="tree" aria-label="Project outline">
      {renderItems(outline.roots, 0)}
      {outline.unplaced.length > 0 ? (
        <section className="graph-outline__unplaced" aria-label="Not in the hierarchy">
          <h2>Not in the hierarchy · {outline.unplaced.length}</h2>
          <p className="observation-hint">
            In this project by repository, but no CONTAINS link places it under the project root.
          </p>
          {renderItems(outline.unplaced, 0)}
        </section>
      ) : null}
    </div>
  );
}

interface OutlineRowProps {
  item: OutlineItem;
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onCreateIn?: (container: GraphNode) => void;
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  renderChildren: (items: OutlineItem[], depth: number) => React.ReactNode;
}

function OutlineRow({ item, depth, collapsed, onToggle, onOpen, onCreateIn, edges, byId, renderChildren }: OutlineRowProps) {
  const { node, children } = item;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const blockers = openBlockersOf(node.id, edges, byId);
  const done = item.rollup.COMPLETED ?? 0;

  return (
    <div role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined} aria-label={`${node.identifier} ${node.title}`}>
      <div className="graph-outline__row" style={{ paddingLeft: 8 + depth * 18 }}>
        {hasChildren ? (
          <button
            type="button"
            className="graph-outline__caret"
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.identifier}`}
            onClick={() => onToggle(node.id)}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="graph-outline__caret" aria-hidden="true" />
        )}
        <button type="button" className="graph-outline__open" onClick={() => onOpen(node.id)} aria-label={`Open ${node.identifier}`}>
          <StatusIcon stateName={node.stateName} size={12} />
          <span className="graph-outline__id">{node.identifier}</span>
          {node.kind !== 'ISSUE' ? <span className="graph-outline__kind">{node.kind}</span> : null}
          <span className="graph-outline__title">{node.title}</span>
        </button>
        {blockers.length > 0 ? (
          <span
            className="graph-blocked-badge"
            title={`Blocked by ${blockers.map((blocker) => `${blocker.identifier} ${blocker.title}`).join(', ')}`}
          >
            Blocked{blockers.length > 1 ? ` · ${blockers.length}` : ''}
          </span>
        ) : null}
        {hasChildren ? (
          <span className="graph-outline__progress" aria-label={`${done} of ${item.leafCount} done`}>
            <span className="graph-progress" aria-hidden="true">
              {STATE_TYPE_ORDER.map((type) => {
                const count = item.rollup[type] ?? 0;
                return count > 0 ? (
                  <span
                    key={type}
                    title={`${STATE_TYPE_LABEL[type]}: ${count}`}
                    style={{ flexGrow: count, background: STATE_TYPE_COLOR[type] }}
                  />
                ) : null;
              })}
            </span>
            <span className="graph-outline__count">
              {done}/{item.leafCount}
            </span>
          </span>
        ) : (
          <span className="graph-outline__state">{node.stateName}</span>
        )}
        {onCreateIn && CREATE_CONTAINERS.has(node.kind) && !FINISHED.has(node.stateType) && !node.external ? (
          <button
            type="button"
            className="graph-outline__add"
            aria-label={node.kind === 'PROJECT' ? `New issue in ${node.identifier} (No milestone)` : `New issue in ${node.identifier}`}
            title={node.kind === 'PROJECT' ? 'New issue, No milestone' : `New issue in ${node.identifier}`}
            onClick={() => onCreateIn(node)}
          >
            +
          </button>
        ) : null}
      </div>
      {hasChildren && !isCollapsed ? (
        node.kind === 'PROJECT' ? (
          <ProjectChildren items={children} depth={depth + 1} renderChildren={renderChildren} />
        ) : (
          <div role="group">{renderChildren(children, depth + 1)}</div>
        )
      ) : null}
    </div>
  );
}

/**
 * A project's containers first; issues placed directly under the project
 * (allowed by norm v1, INV-718) are gathered as "No milestone", as in Linear.
 */
function ProjectChildren({
  items,
  depth,
  renderChildren,
}: {
  items: OutlineItem[];
  depth: number;
  renderChildren: (items: OutlineItem[], depth: number) => React.ReactNode;
}) {
  const direct = items.filter((item) => item.node.kind === 'ISSUE');
  const containers = items.filter((item) => item.node.kind !== 'ISSUE');
  return (
    <div role="group">
      {renderChildren(containers, depth)}
      {direct.length > 0 ? (
        <div role="group" aria-label="No milestone">
          <div className="graph-outline__row graph-outline__nomilestone" style={{ paddingLeft: 8 + depth * 18 }}>
            <span className="graph-outline__caret" aria-hidden="true" />
            <span>No milestone · {direct.length}</span>
          </div>
          {renderChildren(direct, depth + 1)}
        </div>
      ) : null}
    </div>
  );
}
