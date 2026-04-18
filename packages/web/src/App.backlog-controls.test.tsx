import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from './test/app-test-helpers';
import { boardQueryResult } from './test/app-test-helpers';
import type { BoardPageQueryData, IssueSummary } from './board/types';

describe('App backlog controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('filters backlog issues and can save then reload a saved view', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Ready bugs');

    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();

    const filters = screen.getByLabelText('Backlog filters');

    fireEvent.click(within(filters).getByText('States'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ready' }));
    fireEvent.click(within(filters).getByText('Labels'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bug' }));

    const table = screen.getByRole('table');

    await waitFor(() => {
      expect(within(table).getByRole('button', { name: 'Ready item' })).toBeInTheDocument();
      expect(within(table).queryByRole('button', { name: 'Backlog item' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(screen.getByRole('option', { name: 'Ready bugs' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(within(table).getByRole('button', { name: 'Backlog item' })).toBeInTheDocument();
      expect(within(table).getByRole('button', { name: 'Ready item' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Load saved backlog view'), {
      target: { value: screen.getByRole('option', { name: 'Ready bugs' }).getAttribute('value') },
    });

    await waitFor(() => {
      expect(within(table).getByRole('button', { name: 'Ready item' })).toBeInTheDocument();
      expect(within(table).queryByRole('button', { name: 'Backlog item' })).not.toBeInTheDocument();
    });
  });

  it('sorts backlog rows using the selected sort field and direction', async () => {
    const customData: BoardPageQueryData = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: [
          {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            id: 'issue-10',
            identifier: 'INV-10',
            title: 'Alpha task',
            updatedAt: '2026-04-01T10:00:00.000Z',
            team: { id: 'team-1', key: 'INV' },
          },
          {
            ...(boardQueryResult.issues.nodes[1] as IssueSummary),
            id: 'issue-11',
            identifier: 'INV-11',
            title: 'Zulu task',
            updatedAt: '2026-04-03T10:00:00.000Z',
            team: { id: 'team-1', key: 'INV' },
          },
          {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            id: 'issue-12',
            identifier: 'INV-12',
            title: 'Delta task',
            updatedAt: '2026-04-02T10:00:00.000Z',
            team: { id: 'team-1', key: 'INV' },
          },
        ],
      },
    };

    renderApp({ data: customData, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Sort backlog by'), {
      target: { value: 'title' },
    });
    fireEvent.change(screen.getByLabelText('Sort backlog direction'), {
      target: { value: 'desc' },
    });

    const bodyRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(bodyRows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'Zulu task',
      'Delta task',
      'Alpha task',
    ]);
  });

  it('focuses backlog search with slash and clears it with Escape', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    const searchInput = await screen.findByLabelText('Search backlog issues');
    fireEvent.keyDown(window, { key: '/' });
    expect(searchInput).toHaveFocus();

    fireEvent.change(searchInput, {
      target: { value: 'Backlog' },
    });
    expect(searchInput).toHaveValue('Backlog');

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(searchInput).toHaveValue('');
  });
});
