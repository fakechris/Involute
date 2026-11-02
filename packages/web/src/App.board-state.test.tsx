import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueUpdateMutationData } from './board/types';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App board state flows', () => {
  it('opens the issue drawer and changes state via dropdown', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            state: { id: 'state-progress', name: 'In Progress', type: 'STARTED', position: 2 },
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-progress' },
    });

    expect(mutate).toHaveBeenCalledWith({
      variables: {
        id: 'issue-1',
        input: { expectedRevision: 1, stateId: 'state-progress' },
      },
    });

    expect(await within(screen.getByTestId('column-In Progress')).findByText('INV-1')).toBeInTheDocument();
  });

  it('persists the final state when changed via the drawer dropdown', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            state: { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-ready' },
    });

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { expectedRevision: 1, stateId: 'state-ready' },
        },
      }),
    );
  });

  it('asks why before canceling, and sends the resolution with the move (INV-1118)', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: { ...getIssue('issue-1'), state: { id: 'state-canceled', name: 'Canceled', type: 'CANCELED', position: 5 } },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    // Keeping it open sends nothing.
    fireEvent.change(within(drawer).getByLabelText('Issue state'), { target: { value: 'state-canceled' } });
    const first = await screen.findByRole('dialog', { name: 'Close reason' });
    fireEvent.click(within(first).getByRole('button', { name: 'Keep open' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Close reason' })).not.toBeInTheDocument());
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.change(within(drawer).getByLabelText('Issue state'), { target: { value: 'state-canceled' } });
    const dialog = await screen.findByRole('dialog', { name: 'Close reason' });
    const submit = within(dialog).getByRole('button', { name: 'Cancel work' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Resolution'), { target: { value: 'OBSOLETE' } });
    fireEvent.change(within(dialog).getByLabelText('Close reason text'), { target: { value: 'Superseded by INV-2' } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { expectedRevision: 1, stateId: 'state-canceled', resolution: 'OBSOLETE', reason: 'Superseded by INV-2' },
        },
      }),
    );
  });

  it('cancelling an item another one replaced starts with the resolution and reason filled in (INV-1498, INV-1516)', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: { issueUpdate: { success: true, issue: { ...getIssue('issue-1'), state: { id: 'state-canceled', name: 'Canceled', type: 'CANCELED', position: 5 } } } } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);
    const data = {
      ...boardQueryResult,
      issues: { ...boardQueryResult.issues, nodes: boardQueryResult.issues.nodes.map((issue) => (issue.id === 'issue-1' ? { ...issue, kind: 'DECISION' as const, supersededBy: { id: 'issue-9', identifier: 'INV-9', title: 'The new rule' } } : issue)) },
    };
    renderTestApp({ data, loading: false });

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.change(within(drawer).getByLabelText('Issue state'), { target: { value: 'state-canceled' } });
    const dialog = await screen.findByRole('dialog', { name: 'Close reason' });
    expect(within(dialog).getByLabelText('Resolution')).toHaveValue('OBSOLETE');
    expect(within(dialog).getByLabelText('Close reason text')).toHaveValue('Superseded by INV-9: The new rule');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith({ variables: { id: 'issue-1', input: { expectedRevision: 1, stateId: 'state-canceled', resolution: 'OBSOLETE', reason: 'Superseded by INV-9: The new rule' } } }));
  });

  it('asks the server for the most recently changed work first (INV-1516)', async () => {
    renderTestApp();
    await screen.findByRole('button', { name: 'Open INV-1' });
    const boardCall = apolloMocks.useQuery.mock.calls.find(([document]) => JSON.stringify(document).includes('BoardPage'));
    expect(boardCall?.[1]?.variables?.orderBy).toBe('UPDATED');
  });

  it('a column whose items are all on a later page says how many are not loaded (INV-1516)', async () => {
    const team = boardQueryResult.teams.nodes[0]!;
    const canceled = team.states.nodes.find((state) => state.type === 'CANCELED');
    if (!canceled) return; // the fixture team has no Canceled column
    const data = {
      ...boardQueryResult,
      issueStateCounts: [{ stateId: canceled.id, count: 3 }],
      issues: { ...boardQueryResult.issues, pageInfo: { ...boardQueryResult.issues.pageInfo, hasNextPage: true, endCursor: 'cursor-2' } },
    };
    renderTestApp({ data, loading: false });
    // Canceled starts collapsed: its header carries the full count instead of 0.
    const column = await screen.findByRole('region', { name: `${canceled.name} column (collapsed)` });
    expect(within(column).getByTitle('0 loaded, 3 more not loaded yet')).toHaveTextContent('3');
  });
});
