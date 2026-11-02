import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueSummary } from './board/types';

/**
 * A ?issue= link names one work item (INV-1469). The board may not show it:
 * a filter can hide it, or it can sit beyond the first page. The drawer then
 * asks the server for that one issue and opens it, so the link always opens
 * what it names.
 */
const linkedIssue: IssueSummary = {
  id: 'issue-1446',
  identifier: 'INV-1446',
  revision: 1,
  title: 'Time window filter',
  description: 'Linked description',
  kind: 'ISSUE',
  commitmentStatus: 'COMMITTED',
  priority: 3,
  createdAt: '2026-04-02T10:00:00.000Z',
  updatedAt: '2026-04-02T10:00:00.000Z',
  state: { id: 'state-done', name: 'Done', type: 'COMPLETED', position: 4 },
  team: {
    id: 'team-1',
    key: 'INV',
    name: 'Involute',
    states: {
      nodes: [
        { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
        { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
        { id: 'state-progress', name: 'In Progress', type: 'STARTED', position: 2 },
        { id: 'state-review', name: 'In Review', type: 'STARTED', position: 3 },
        { id: 'state-done', name: 'Done', type: 'COMPLETED', position: 4 },
        { id: 'state-canceled', name: 'Canceled', type: 'CANCELED', position: 5 },
      ],
    },
  },
  labels: { nodes: [] },
  assignee: null,
  children: { nodes: [] },
  parent: null,
  comments: { nodes: [] },
};

function renderLinkedIssueApp(initialEntries: string[]) {
  window.localStorage.setItem('involute.activeTeamKey', 'INV');
  return renderApp(
    App,
    { data: boardQueryResult, loading: false, issuePageData: { issue: linkedIssue } },
    initialEntries,
  );
}

describe('a link to an issue the board does not list (INV-1469)', () => {
  it('opens the drawer for the issue the link names', async () => {
    renderLinkedIssueApp(['/?issue=INV-1446']);

    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    // The linked issue is not on the board, so the drawer fetches it on its
    // own: the dialog appears before the issue does. Wait for the data, the
    // way the routing test does — asserting straight after the dialog opens
    // is a race that turns the build red at random.
    await waitFor(() =>
      expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Time window filter'),
    );
    await waitFor(() => expect(within(drawer).getByText('Linked description')).toBeInTheDocument());
    expect(within(drawer).getByRole('link', { name: 'Open full page' })).toHaveAttribute(
      'href',
      '/issue/INV-1446',
    );
  });

  it('opens it even when the board carries a filter that hides the issue', async () => {
    // The board keeps its filter in localStorage, so it is still in effect
    // when the link is opened directly.
    window.localStorage.setItem(
      'involute.board.viewState.INV',
      JSON.stringify({ sortField: 'updatedAt', sortDirection: 'asc', query: '143' }),
    );

    renderLinkedIssueApp(['/?issue=INV-1446']);

    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    await waitFor(() =>
      expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Time window filter'),
    );
  });

  it('closing it takes only ?issue= away and keeps the rest of the URL', async () => {
    renderLinkedIssueApp(['/?project=fakechris%2FInvolute&issue=INV-1446']);

    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close issue detail drawer' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).not.toBeInTheDocument(),
    );
    expect(window.location.search).not.toContain('issue=');
  });

  it('closes on Escape', async () => {
    renderLinkedIssueApp(['/?issue=INV-1446']);

    await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).not.toBeInTheDocument(),
    );
  });

  it('shows nothing when the named issue does not exist', async () => {
    renderApp(
      App,
      { data: boardQueryResult, loading: false, issuePageData: { issue: null } },
      ['/?issue=INV-9999'],
    );

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).toBeNull());
  });
});
