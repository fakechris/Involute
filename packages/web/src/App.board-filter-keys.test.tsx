import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import { getDefaultBoardViewState, writeStoredBoardViewState } from './board/views';
import { SHORTCUT_SECTIONS } from './app/KeyboardShortcutsDialog';

// INV-1086: saved filters never act unseen, and the keyboard reaches them.
describe('board filter keys', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('opens the bar when a saved filter is in effect, and ⇧F clears everything', async () => {
    writeStoredBoardViewState('INV', { ...getDefaultBoardViewState(), labelIds: ['label-task'], query: 'backlog' });
    renderApp(App, { data: boardQueryResult, loading: false }, ['/?team=INV']);
    expect(await screen.findByLabelText('Search board issues')).toHaveValue('backlog');
    expect(screen.getByRole('button', { name: 'Remove Label: task' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    await waitFor(() => expect(screen.getByLabelText('Search board issues')).toHaveValue(''));
    expect(screen.queryByRole('button', { name: 'Remove Label: task' })).not.toBeInTheDocument();
  });

  it('shows a filter count with Clear while the bar is hidden, F toggles it, and / opens and focuses search', async () => {
    writeStoredBoardViewState('INV', { ...getDefaultBoardViewState(), labelIds: ['label-task'] });
    renderApp(App, { data: boardQueryResult, loading: false }, ['/?team=INV']);
    await screen.findByLabelText('Search board issues');

    fireEvent.keyDown(window, { key: 'f' });
    await waitFor(() => expect(screen.queryByLabelText('Search board issues')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '1 filter' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '/' });
    const search = await screen.findByLabelText('Search board issues');
    await waitFor(() => expect(search).toHaveFocus());

    // Esc with text clears it; Esc again leaves the box.
    fireEvent.change(search, { target: { value: 'abc' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).not.toHaveFocus();

    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all filters' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '1 filter' })).not.toBeInTheDocument());
  });

  it('lists the new keys in the shortcut sheet', () => {
    const labels = SHORTCUT_SECTIONS.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).toEqual(expect.arrayContaining(['Show / hide filters', 'Clear all filters']));
  });
});
