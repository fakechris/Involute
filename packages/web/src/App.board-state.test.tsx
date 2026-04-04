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
            state: { id: 'state-progress', name: 'In Progress' },
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
        input: { stateId: 'state-progress' },
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
            state: { id: 'state-ready', name: 'Ready' },
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
          input: { stateId: 'state-ready' },
        },
      }),
    );
  });

});
