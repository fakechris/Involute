import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

// The helpers mock Apollo; they load before the app so the app gets the mock.
import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { WorkHygieneQueryData, WorkSearchQueryData } from './work/types';

/** The app plus where it is, so a test can check what closing left in the URL. */
function AppWithLocation() {
  const location = useLocation();
  return (
    <>
      <App />
      <output data-testid="where">{location.pathname + location.search}</output>
    </>
  );
}

const searchData: WorkSearchQueryData = {
  search: [
    {
      matchedField: 'title',
      snippet: null,
      commentId: null,
      issue: {
        id: 'issue-1',
        identifier: 'INV-1',
        title: 'Backlog item',
        state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG' },
        team: { id: 'team-1', key: 'INV' },
      },
    },
  ],
};

const emptyHygiene: WorkHygieneQueryData['workHygiene'] = {
  unplacedCount: 1,
  unplaced: [{ id: 'issue-2', identifier: 'INV-2', title: 'Ready item', kind: 'ISSUE', repository: null }],
  unlinkedMentionCount: 0,
  unlinkedMentions: [],
  dependencyWithoutBlocksCount: 0,
  dependencyWithoutBlocks: [],
  researchWithoutDownstreamCount: 0,
  researchWithoutDownstream: [],
  researchClosableCount: 0,
  researchClosable: [],
  researchWithoutAttachmentCount: 0,
  researchWithoutAttachment: [],
  incidentsWithoutDownstreamCount: 0,
  incidentsWithoutDownstream: [],
  incidentsWithoutPostmortemCount: 0,
  incidentsWithoutPostmortem: [],
  overdueFollowUpCount: 0,
  overdueFollowUps: [],
};

const where = () => screen.getByTestId('where').textContent ?? '';

describe('issue drawer on every route (INV-1387)', () => {
  it('Search: a result opens the drawer in place and Esc closes it, keeping the query', async () => {
    renderApp(AppWithLocation, { data: boardQueryResult, loading: false, searchData }, ['/search?q=backlog&kind=ISSUE']);
    const results = await screen.findByRole('list', { name: 'Search results' });
    const link = within(results).getByRole('link', { name: /INV-1/ });
    // A real href to the full page, so ⌘/Ctrl/middle click opens it.
    expect(link).toHaveAttribute('href', '/issue/INV-1');

    fireEvent.click(link);
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Backlog item');
    expect(within(drawer).getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/issue/INV-1');
    expect(where()).toBe('/search?q=backlog&kind=ISSUE&issue=INV-1');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).toBeNull());
    expect(where()).toBe('/search?q=backlog&kind=ISSUE');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument();
  });

  it('Health: a row opens the drawer and Close removes only ?issue=', async () => {
    renderApp(AppWithLocation, { data: boardQueryResult, loading: false, hygieneData: { workHygiene: emptyHygiene } }, ['/hygiene?team=INV']);
    const unplaced = await screen.findByRole('region', { name: 'Not in any project tree' });
    const link = within(unplaced).getByRole('link', { name: /INV-2/ });
    expect(link).toHaveAttribute('href', '/issue/INV-2');

    fireEvent.click(link);
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Ready item');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).toBeNull());
    expect(where()).toBe('/hygiene?team=INV');

    fireEvent.click(link);
    await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).toBeNull());
    expect(where()).toBe('/hygiene?team=INV');
  });

  it('a modified click leaves the URL to the browser', async () => {
    renderApp(AppWithLocation, { data: boardQueryResult, loading: false, searchData }, ['/search?q=backlog']);
    const results = await screen.findByRole('list', { name: 'Search results' });
    const link = within(results).getByRole('link', { name: /INV-1/ });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(where()).toBe('/search?q=backlog');
    expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).toBeNull();
  });

  it('opens from a shared link by id or identifier', async () => {
    renderApp(AppWithLocation, { data: boardQueryResult, loading: false, hygieneData: { workHygiene: emptyHygiene } }, ['/hygiene?issue=issue-1']);
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Backlog item');
  });

  it('leaves the board its own drawer: one dialog, not two', async () => {
    renderApp(AppWithLocation, { data: boardQueryResult, loading: false }, ['/?issue=INV-2']);
    await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(screen.getAllByRole('dialog', { name: 'Issue detail drawer' })).toHaveLength(1);
  });
});
