import { useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ISSUE_GRAPH_QUERY } from '../../work/queries';
import type {
  IssueGraphQueryData,
  IssueGraphQueryVariables,
  WorkGraphNodeRecord,
} from '../../work/types';
import {
  buildBlockerIndex,
  isOpenBlocker,
  type GraphEdge,
  type GraphNode,
} from '../../work/graph-model';
import { buildNeighbourhood, toRollupLine, type RollupLine } from '../../work/neighbourhood-model';
import { StatusIcon } from '../StatusIcon';
import { Btn } from '../Primitives';
import { InlineError } from '../status';

/**
 * One item's neighbourhood, drawn small enough to live in the issue drawer
 * (INV-1496).
 *
 * A work item is never alone: it sits under a milestone or epic, it has
 * peers under the same parent, and it waits on things that are not finished.
 * None of that is visible on an item page — only the item itself is.
 *
 * Involute already has the typed work graph underneath (CONTAINS, BLOCKS, no
 * cycles). This puts the part of it a reader needs *with the item open* on
 * the screen:
 *
 * - **Where am I** — the chain of ancestors above the item, so the milestone
 *   it belongs to is visible without leaving the page.
 * - **How is it going** — the rollup of the nearest milestone and epic: how
 *   many are done, how many are in flight, how many are stuck.
 * - **Who are my peers** — the siblings under the same parent, and the
 *   sub-issues under this one.
 * - **What am I waiting on** — the blockers, with the open ones first.
 *
 * Every row is a link: clicking one opens that item, and the drawer then
 * shows *its* neighbourhood. The full canvas — the same graph the /graph page
 * draws — is one click away through "Open full graph".
 */

interface IssueNeighbourhoodProps {
  /** The open item. */
  issueId: string;
  /** Used for the "open full graph" link, which addresses items by identifier. */
  issueIdentifier: string;
  /** Opens another item; the caller swaps the open item. */
  onOpen: (issueId: string) => void;
}

/** How many rungs of the ladder the stylesheet draws; deeper ones stay flat. */
const MAX_DEPTH = 7;

/**
 * One ancestor's progress. The counts stay apart rather than collapsing into
 * a single percentage: "3 of 8 done" and "2 in flight" answer different
 * questions, and a reader deciding whether to lend a hand wants both.
 */
export function RollupCard({ rollup }: { rollup: RollupLine }) {
  return (
    <div className="issue-neighbourhood__rollup">
      <div className="issue-neighbourhood__rollup-head">
        <span className="mono issue-neighbourhood__rollup-id">{rollup.identifier}</span>
        <span className="issue-neighbourhood__rollup-title">{rollup.title}</span>
      </div>
      <progress
        className="issue-neighbourhood__bar"
        value={rollup.completed}
        max={Math.max(rollup.total, 1)}
        aria-label={`${rollup.label} (${Math.round(rollup.ratio * 100)}%)`}
      />
      <div className="issue-neighbourhood__rollup-meta">
        <span>{rollup.label}</span>
        {rollup.inProgress > 0 ? (
          <span className="issue-neighbourhood__chip issue-neighbourhood__chip--progress">
            {rollup.inProgress} in flight
          </span>
        ) : null}
        {rollup.blocked > 0 ? (
          <span className="issue-neighbourhood__chip issue-neighbourhood__chip--blocked">
            {rollup.blocked} stuck
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One rung of the ladder: a work item, its state, and how many things hold it up. */
export function NeighbourhoodRow({
  node,
  depth,
  isFocus,
  blockers,
  onOpen,
}: {
  node: GraphNode;
  depth: number;
  isFocus: boolean;
  blockers: GraphNode[];
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`issue-neighbourhood__row${isFocus ? ' issue-neighbourhood__row--focus' : ''}`}
      data-depth={Math.min(depth, MAX_DEPTH)}
      onClick={() => onOpen(node.id)}
      aria-label={`Open ${node.identifier} ${node.title}`}
    >
      <StatusIcon stateName={node.stateName} size={11} />
      <span className="mono issue-neighbourhood__id">{node.identifier}</span>
      <span className="issue-neighbourhood__title">{node.title}</span>
      {blockers.length > 0 ? (
        <span
          className="issue-neighbourhood__chip issue-neighbourhood__chip--blocked"
          title={`Blocked by ${blockers.map((blocker) => blocker.identifier).join(', ')}`}
        >
          {blockers.length}
        </span>
      ) : null}
    </button>
  );
}

function toGraphNode(record: WorkGraphNodeRecord): GraphNode {
  return {
    id: record.id,
    identifier: record.identifier,
    title: record.title,
    kind: record.kind,
    commitmentStatus: record.commitmentStatus,
    stateName: record.state.name,
    stateType: record.state.type,
    assigneeName: record.assignee?.name ?? null,
    external: false,
  };
}

export function IssueNeighbourhood({ issueId, issueIdentifier, onOpen }: IssueNeighbourhoodProps) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const { data, loading, error } = useQuery<IssueGraphQueryData, IssueGraphQueryVariables>(ISSUE_GRAPH_QUERY, {
    variables: { id: issueId, depth: 1 },
    // The neighbourhood changes as the item's relations change; a stale
    // picture of who is blocking whom is worse than no picture.
    fetchPolicy: 'cache-and-network',
  });

  const graph = data?.issueGraph ?? null;
  const nodes = useMemo(() => (graph?.nodes ?? []).map(toGraphNode), [graph?.nodes]);
  const edges = useMemo<GraphEdge[]>(
    () => (graph?.edges ?? []).map((edge) => ({ ...edge })),
    [graph?.edges],
  );
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbourhood = useMemo(
    () => (graph ? buildNeighbourhood(nodes, edges, graph.focus.id) : null),
    [edges, graph, nodes],
  );
  const blockersByNode = useMemo(() => buildBlockerIndex(edges, byId), [edges, byId]);
  const rollups = useMemo(() => (graph?.rollups ?? []).map(toRollupLine), [graph?.rollups]);

  if (error && !graph) {
    return (
      <div className="issue-panel__section issue-neighbourhood">
        <InlineError>Could not load the neighbourhood of this item.</InlineError>
      </div>
    );
  }

  if (loading && !graph) {
    return (
      <div className="issue-panel__section issue-neighbourhood">
        <span className="issue-panel__label">Neighbourhood</span>
        <p className="issue-panel__empty-hint">Loading the neighbourhood…</p>
      </div>
    );
  }

  if (!graph || !neighbourhood) {
    return (
      <div className="issue-panel__section issue-neighbourhood">
        <span className="issue-panel__label">Neighbourhood</span>
        <p className="issue-panel__empty-hint">Nothing around this item yet.</p>
      </div>
    );
  }

  const { focus, ancestors, siblings, children, blockers, dependents } = neighbourhood;
  const spine: Array<{ node: GraphNode; depth: number; isFocus: boolean }> = [];
  ancestors.forEach((node, index) => spine.push({ node, depth: index, isFocus: false }));
  // The siblings sit beside the focus, on the same rung of the ladder.
  for (const sibling of siblings) spine.push({ node: sibling, depth: ancestors.length, isFocus: false });
  spine.push({ node: focus, depth: ancestors.length, isFocus: true });
  for (const child of children) spine.push({ node: child, depth: ancestors.length + 1, isFocus: false });

  const openBlockers = blockers.filter((node) => isOpenBlocker(node));

  return (
    <div className="issue-panel__section issue-neighbourhood" aria-label="Neighbourhood">
      <div className="issue-neighbourhood__header">
        <span className="issue-panel__label">Neighbourhood</span>
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/graph?scope=issue&focus=${encodeURIComponent(issueIdentifier)}`)}
        >
          Open full graph
        </Btn>
      </div>

      {rollups.length > 0 ? (
        <div className="issue-neighbourhood__rollups">
          {rollups.map((rollup) => (
            <RollupCard key={rollup.id} rollup={rollup} />
          ))}
        </div>
      ) : null}

      <button
        type="button"
        className="issue-neighbourhood__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? '▾' : '▸'} Placement
      </button>

      {expanded ? (
        <div className="issue-neighbourhood__spine" role="list">
          {spine.map((row) => (
            <NeighbourhoodRow
              key={row.node.id}
              node={row.node}
              depth={row.depth}
              isFocus={row.isFocus}
              blockers={blockersByNode.get(row.node.id) ?? []}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}

      {blockers.length > 0 || dependents.length > 0 ? (
        <>
          {blockers.length > 0 ? (
            <div className="issue-neighbourhood__group">
              <span className="issue-neighbourhood__group-label">
                Blocked by · {blockers.length}
                {openBlockers.length > 0 ? ` · ${openBlockers.length} still open` : ''}
              </span>
              {blockers.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`issue-neighbourhood__row${isOpenBlocker(node) ? ' issue-neighbourhood__row--blocked' : ''}`}
                  onClick={() => onOpen(node.id)}
                  aria-label={`Open ${node.identifier} ${node.title}`}
                >
                  <StatusIcon stateName={node.stateName} size={11} />
                  <span className="mono issue-neighbourhood__id">{node.identifier}</span>
                  <span className="issue-neighbourhood__title">{node.title}</span>
                </button>
              ))}
            </div>
          ) : null}
          {dependents.length > 0 ? (
            <div className="issue-neighbourhood__group">
              <span className="issue-neighbourhood__group-label">Blocking · {dependents.length}</span>
              {dependents.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="issue-neighbourhood__row"
                  onClick={() => onOpen(node.id)}
                  aria-label={`Open ${node.identifier} ${node.title}`}
                >
                  <StatusIcon stateName={node.stateName} size={11} />
                  <span className="mono issue-neighbourhood__id">{node.identifier}</span>
                  <span className="issue-neighbourhood__title">{node.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {graph.truncated ? (
        <p className="issue-panel__empty-hint">This neighbourhood is larger than one read shows.</p>
      ) : null}
    </div>
  );
}
