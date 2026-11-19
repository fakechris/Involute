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

  it('navigates visible sorted rows, sets priority, selects into bulk actions and peeks', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);
    const table = await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Sort backlog by'), { target: { value: 'title' } });
    fireEvent.change(screen.getByLabelText('Sort backlog direction'), { target: { value: 'asc' } });
    const rows = within(table).getAllByRole('row').slice(1);
    fireEvent.keyDown(window, { key: 'k' });
    expect(rows[0]).toHaveClass('backlog-table__focused');
    fireEvent.keyDown(window, { key: 'j' });
    expect(rows[1]).toHaveClass('backlog-table__focused');
    fireEvent.keyDown(window, { key: 'k' });
    expect(rows[0]).toHaveClass('backlog-table__focused');

    fireEvent.keyDown(window, { key: 'p' });
    const picker = await screen.findByRole('dialog', { name: 'Set priority' });
    fireEvent.keyDown(within(picker).getByLabelText('Set priority filter'), { key: 'Escape' });
    fireEvent.click(within(rows[1]!).getByRole('checkbox'));
    fireEvent.keyDown(window, { key: 'x' });
    expect(within(rows[0]!).getByRole('checkbox')).toBeChecked();
    expect(within(rows[1]!).getByRole('checkbox')).toBeChecked();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'x' });
    expect(within(rows[0]!).getByRole('checkbox')).not.toBeChecked();

    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByRole('dialog', { name: 'Peek INV-1' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.queryByRole('dialog', { name: 'Peek INV-1' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search backlog issues'), { target: { value: 'Ready item' } });
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByRole('button', { name: 'Ready item' }).closest('tr')).toHaveClass('backlog-table__focused');
    fireEvent.keyDown(window, { key: ' ' });
    expect(await screen.findByRole('dialog', { name: 'Peek INV-2' })).toBeInTheDocument();
  });

  it('preserves Enter and Space activation on focused interactive controls', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);
    const rowButton = await screen.findByRole('button', { name: 'Backlog item' });
    const save = screen.getByRole('button', { name: 'Save view' });
    const link = document.createElement('a');
    link.href = '#backlog';
    const customButton = document.createElement('span');
    customButton.setAttribute('role', 'button');
    customButton.tabIndex = 0;
    document.body.append(link, customButton);
    for (const target of [save, rowButton, link, customButton]) {
      target.focus();
      for (const key of ['Enter', ' ']) {
        expect(fireEvent.keyDown(target, { key })).toBe(true);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
      }
    }
    fireEvent.keyDown(save, { key: 'j' });
    expect(screen.getByRole('button', { name: 'Ready item' }).closest('tr')).toHaveClass('backlog-table__focused');
    link.remove();
    customButton.remove();
  });

  it('ignores row shortcuts while typing, in a dialog, and with no matching rows', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);
    const search = await screen.findByLabelText('Search backlog issues');
    const firstRow = screen.getByRole('button', { name: 'Backlog item' }).closest('tr');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.append(child);
    const textarea = document.createElement('textarea');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(editable, textarea);
    for (const target of [search, textarea, child]) {
      for (const key of ['j', 'k', 'p', 'x', ' ']) fireEvent.keyDown(target, { key });
      expect(firstRow).toHaveClass('backlog-table__focused');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(within(firstRow!).getByRole('checkbox')).not.toBeChecked();
    }
    document.body.append(dialog);
    for (const key of ['j', 'k', 'p', 'x', ' ']) fireEvent.keyDown(window, { key });
    expect(firstRow).toHaveClass('backlog-table__focused');
    expect(within(firstRow!).getByRole('checkbox')).not.toBeChecked();
    expect(screen.getAllByRole('dialog')).toEqual([dialog]);
    editable.remove();
    textarea.remove();
    dialog.remove();
    fireEvent.change(search, { target: { value: 'no matching issue' } });
    for (const key of ['j', 'k', 'p', 'x', ' ']) fireEvent.keyDown(window, { key });
    expect(screen.getByText('No issues match the current backlog view.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
