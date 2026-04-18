import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';

describe('App routing', () => {
  it('navigates between board and backlog via header links', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Backlog' }));

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Identifier' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Board' }));

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
  });

  it('renders real issue details on the direct /issue/:id route', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/issue/issue-2']);

    expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();
    expect(screen.getByText('INV-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Issue title')).toHaveValue('Ready item'));
    await waitFor(() => expect(screen.getByLabelText('Issue description')).toHaveValue('Ready description'));
    expect(screen.getByText('INV-1 — Backlog item')).toBeInTheDocument();
  });

  it('renders backlog list rows and opens issue details from the table', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

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
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();

    const selectors = screen.getAllByLabelText('Select team');
    expect(selectors).toHaveLength(1);
    const sharedSelector = selectors[0]!;
    expect(sharedSelector).toHaveValue('INV');
    expect(within(sharedSelector).getAllByRole('option')).toHaveLength(2);
  });

  it('switches backlog rows when changing teams from the shared header selector', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('button', { name: 'Backlog item' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    await waitFor(() => {
      expect(within(screen.getByRole('table')).getByRole('button', { name: 'Sonata backlog item' })).toBeInTheDocument();
    });
    expect(screen.getByText('List view for Sonata issues.')).toBeInTheDocument();
  });
});
