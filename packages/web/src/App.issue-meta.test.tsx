import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueUpdateMutationData } from './board/types';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App issue metadata flows', () => {
  it('adds labels and changes assignee via issueUpdate mutation', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...getIssue('issue-1'),
              labels: {
                nodes: [
                  { id: 'label-task', name: 'task' },
                  { id: 'label-feature', name: 'Feature' },
                ],
              },
            },
          },
        } satisfies IssueUpdateMutationData,
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...getIssue('issue-1'),
              assignee: null,
            },
          },
        } satisfies IssueUpdateMutationData,
      });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

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
            ...getIssue('issue-1'),
            labels: {
              nodes: [],
            },
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

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

  it('shows an error and reverts optimistic move when state mutation fails', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('boom'));
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-progress' },
    });

    expect(
      (await screen.findAllByText('We could not save the issue changes. Please try again.')).length,
    ).toBeGreaterThan(0);
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
  });

  it('keeps a within-column state change as a no-op', async () => {
    const mutate = vi.fn();
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-backlog' },
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
  });

  it('renders six empty columns without crashing when there are no issues', async () => {
    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [],
        },
      },
      loading: false,
    });

    expect(await screen.findByText('No issues in Backlog yet.')).toBeInTheDocument();
    expect(screen.getByText('No issues in Canceled yet.')).toBeInTheDocument();
  });

  it('shows "No labels available" message when labels array is empty', async () => {
    renderTestApp({
      data: {
        ...boardQueryResult,
        issueLabels: { nodes: [] },
      },
      loading: false,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(within(drawer).getByText('No labels available')).toBeInTheDocument();
  });

  it('deletes an issue from the board after confirmation', async () => {
    const deleteIssue = vi.fn().mockResolvedValue({
      data: {
        issueDelete: {
          success: true,
          issueId: 'issue-1',
        },
      },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

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

      if (source.includes('mutation CommentCreate')) {
        return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
      }

      return [vi.fn()];
    });

    renderTestApp();

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
    expect(screen.queryByText('Backlog item')).not.toBeInTheDocument();

    confirmSpy.mockRestore();
  });
});
