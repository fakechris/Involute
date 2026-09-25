import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { DependencyGraph, type FocusHops } from '../components/graph/DependencyGraph';
import { GraphOutline } from '../components/graph/GraphOutline';
import { IcoGraph } from '../components/Icons';
import { ProjectFilterCombobox, type AvailableProject } from '../components/ProjectFilterCombobox';
import { buildOutline, type GraphNode } from '../work/graph-model';
import { GRAPH_PROJECTS_QUERY, PROJECT_WORK_GRAPH_QUERY } from '../work/queries';
import type {
  GraphProjectsQueryData,
  ProjectWorkGraphQueryData,
  ProjectWorkGraphQueryVariables,
  WorkGraphNodeRecord,
} from '../work/types';

type GraphView = 'outline' | 'dependencies';

function toGraphNode(record: WorkGraphNodeRecord, external: boolean): GraphNode {
  return {
    id: record.id,
    identifier: record.identifier,
    title: record.title,
    kind: record.kind,
    commitmentStatus: record.commitmentStatus,
    stateName: record.state.name,
    stateType: record.state.type,
    assigneeName: record.assignee?.name ?? null,
    external,
  };
}

function parseHops(value: string | null): FocusHops {
  return value === '1' ? 1 : value === 'all' ? 'all' : 2;
}

/**
 * One project's work graph (INV-681). The URL carries every choice —
 * project, view, focus, hops, roll-up, candidates, other links — so a view
 * can be shared or reloaded as-is.
 */
export function GraphPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = searchParams.get('project');
  const view: GraphView = searchParams.get('view') === 'dependencies' ? 'dependencies' : 'outline';
  const focusId = searchParams.get('focus');
  const hops = parseHops(searchParams.get('hops'));
  const rollup = searchParams.get('rollup') === '1';
  const includeCandidates = searchParams.get('candidates') === '1';
  const showOtherLinks = searchParams.get('links') === 'all';
  const teamKey = readStoredTeamKey();

  const projectsQuery = useQuery<GraphProjectsQueryData>(GRAPH_PROJECTS_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
  });
  const graphQuery = useQuery<ProjectWorkGraphQueryData, ProjectWorkGraphQueryVariables>(PROJECT_WORK_GRAPH_QUERY, {
    variables: { project: project ?? '', includeCandidates },
    skip: !project,
  });

  const projects = useMemo<AvailableProject[]>(
    () =>
      (projectsQuery.data?.projectSummary.projects ?? []).map((item) => ({
        id: item.identifier ?? item.repository,
        identifier: item.identifier ?? item.repository,
        name: item.repository,
        title: item.name || item.repository,
        key: item.repository,
        issueCount: item.totalCount,
      })),
    [projectsQuery.data],
  );

  const graph = graphQuery.data?.workGraph ?? null;
  const { nodes, allNodes, byId } = useMemo(() => {
    const inScope = (graph?.nodes ?? []).map((record) => toGraphNode(record, false));
    const outside = (graph?.externalNodes ?? []).map((record) => toGraphNode(record, true));
    const all = [...inScope, ...outside];
    return { nodes: inScope, allNodes: all, byId: new Map(all.map((node) => [node.id, node])) };
  }, [graph]);
  const edges = useMemo(() => graph?.edges ?? [], [graph]);
  const outline = useMemo(() => buildOutline(nodes, edges, graph?.root?.id ?? null), [edges, graph?.root?.id, nodes]);
  const blockCount = edges.filter((edge) => edge.type === 'BLOCKS').length;

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

  const openIssue = (id: string) => navigate(`/issue/${id}`);

  return (
    <div className="observation-page">
      <div className="page-header" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}>
          <IcoGraph />
        </span>
        <h1 className="page-header__title">Graph</h1>
        {projects.length > 0 ? (
          <ProjectFilterCombobox
            projects={projects}
            selectedProjectKey={project}
            {...(projectsQuery.data ? { totalCount: projectsQuery.data.projectSummary.totalCount } : {})}
            onSelectProject={(key) => update({ project: key, focus: null })}
            placeholder="Choose a project"
          />
        ) : null}
        {project ? (
          <div className="graph-tabs" role="tablist" aria-label="Graph view">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'outline'}
              onClick={() => update({ view: null })}
            >
              Outline
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'dependencies'}
              onClick={() => update({ view: 'dependencies' })}
            >
              Dependencies{blockCount > 0 ? ` · ${blockCount}` : ''}
            </button>
          </div>
        ) : null}
        <div style={{ flex: 1 }} />
        {project ? (
          <div className="graph-options">
            <label>
              <input
                type="checkbox"
                checked={includeCandidates}
                onChange={(event) => update({ candidates: event.target.checked ? '1' : null })}
              />
              Include candidates
            </label>
          </div>
        ) : null}
      </div>

      <div className="page-content observation-content">
        {!project ? (
          <ProjectChooser
            projects={projects}
            loading={projectsQuery.loading}
            failed={Boolean(projectsQuery.error)}
            onChoose={(key) => update({ project: key })}
          />
        ) : graphQuery.error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load this project's graph</h3>
            <p>{graphQuery.error.message}</p>
            <button type="button" onClick={() => void graphQuery.refetch()}>Retry</button>
          </div>
        ) : graphQuery.loading && !graph ? (
          <p className="observation-empty" role="status">Loading graph…</p>
        ) : graph && nodes.length === 0 ? (
          <div className="empty-state" role="status">
            <h3>No work in {project}</h3>
            <p>Nothing committed resolves to this project{includeCandidates ? ', including candidates' : ''}.</p>
          </div>
        ) : graph ? (
          <>
            {graph.truncated ? (
              <p className="graph-truncated" role="status">
                This project has more work than one view loads; the graph shows the first {nodes.length} items.
              </p>
            ) : null}
            {view === 'outline' ? (
              <GraphOutline outline={outline} edges={edges} byId={byId} onOpen={openIssue} />
            ) : (
              <DependencyGraph
                nodes={allNodes}
                edges={edges}
                rollup={rollup}
                showOtherLinks={showOtherLinks}
                focusId={focusId}
                hops={hops}
                onRollupChange={(value) => update({ rollup: value ? '1' : null, focus: null })}
                onShowOtherLinksChange={(value) => update({ links: value ? 'all' : null })}
                onHopsChange={(value) => update({ hops: value === 2 ? null : String(value) })}
                onFocus={(id) => update({ focus: id })}
                onOpen={openIssue}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ProjectChooser({
  projects,
  loading,
  failed,
  onChoose,
}: {
  projects: AvailableProject[];
  loading: boolean;
  failed: boolean;
  onChoose: (key: string) => void;
}) {
  if (failed) {
    return (
      <div className="empty-state" role="alert">
        <h3>Could not load projects</h3>
      </div>
    );
  }
  if (loading && projects.length === 0) return <p className="observation-empty">Loading projects…</p>;
  if (projects.length === 0) {
    return (
      <div className="empty-state">
        <h3>No projects yet</h3>
        <p>The graph is drawn per project; work declaring a repository forms one.</p>
      </div>
    );
  }
  return (
    <div className="graph-chooser">
      <p className="observation-hint">Choose a project to see its structure and dependencies.</p>
      <ul>
        {projects.map((item) => (
          <li key={item.key}>
            <button type="button" onClick={() => onChoose(item.key)}>
              <span>{item.name}</span>
              <span className="mono observation-count">{item.issueCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
