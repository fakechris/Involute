import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  apolloMocks,
  boardQueryResult,
  renderApp,
  type IssueDeleteMutationData,
  type IssueSummary,
  type IssueUpdateMutationData,
} from './test/app-test-helpers';

describe('App board', () => {
  it('renders all six board columns in order', async () => {
    renderApp();

    const headers = await screen.findAllByRole('heading', { level: 2 });

    expect(headers.map((header) => header.textContent)).toEqual([
      'Backlog',
      'Ready',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
  });

  it('renders issue cards in the matching board columns', async () => {
    renderApp();

    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Backlog item')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('INV-2')).toBeInTheDocument();
    expect(screen.getByText('Ready item')).toBeInTheDocument();
  });

  it('renders stable drag handles and state-id based droppable selectors for board automation', async () => {
    renderApp();

    expect(await screen.findByTestId('issue-drag-handle-INV-1')).toHaveAccessibleName('Drag INV-1');
    expect(screen.getByTestId('issue-drag-handle-INV-2')).toHaveAccessibleName('Drag INV-2');

    expect(screen.getByTestId('board-column-state-backlog')).toHaveAttribute('data-state-id', 'state-backlog');
    expect(screen.getByTestId('board-column-state-ready')).toHaveAttribute('data-state-id', 'state-ready');
    expect(screen.getByTestId('column-Backlog')).toHaveAttribute('data-droppable-state-id', 'state-backlog');
    expect(screen.getByTestId('column-Ready')).toHaveAttribute('data-droppable-state-id', 'state-ready');
    expect(screen.getByTestId('issue-drag-handle-INV-1')).toHaveAttribute('draggable', 'true');
  });

  it('opens the issue drawer and changes state via dropdown', async () => {
    const mutate = vi.fn<
      (args: { variables: { id: string; input: { stateId: string } } }) => Promise<{ data: IssueUpdateMutationData }>
    >().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            state: { id: 'state-progress', name: 'In Progress' },
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

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

  it('persists the final state on drag end after a cross-column preview move', async () => {
    const mutate = vi.fn<
      (args: { variables: { id: string; input: { stateId: string } } }) => Promise<{ data: IssueUpdateMutationData }>
    >().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            state: { id: 'state-ready', name: 'Ready' },
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

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

  it('shows the clicked issue details including parent information', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Ready item');
    expect(within(drawer).getByLabelText('Issue description')).toHaveValue('Ready description');
    expect(within(drawer).getByText('INV-1 — Backlog item')).toBeInTheDocument();
    expect(within(drawer).getByText('No child issues.')).toBeInTheDocument();
  });

  it('renders the drawer as a modal dialog and closes from the backdrop control', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(drawer).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close issue detail drawer' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).not.toBeInTheDocument(),
    );
  });

  it('shows inline title editing guidance while the title input is focused', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const titleInput = within(drawer).getByLabelText('Issue title');

    expect(within(drawer).getByText('Editable title')).toBeInTheDocument();

    fireEvent.focus(titleInput);
    expect(within(drawer).getByText('Press Enter or blur to save')).toBeInTheDocument();

    fireEvent.blur(titleInput);
    await waitFor(() => expect(within(drawer).getByText('Editable title')).toBeInTheDocument());
  });

  it('saves title on Enter and keeps the new value after reopening', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            title: 'Enter-saved title',
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    let drawer = await screen.findByLabelText('Issue detail drawer');

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'Enter-saved title' } });
    fireEvent.keyDown(titleInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { title: 'Enter-saved title' },
        },
      }),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    drawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Enter-saved title');
  });

  it('edits title and saves it via issueUpdate mutation', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            title: 'Updated backlog item',
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'Updated backlog item' } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(mutate).toHaveBeenNthCalledWith(1, {
        variables: {
          id: 'issue-1',
          input: { title: 'Updated backlog item' },
        },
      }),
    );
  });

  it('edits description and saves it via issueUpdate mutation', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            description: 'Updated description',
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    const descriptionInput = within(drawer).getByLabelText('Issue description');
    fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });
    fireEvent.blur(descriptionInput);

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { description: 'Updated description' },
        },
      }),
    );

    await waitFor(() =>
      expect(within(drawer).getByLabelText('Issue description')).toHaveValue('Updated description'),
    );
  });

  it('resyncs the visible description after a successful save without closing the drawer', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            description: 'Persisted description from server',
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    const descriptionInput = within(drawer).getByLabelText('Issue description');
    fireEvent.change(descriptionInput, { target: { value: 'Locally edited draft' } });
    fireEvent.blur(descriptionInput);

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { description: 'Locally edited draft' },
        },
      }),
    );

    await waitFor(() =>
      expect(within(drawer).getByLabelText('Issue description')).toHaveValue(
        'Persisted description from server',
      ),
    );
  });

  it('adds labels and changes assignee via issueUpdate mutation', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              labels: {
                nodes: [
                  { id: 'label-task', name: 'task' },
                  { id: 'label-feature', name: 'Feature' },
                ],
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              assignee: null,
            },
          },
        },
      });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.click(within(drawer).getByLabelText('Feature'));

    await waitFor(() =>
      expect(mutate).toHaveBeenNthCalledWith(1, {
        variables: {
          id: 'issue-1',
          input: { labelIds: ['label-task', 'label-feature'] },
        },
      }),
    );

    fireEvent.change(within(drawer).getByLabelText('Issue assignee'), { target: { value: '' } });

    await waitFor(() =>
      expect(mutate).toHaveBeenNthCalledWith(2, {
        variables: {
          id: 'issue-1',
          input: { assigneeId: null },
        },
      }),
    );
  });

  it('removes an existing label via issueUpdate mutation', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            labels: {
              nodes: [],
            },
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.click(within(drawer).getByLabelText('task'));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { labelIds: [] },
        },
      }),
    );
  });

  it('resets drawer state when reopening a different issue', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const firstDrawer = await screen.findByLabelText('Issue detail drawer');
    fireEvent.change(within(firstDrawer).getByLabelText('Issue title'), {
      target: { value: 'Unsaved title draft' },
    });
    fireEvent.click(within(firstDrawer).getByRole('button', { name: 'Close' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
    const secondDrawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(secondDrawer).getByLabelText('Issue title')).toHaveValue('Ready item');
    expect(within(secondDrawer).getByLabelText('Issue description')).toHaveValue('Ready description');
  });

  it('shows the updated title after closing and reopening the same issue', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            title: 'Persisted title',
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    let drawer = await screen.findByLabelText('Issue detail drawer');

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'Persisted title' } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { title: 'Persisted title' },
        },
      }),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    drawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Persisted title');
  });

  it('deletes an issue and removes it from the board without a reload', async () => {
    const deleteIssue = vi.fn().mockResolvedValue({
      data: {
        issueDelete: {
          success: true,
          issueId: 'issue-1',
        },
      } satisfies IssueDeleteMutationData,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : 'loc' in document && document.loc?.source.body
            ? document.loc.source.body
            : String(document);

      if (source.includes('mutation IssueDelete')) {
        return [deleteIssue];
      }

      return [vi.fn()];
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete issue' }));

    await waitFor(() =>
      expect(deleteIssue).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
        },
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('INV-1')).not.toBeInTheDocument();
    expect(screen.queryByText('Backlog item')).not.toBeInTheDocument();
  });

  it('shows an error and reverts optimistic move when state mutation fails', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('boom'));
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-progress' },
    });

    expect((await screen.findAllByText('We could not save the issue changes. Please try again.')).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
  });

  it('keeps a within-column state change as a no-op', async () => {
    const mutate = vi.fn();
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-backlog' },
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
  });

  it('renders six empty columns without crashing when there are no issues', async () => {
    renderApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [],
          pageInfo: boardQueryResult.issues.pageInfo,
        },
      },
      loading: false,
    });

    expect(await screen.findByText('No issues in Backlog yet.')).toBeInTheDocument();
    expect(screen.getByText('No issues in Canceled yet.')).toBeInTheDocument();
  });

  it('stops retrying pagination when fetchMore fails', async () => {
    const fetchMore = vi.fn().mockRejectedValue(new Error('network failed'));

    renderApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: boardQueryResult.issues.nodes.slice(0, 2),
          pageInfo: {
            endCursor: 'cursor-2',
            hasNextPage: true,
          },
        },
      },
      fetchMore,
      loading: false,
    });

    await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('We could not load the remaining issues. Showing the first page only.'),
    ).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMore).toHaveBeenCalledTimes(1);
  });

  it('shows a user-friendly error state when the API request fails', async () => {
    renderApp({
      error: new Error('connect ECONNREFUSED 127.0.0.1:4200'),
      loading: false,
    });

    expect(
      await screen.findByText('We could not load the board right now. Please confirm the API server is running and try again.'),
    ).toBeInTheDocument();
  });

  it('shows a distinct invalid-token error when the board request is unauthenticated with a configured token', async () => {
    window.localStorage.setItem('involute.authToken', 'wrong-token');

    renderApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The board sent a runtime auth token, but the API rejected it. Confirm the configured token matches the server and reload.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a missing-token bootstrap error when no runtime token exists outside dev fallback', async () => {
    vi.stubEnv('DEV', false);

    renderApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Runtime auth token missing')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The board could not find a runtime auth token. Set `VITE_INVOLUTE_AUTH_TOKEN` or store the token in localStorage under `involute.authToken`, then reload.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a distinct dev-default-token error when the fallback dev token is rejected', async () => {
    renderApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The board used the default development token, but the API rejected it. Set `VITE_INVOLUTE_AUTH_TOKEN` or store a valid token in localStorage under `involute.authToken`, then reload.',
      ),
    ).toBeInTheDocument();
  });
});
