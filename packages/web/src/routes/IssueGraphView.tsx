import { useQuery } from '@apollo/client/react';
import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { DependencyGraph, type FocusHops } from '../components/graph/DependencyGraph';
import { RollupCard } from '../components/graph/IssueNeighbourhood';
import { NeighbourhoodMap } from '../components/graph/NeighbourhoodMap';
import { IcoGraph } from '../components/Icons';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { Btn } from '../components/Primitives';
import { EmptyState, LoadingState, SegmentedControl } from '../components/status';
import { type GraphEdge, type GraphNode } from '../work/graph-model';
import { buildNeighbourhood, toRollupLine } from '../work/neighbourhood-model';
import { ISSUE_GRAPH_QUERY } from '../work/queries';
import type {
  IssueGraphQueryData,
  IssueGraphQueryVariables,
  WorkGraphNodeRecord,
} from '../work/types';

/**
 * One item's neighbourhood as a page (INV-1496) — the escape hatch from the
 * small graph in the issue drawer.
 *
 * The drawer shows enough to orient a reader: where the item sits, how its
 * milestone is going, what it waits on. A page has room for the whole canvas,
 * so this is where the dependency graph is drawn as a graph — the same
 * layered drawing the project graph uses, read from one item instead of from
 * a whole project.
 *
 * Clicking a node moves the lens: the URL names the new focus, the server
 * reads that item's neighbourhood, and the page redraws around it. The URL
 * carries the choice, so a reader can send someone the exact view they are
 * looking at.
 */

type IssueGraphView = 'placement' | 'dependencies';

/** The map's drawing space on the page, and how many of each role fit. */
const PAGE_MAP_WIDTH = 760;
const PAGE_MAP_HEIGHT = 520;
const PAGE_MAP_CAPS = { ancestor: 5, sibling: 10, child: 8, blocker: 4, dependent: 4 };

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

function parseHops(value: string | null): FocusHops {
  return value === '1' ? 1 : value === 'all' ? 'all' : 2;
}

export function IssueGraphViewPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = searchParams.get('focus') ?? '';
  const viewParam = searchParams.get('view');
  const view: IssueGraphView = viewParam === 'dependencies' ? 'dependencies' : 'placement';
  const hops = parseHops(searchParams.get('hops'));
  const showOtherLinks = searchParams.get('links') === 'all';
  const rollup = searchParams.get('rollup') === '1';

  const depth = hops === 'all' ? 4 : hops;
  const { data, loading, error, refetch } = useQuery<IssueGraphQueryData, IssueGraphQueryVariables>(
    ISSUE_GRAPH_QUERY,
    {
      variables: { id: focus, depth },
      skip: !focus,
      fetchPolicy: 'cache-and-network',
    },
  );

  const graph = data?.issueGraph ?? null;
  const nodes = useMemo(() => (graph?.nodes ?? []).map(toGraphNode), [graph?.nodes]);
  const edges = useMemo<GraphEdge[]>(() => (graph?.edges ?? []).map((edge) => ({ ...edge })), [graph?.edges]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighbourhood = useMemo(
    () => (graph ? buildNeighbourhood(nodes, edges, graph.focus.id) : null),
    [edges, graph, nodes],
  );
  const rollups = useMemo(() => (graph?.rollups ?? []).map(toRollupLine), [graph?.rollups]);

  function update(changes: Record<string, string | null>) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: false },
    );
  }

  const openIssue = useCallback((id: string) => navigate(`/issue/${id}`), [navigate]);

  if (!focus) {
    return (
      <div className="observation-page">
        <PageHeader icon={<IcoGraph />} title="Graph" />
        <PageBody width="full">
          <EmptyState
            title="No item named"
            body="Open an item's neighbourhood by following its “Open full graph” link."
          />
        </PageBody>
      </div>
    );
  }

  return (
    <div className="observation-page">
      <PageHeader icon={<IcoGraph />} title={graph ? `${graph.focus.identifier} · Neighbourhood` : 'Graph'} />
      <PageToolbar
        aria-label="Neighbourhood controls"
        view={
          <SegmentedControl
            semantics="tabs"
            aria-label="Neighbourhood view"
            value={view}
            onChange={(next) => update({ view: next === 'placement' ? null : next })}
            options={[
              { value: 'placement', label: 'Placement' },
              { value: 'dependencies', label: 'Dependencies' },
            ]}
          />
        }
      />

      <PageBody width="full">
        {error && !graph ? (
          <div role="alert">
            <EmptyState
              title="Could not load this item's neighbourhood"
              body={error.message}
              action={
                <Btn variant="subtle" onClick={() => void refetch()}>
                  Retry
                </Btn>
              }
            />
          </div>
        ) : loading && !graph ? (
          <LoadingState>Loading the neighbourhood…</LoadingState>
        ) : graph && neighbourhood ? (
          <>
            {rollups.length > 0 ? (
              <div className="issue-neighbourhood__rollups issue-neighbourhood__rollups--page">
                {rollups.map((rollup) => (
                  <RollupCard key={rollup.id} rollup={rollup} />
                ))}
              </div>
            ) : null}

            {view === 'placement' ? (
              <NeighbourhoodMap
                nodes={nodes}
                edges={edges}
                focusId={graph.focus.id}
                width={PAGE_MAP_WIDTH}
                height={PAGE_MAP_HEIGHT}
                caps={PAGE_MAP_CAPS}
                onSelect={(id) => {
                  // Picking a node moves the lens: the neighbourhood is read
                  // again around that item, so the URL always names what the
                  // reader is looking at.
                  const node = byId.get(id);
                  if (node) update({ focus: node.identifier });
                }}
                onOpen={openIssue}
              />
            ) : (
              <DependencyGraph
                nodes={nodes}
                edges={edges}
                rollup={rollup}
                showOtherLinks={showOtherLinks}
                focusId={graph.focus.id}
                hops={hops}
                onRollupChange={(value) => update({ rollup: value ? '1' : null })}
                onShowOtherLinksChange={(value) => update({ links: value ? 'all' : null })}
                onHopsChange={(value) => update({ hops: value === 2 ? null : String(value) })}
                onFocus={(id) => {
                  // Clicking a node moves the lens: the neighbourhood is read
                  // again around that item, so the URL always names what the
                  // reader is looking at.
                  const node = id ? byId.get(id) : null;
                  if (node) update({ focus: node.identifier });
                }}
                onOpen={openIssue}
              />
            )}

            {graph.truncated ? (
              <p className="graph-truncated" role="status">
                This neighbourhood has more items than one read shows.
              </p>
            ) : null}
          </>
        ) : null}
      </PageBody>
    </div>
  );
}
