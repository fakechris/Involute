import { useQuery } from '@apollo/client/react';
import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { DependencyGraph, type FocusHops } from '../components/graph/DependencyGraph';
import { openCreateIssueSurface } from '../app/shellStorage';
import { GraphOutline } from '../components/graph/GraphOutline';
import { ProjectTimeline } from '../components/graph/ProjectTimeline';
import { IcoGraph } from '../components/Icons';
import { Checkbox } from '../components/controls';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { Btn } from '../components/Primitives';
import { EmptyState, LoadingState, SegmentedControl } from '../components/status';
import { ProjectFilterCombobox, type AvailableProject } from '../components/ProjectFilterCombobox';
import { buildOutline, type GraphNode } from '../work/graph-model';
import { defaultZoom, type TimelineEntry, type TimelineZoom } from '../work/timeline-model';
import { GRAPH_PROJECTS_QUERY, PROJECT_WORK_GRAPH_QUERY, PROJECT_WORK_GRAPH_TIMELINE_QUERY } from '../work/queries';
import type {
  GraphProjectsQueryData,
  ProjectWorkGraphTimelineQueryData,
  ProjectWorkGraphQueryVariables,
  WorkGraphNodeRecord,
} from '../work/types';

type GraphView = 'outline' | 'dependencies' | 'timeline';

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
  const viewParam = searchParams.get('view');
  const view: GraphView = viewParam === 'dependencies' || viewParam === 'timeline' ? viewParam : 'outline';
  const scaleParam = searchParams.get('scale');
  const chosenScale: TimelineZoom | null =
    scaleParam === 'day' || scaleParam === 'week' || scaleParam === 'month' ? scaleParam : null;
  const focusId = searchParams.get('focus');
  const hops = parseHops(searchParams.get('hops'));
  const rollup = searchParams.get('rollup') === '1';
  const includeCandidates = searchParams.get('candidates') === '1';
  const showOtherLinks = searchParams.get('links') === 'all';
  const teamKey = readStoredTeamKey();

  const projectsQuery = useQuery<GraphProjectsQueryData>(GRAPH_PROJECTS_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
  });
  // The timeline view reads every item's audit trail, so it asks for the graph
  // and the trail in one request instead of resolving the project twice (INV-1445).
  const graphQuery = useQuery<ProjectWorkGraphTimelineQueryData, ProjectWorkGraphQueryVariables>(
    view === 'timeline' ? PROJECT_WORK_GRAPH_TIMELINE_QUERY : PROJECT_WORK_GRAPH_QUERY,
    {
      variables: { project: project ?? '', includeCandidates },
      skip: !project,
    },
  );
  const timeline = useMemo(() => {
    const data = graphQuery.data?.workGraph;
    const entries = new Map<string, TimelineEntry>(
      (data?.timeline ?? []).map((entry) => [
        entry.workId,
        {
          workId: entry.workId,
          committedAt: entry.committedAt ? new Date(entry.committedAt) : null,
          startedAt: entry.startedAt ? new Date(entry.startedAt) : null,
          reviewAt: entry.reviewAt ? new Date(entry.reviewAt) : null,
          completedAt: entry.completedAt ? new Date(entry.completedAt) : null,
          canceledAt: entry.canceledAt ? new Date(entry.canceledAt) : null,
          history: entry.history,
          transitions: entry.transitions.map((transition) => ({ ...transition, at: new Date(transition.at) })),
        },
      ]),
    );
    const cycles = (data?.cycles ?? []).map((cycle) => ({ ...cycle, startsAt: new Date(cycle.startsAt), endsAt: new Date(cycle.endsAt) }));
    return { entries, cycles, loaded: Boolean(graphQuery.data) };
  }, [graphQuery.data]);
  const scale = chosenScale ?? defaultZoom([...timeline.entries.values()], new Date());

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

  const openIssue = useCallback((id: string) => navigate(`/issue/${id}`), [navigate]);
  // New work from a container row lands in it (INV-744); a project row means "No milestone".
  const graphRepository = graph?.repository ?? null;
  const createIn = graphRepository
    ? (container: GraphNode) =>
        openCreateIssueSurface(navigate, '/graph', {
          repository: graphRepository,
          parentId: container.kind === 'PROJECT' ? container.identifier : container.id,
        })
    : null;

  return (
    <div className="observation-page">
      <PageHeader icon={<IcoGraph />} title="Graph" />
      <PageToolbar
        aria-label="Graph controls"
        projects={projects.length > 0 ? (
          <ProjectFilterCombobox
            projects={projects}
            selectedProjectKey={project}
            {...(projectsQuery.data ? { totalCount: projectsQuery.data.projectSummary.totalCount } : {})}
            onSelectProject={(key) => update({ project: key, focus: null })}
            placeholder="Choose a project"
            showQuickPills
          />
        ) : null}
        view={project ? (
          <>
            <SegmentedControl
              semantics="tabs"
              aria-label="Graph view"
              value={view}
              onChange={(next) => update({ view: next === 'outline' ? null : next })}
              options={[
                { value: 'outline', label: 'Outline' },
                { value: 'dependencies', label: `Dependencies${blockCount > 0 ? ` · ${blockCount}` : ''}` },
                { value: 'timeline', label: 'Timeline' },
              ]}
            />
            <Checkbox
              label="Include candidates"
              checked={includeCandidates}
              onChange={(event) => update({ candidates: event.target.checked ? '1' : null })}
            />
          </>
        ) : null}
      />

      <PageBody width="full">
        {!project ? (
          <ProjectChooser
            projects={projects}
            loading={projectsQuery.loading}
            failed={Boolean(projectsQuery.error)}
            onChoose={(key) => update({ project: key })}
          />
        ) : graphQuery.error ? (
          <div role="alert">
            <EmptyState
              title={view === 'timeline' ? 'Could not load the timeline' : "Could not load this project's graph"}
              body={graphQuery.error.message}
              action={<Btn variant="subtle" onClick={() => void graphQuery.refetch()}>Retry</Btn>}
            />
          </div>
        ) : graphQuery.loading && !graph ? (
          <LoadingState>{view === 'timeline' ? 'Loading timeline…' : 'Loading graph…'}</LoadingState>
        ) : graph && nodes.length === 0 ? (
          <EmptyState
            title={`No work in ${project}`}
            body={`Nothing committed resolves to this project${includeCandidates ? ', including candidates' : ''}.`}
          />
        ) : graph ? (
          <>
            {graph.truncated ? (
              <p className="graph-truncated" role="status">
                This project has more work than one view loads; the graph shows the first {nodes.length} items.
              </p>
            ) : null}
            {view === 'outline' ? (
              <GraphOutline
                outline={outline}
                edges={edges}
                byId={byId}
                onOpen={openIssue}
                {...(createIn ? { onCreateIn: createIn } : {})}
              />
            ) : view === 'timeline' ? (
              !timeline.loaded ? (
                <LoadingState>Loading timeline…</LoadingState>
              ) : (
                <ProjectTimeline
                  outline={outline}
                  edges={edges}
                  byId={byId}
                  entries={timeline.entries}
                  cycles={timeline.cycles}
                  zoom={scale}
                  onZoomChange={(value) => update({ scale: value })}
                  onOpen={openIssue}
                />
              )
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
      </PageBody>
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
      <div role="alert">
        <EmptyState title="Could not load projects" />
      </div>
    );
  }
  if (loading && projects.length === 0) return <LoadingState>Loading projects…</LoadingState>;
  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        body="The graph is drawn per project; work declaring a repository forms one."
      />
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
