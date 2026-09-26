import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { GraphProjectsQueryData, PlacementOptionsQueryData, ProjectWorkGraphQueryData } from './work/types';

// Entry points that already know where new work goes (INV-744): a sub-issue
// from an issue, and "+" on a project or milestone row of the outline.

const REPOSITORY = 'fakechris/lumenbox';
const ready = { id: 's-ready', name: 'Ready', type: 'UNSTARTED' as const };

const boardData = {
  ...boardQueryResult,
  issues: {
    ...boardQueryResult.issues,
    nodes: boardQueryResult.issues.nodes.map((issue) =>
      issue.id === 'issue-1' ? { ...issue, kind: 'ISSUE' as const, repository: REPOSITORY } : issue,
    ),
  },
  projectSummary: {
    totalCount: 3,
    noRepositoryCount: 0,
    projects: [{ repository: REPOSITORY, name: 'Lumenbox', identifier: 'INV-96', totalCount: 3 }],
  },
};

const placementData: PlacementOptionsQueryData = {
  projects: { nodes: [{ id: 'inv-96', identifier: 'INV-96', title: REPOSITORY, kind: 'PROJECT' }] },
  milestones: { nodes: [{ id: 'inv-141', identifier: 'INV-141', title: 'Browser and computer use', kind: 'MILESTONE', state: { type: 'STARTED' } }] },
  epics: { nodes: [] },
};

const graphProjectsData: GraphProjectsQueryData = {
  projectSummary: { totalCount: 3, projects: [{ repository: REPOSITORY, name: REPOSITORY, identifier: 'INV-96', totalCount: 3 }] },
};

const graphData: ProjectWorkGraphQueryData = {
  workGraph: {
    repository: REPOSITORY,
    truncated: false,
    root: { id: 'inv-96', identifier: 'INV-96', title: REPOSITORY },
    nodes: [
      { id: 'inv-96', identifier: 'INV-96', title: REPOSITORY, kind: 'PROJECT', commitmentStatus: 'COMMITTED', state: ready, assignee: null },
      { id: 'inv-141', identifier: 'INV-141', title: 'Browser and computer use', kind: 'MILESTONE', commitmentStatus: 'COMMITTED', state: ready, assignee: null },
    ],
    externalNodes: [],
    edges: [{ id: 'c1', type: 'CONTAINS', fromId: 'inv-96', toId: 'inv-141' }],
  },
};

function render(path: string) {
  return renderApp(App, { data: boardData, loading: false, placementData, graphData, graphProjectsData }, [path]);
}

describe('create issue from context (INV-744)', () => {
  beforeEach(() => window.localStorage.clear());

  it('adds a sub-issue from the issue drawer, placed under that issue', async () => {
    render('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add sub-issue to INV-1' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    expect((within(dialog).getByLabelText('Project') as HTMLSelectElement).value).toBe(REPOSITORY);
    const location = within(dialog).getByLabelText('Location') as HTMLSelectElement;
    expect(location.value).toBe('issue-1');
    expect(within(location).getByRole('option', { name: 'Sub-issue of INV-1 — Backlog item' })).toBeInTheDocument();
  });

  it('creates in a milestone from its outline row', async () => {
    render(`/graph?project=${REPOSITORY}`);
    const outline = await screen.findByRole('tree', { name: 'Project outline' });
    fireEvent.click(within(outline).getByRole('button', { name: 'New issue in INV-141' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    expect((within(dialog).getByLabelText('Project') as HTMLSelectElement).value).toBe(REPOSITORY);
    expect((within(dialog).getByLabelText('Location') as HTMLSelectElement).value).toBe('inv-141');
  });

  it('creates directly under the project, as No milestone, from the project row', async () => {
    render(`/graph?project=${REPOSITORY}`);
    const outline = await screen.findByRole('tree', { name: 'Project outline' });
    fireEvent.click(within(outline).getByRole('button', { name: 'New issue in INV-96 (No milestone)' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    const location = within(dialog).getByLabelText('Location') as HTMLSelectElement;
    expect(location.value).toBe('INV-96');
    expect(location.selectedOptions[0]?.textContent).toBe('No milestone');
  });
});
