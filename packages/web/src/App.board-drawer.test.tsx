import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App board drawer flows', () => {
  it('shows the clicked issue details including parent information', async () => {
    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Ready item');
    expect(within(drawer).getByLabelText('Issue description')).toHaveValue('Ready description');
    expect(within(drawer).getByText('INV-1 — Backlog item')).toBeInTheDocument();
    expect(within(drawer).getByText('No child issues.')).toBeInTheDocument();
  });

  it('renders the drawer as a modal dialog and closes from the backdrop control', async () => {
    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(drawer).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close issue detail drawer' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).not.toBeInTheDocument(),
    );
  });
});
