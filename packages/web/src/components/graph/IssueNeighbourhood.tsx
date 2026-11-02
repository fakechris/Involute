import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { ISSUE_GRAPH_QUERY } from '../../work/queries';
import type {
  IssueGraphQueryData,
  IssueGraphQueryVariables,
  WorkGraphNodeRecord,
} from '../../work/types';
import { isOpenBlocker, type GraphEdge, type GraphNode } from '../../work/graph-model';
import { buildNeighbourhood, toRollupLine, type RollupLine } from '../../work/neighbourhood-model';
import { StatusIcon } from '../StatusIcon';
import { Btn } from '../Primitives';
import { InlineError } from '../status';
import { NeighbourhoodMap } from './NeighbourhoodMap';

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

/** The map's drawing space in the drawer, and how many of each role fit. */
const DRAWER_MAP_WIDTH = 360;
const DRAWER_MAP_HEIGHT = 300;
const DRAWER_MAP_CAPS = { ancestor: 3, sibling: 5, child: 4, blocker: 2, dependent: 2 };

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

/** One work item in a list: its state, its number, and its title. */
export function NeighbourhoodRow({
  node,
  blockers,
  blocked,
  onOpen,
}: {
  node: GraphNode;
  /** How many things hold this item up. */
  blockers?: GraphNode[];
  /** Whether this item is waiting on something unfinished. */
  blocked?: boolean;
  onOpen: (id: string) => void;
}) {
  const held = blockers ?? [];
  return (
    <button
      type="button"
      className={`issue-neighbourhood__row${blocked ? ' issue-neighbourhood__row--blocked' : ''}`}
      onClick={() => onOpen(node.id)}
      aria-label={`Open ${node.identifier} ${node.title}`}
    >
      <StatusIcon stateName={node.stateName} stateType={node.stateType} size={11} />
      <span className="mono issue-neighbourhood__id">{node.identifier}</span>
      <span className="issue-neighbourhood__title">{node.title}</span>
      {held.length > 0 ? (
        <span
          className="issue-neighbourhood__chip issue-neighbourhood__chip--blocked"
          title={`Blocked by ${held.map((blocker) => blocker.identifier).join(', ')}`}
        >
          {held.length}
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
  const neighbourhood = useMemo(
    () => (graph ? buildNeighbourhood(nodes, edges, graph.focus.id) : null),
    [edges, graph, nodes],
  );
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

  const { focus, blockers, dependents } = neighbourhood;
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

      <NeighbourhoodMap
        nodes={nodes}
        edges={edges}
        focusId={focus.id}
        width={DRAWER_MAP_WIDTH}
        height={DRAWER_MAP_HEIGHT}
        caps={DRAWER_MAP_CAPS}
        onSelect={onOpen}
      />

      {blockers.length > 0 || dependents.length > 0 ? (
        <>
          {blockers.length > 0 ? (
            <div className="issue-neighbourhood__group">
              <span className="issue-neighbourhood__group-label">
                Blocked by · {blockers.length}
                {openBlockers.length > 0 ? ` · ${openBlockers.length} still open` : ''}
              </span>
              {blockers.map((node) => (
                <NeighbourhoodRow
                  key={node.id}
                  node={node}
                  blocked={isOpenBlocker(node)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ) : null}
          {dependents.length > 0 ? (
            <div className="issue-neighbourhood__group">
              <span className="issue-neighbourhood__group-label">Blocking · {dependents.length}</span>
              {dependents.map((node) => (
                <NeighbourhoodRow key={node.id} node={node} onOpen={onOpen} />
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
