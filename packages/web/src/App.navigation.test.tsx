import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App navigation and backlog flows', () => {
  it('navigates between board and backlog via header links', async () => {
    renderTestApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'l' });

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Identifier' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'b' });

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
  });

  it('renders real issue details on the direct /issue/:id route', async () => {
    renderTestApp({ data: boardQueryResult, loading: false }, ['/issue/issue-2']);

    expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();
    expect(screen.getByText('INV-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Issue title')).toHaveValue('Ready item'));
    await waitFor(() => expect(screen.getByLabelText('Issue description')).toHaveValue('Ready description'));
    expect(screen.getByText('INV-1 — Backlog item')).toBeInTheDocument();
  });

  it('renders backlog list rows and opens issue details from the table', async () => {
    renderTestApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('cell', { name: 'INV-1' })).toBeInTheDocument();
    expect(within(table).getAllByRole('cell', { name: 'Backlog' }).length).toBeGreaterThan(0);
    expect(within(table).getByRole('cell', { name: 'task' })).toBeInTheDocument();

    fireEvent.click(within(table).getByRole('button', { name: 'Backlog item' }));

    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Backlog item');
  });

  it('keeps the shared header team selector on backlog and removes the duplicate backlog-only selector', async () => {
    renderTestApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();

    const selectors = screen.getAllByLabelText('Select team');
    expect(selectors).toHaveLength(1);
    const sharedSelector = selectors[0]!;
    expect(sharedSelector).toHaveValue('INV');
    expect(within(sharedSelector).getAllByRole('option')).toHaveLength(2);
  });
});
