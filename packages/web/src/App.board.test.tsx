import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App board UI', () => {
  it('renders all six board columns in order', async () => {
    renderTestApp();

    const headers = await screen.findAllByRole('heading', { level: 2 });

    expect(headers.map((header) => header.textContent)).toEqual([
      'Backlog',
      'Ready',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
  });

  it('renders issue cards in the matching board columns', async () => {
    renderTestApp();

    const backlogColumn = await screen.findByTestId('column-Backlog');
    const readyColumn = screen.getByTestId('column-Ready');

    expect(within(backlogColumn).getByText('INV-1')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('Backlog item')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('task')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('Admin')).toBeInTheDocument();
    expect(within(readyColumn).getByText('INV-2')).toBeInTheDocument();
    expect(within(readyColumn).getByText('Ready item')).toBeInTheDocument();
  });

  it('renders stable drag handles and state-id based droppable selectors for board automation', async () => {
    renderTestApp();

    expect(await screen.findByTestId('issue-drag-handle-INV-1')).toHaveAccessibleName('Drag INV-1');
    expect(screen.getByTestId('issue-drag-handle-INV-2')).toHaveAccessibleName('Drag INV-2');

    expect(screen.getByTestId('board-column-state-backlog')).toHaveAttribute('data-state-id', 'state-backlog');
    expect(screen.getByTestId('board-column-state-ready')).toHaveAttribute('data-state-id', 'state-ready');
    expect(screen.getByTestId('column-Backlog')).toHaveAttribute('data-droppable-state-id', 'state-backlog');
    expect(screen.getByTestId('column-Ready')).toHaveAttribute('data-droppable-state-id', 'state-ready');
    expect(screen.getByTestId('issue-drag-handle-INV-1')).toHaveAttribute('draggable', 'true');
  });
});
