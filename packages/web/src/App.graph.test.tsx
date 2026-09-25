import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { GraphProjectsQueryData, ProjectWorkGraphQueryData, WorkGraphNodeRecord } from './work/types';

const states = {
  ready: { id: 's-ready', name: 'Ready', type: 'UNSTARTED' as const },
  progress: { id: 's-progress', name: 'In Progress', type: 'STARTED' as const },
  done: { id: 's-done', name: 'Done', type: 'COMPLETED' as const },
};

function record(id: string, title: string, state: WorkGraphNodeRecord['state'], kind: WorkGraphNodeRecord['kind'] = 'ISSUE'): WorkGraphNodeRecord {
  return { id, identifier: id.toUpperCase(), title, kind, commitmentStatus: 'COMMITTED', state, assignee: null };
}

const projectsData: GraphProjectsQueryData = {
  projectSummary: {
    totalCount: 6,
    projects: [{ repository: 'fakechris/lumenbox', name: 'fakechris/lumenbox', identifier: 'INV-96', totalCount: 6 }],
  },
};

// Mirrors INV-636/637 -> INV-638: one blocker still open, one done; the
// blocked item has already started, so the open edge is a violation.
const graphData: ProjectWorkGraphQueryData = {
  workGraph: {
    repository: 'fakechris/lumenbox',
    truncated: false,
    root: { id: 'inv-96', identifier: 'INV-96', title: 'fakechris/lumenbox' },
    nodes: [
      record('inv-96', 'fakechris/lumenbox', states.progress, 'PROJECT'),
      record('inv-141', 'Browser and computer use', states.progress, 'MILESTONE'),
      record('inv-636', 'Observation contract', states.progress),
      record('inv-637', 'Result contract', states.done),
      record('inv-638', 'Semantic execution adapter', states.progress),
      record('inv-700', 'Loose item', states.ready),
    ],
    externalNodes: [record('inv-900', 'Other project blocker', states.ready)],
    edges: [
      { id: 'c1', type: 'CONTAINS', fromId: 'inv-96', toId: 'inv-141' },
      { id: 'c2', type: 'CONTAINS', fromId: 'inv-141', toId: 'inv-636' },
      { id: 'c3', type: 'CONTAINS', fromId: 'inv-141', toId: 'inv-637' },
      { id: 'c4', type: 'CONTAINS', fromId: 'inv-141', toId: 'inv-638' },
      { id: 'b1', type: 'BLOCKS', fromId: 'inv-636', toId: 'inv-638' },
      { id: 'b2', type: 'BLOCKS', fromId: 'inv-637', toId: 'inv-638' },
      { id: 'b3', type: 'BLOCKS', fromId: 'inv-900', toId: 'inv-636' },
      { id: 'r1', type: 'RELATED_TO', fromId: 'inv-700', toId: 'inv-638' },
    ],
  },
};

function renderGraph(path: string) {
  return renderApp(App, { data: boardQueryResult, loading: false, graphData, graphProjectsData: projectsData }, [path]);
}

describe('project graph page (INV-681)', () => {
  it('asks for a project before drawing anything', async () => {
    renderGraph('/graph');
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeInTheDocument();
    expect(screen.getByText('Choose a project to see its structure and dependencies.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fakechris\/lumenbox/ })).toBeInTheDocument();
  });

  it('outlines the CONTAINS tree with roll-up progress, blocked markers and unplaced work', async () => {
    renderGraph('/graph?project=fakechris/lumenbox');
    const outline = await screen.findByRole('tree', { name: 'Project outline' });

    const milestone = within(outline).getByRole('treeitem', { name: 'INV-141 Browser and computer use' });
    expect(within(milestone).getByLabelText('1 of 3 done')).toBeInTheDocument();

    const blocked = within(outline).getByRole('treeitem', { name: 'INV-638 Semantic execution adapter' });
    expect(within(blocked).getByText('Blocked')).toHaveAttribute('title', 'Blocked by INV-636 Observation contract');

    const unplaced = within(outline).getByRole('region', { name: 'Not in the hierarchy' });
    expect(within(unplaced).getByText('INV-700')).toBeInTheDocument();
    expect(within(outline).queryByText('INV-900')).not.toBeInTheDocument();

    fireEvent.click(within(milestone).getByRole('button', { name: 'Collapse INV-141' }));
    expect(within(outline).queryByRole('treeitem', { name: 'INV-638 Semantic execution adapter' })).not.toBeInTheDocument();
  });

  it('draws BLOCKS edges classified by whether the blocked work is waiting', async () => {
    const { container } = renderGraph('/graph?project=fakechris/lumenbox&view=dependencies');
    const graph = await screen.findByRole('region', { name: 'Dependency graph' });

    expect(within(graph).getByRole('button', { name: 'Focus INV-638 Semantic execution adapter' })).toBeInTheDocument();
    expect(within(graph).getByRole('button', { name: 'Focus INV-900 Other project blocker' })).toHaveClass('dependency-node--external');
    // Work with no dependency link stays out of the dependency view.
    expect(within(graph).queryByRole('button', { name: /INV-700/ })).not.toBeInTheDocument();

    const kinds = [...container.querySelectorAll('[data-edge-kind]')].map((edge) => edge.getAttribute('data-edge-kind')).sort();
    // 636 (open) -> 638 (started): violated; 637 done: resolved; 900 (ready) -> 636 (started): violated.
    expect(kinds).toEqual(['resolved', 'violated', 'violated']);
  });

  it('focuses a node, dims the rest and lists its blockers', async () => {
    renderGraph('/graph?project=fakechris/lumenbox&view=dependencies&hops=1');
    const graph = await screen.findByRole('region', { name: 'Dependency graph' });

    fireEvent.click(within(graph).getByRole('button', { name: 'Focus INV-638 Semantic execution adapter' }));

    const panel = await screen.findByRole('complementary', { name: 'Focused INV-638' });
    expect(within(panel).getByText('Blocked by · 2')).toBeInTheDocument();
    expect(within(graph).getByRole('button', { name: 'Focus INV-900 Other project blocker' })).toHaveClass('dependency-graph__dimmed');
    expect(within(graph).getByRole('button', { name: 'Focus INV-636 Observation contract' })).not.toHaveClass('dependency-graph__dimmed');
  });

  it('shows related links only when asked', async () => {
    const { container } = renderGraph('/graph?project=fakechris/lumenbox&view=dependencies&links=all');
    await screen.findByRole('region', { name: 'Dependency graph' });
    expect(container.querySelectorAll('[data-edge-kind="other"]')).toHaveLength(1);
  });

  it('switches to the milestone roll-up from the toolbar', async () => {
    renderGraph('/graph?project=fakechris/lumenbox&view=dependencies');
    const graph = await screen.findByRole('region', { name: 'Dependency graph' });
    expect(within(graph).getByRole('button', { name: /INV-638/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Milestones only' }));

    expect(await screen.findByRole('button', { name: 'Focus INV-141 Browser and computer use' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /INV-638/ })).not.toBeInTheDocument();
  });

  it('rolls dependencies up to milestones', async () => {
    const { container } = renderGraph('/graph?project=fakechris/lumenbox&view=dependencies&rollup=1');
    const graph = await screen.findByRole('region', { name: 'Dependency graph' });
    // Everything inside INV-141 collapses into it; only the cross-project edge remains.
    expect(within(graph).getByRole('button', { name: 'Focus INV-141 Browser and computer use' })).toBeInTheDocument();
    expect(within(graph).queryByRole('button', { name: /INV-638/ })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-edge-kind]')).toHaveLength(1);
  });

  it('says when every dependency stays inside one milestone instead of claiming there are none', async () => {
    const insideOnly: ProjectWorkGraphQueryData = {
      workGraph: { ...graphData.workGraph, externalNodes: [], edges: graphData.workGraph.edges.filter((edge) => edge.id !== 'b3') },
    };
    renderApp(App, { data: boardQueryResult, loading: false, graphData: insideOnly, graphProjectsData: projectsData }, [
      '/graph?project=fakechris/lumenbox&view=dependencies&rollup=1',
    ]);
    expect(await screen.findByRole('heading', { name: 'No dependencies between milestones' })).toBeInTheDocument();
  });
});
