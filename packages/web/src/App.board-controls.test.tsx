import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp, type IssueUpdateMutationData } from './test/app-test-helpers';
import type { BoardPageQueryData, IssueSummary } from './board/types';

describe('App board controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('filters board issues and can save then reload a saved view', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Bug queue');

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    const filters = screen.getByLabelText('Board filters');
    fireEvent.click(within(filters).getByText('Labels'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bug' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove Label: Bug' })).toBeInTheDocument();
      expect(within(screen.getByTestId('column-Ready')).getByText('Ready item')).toBeInTheDocument();
      expect(within(screen.getByTestId('column-Backlog')).queryByTestId('issue-card-issue-1')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(screen.getByRole('option', { name: 'Bug queue' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Backlog')).getByText('Backlog item')).toBeInTheDocument();
      expect(within(screen.getByTestId('column-Ready')).getByText('Ready item')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Load saved board view'), {
      target: { value: screen.getByRole('option', { name: 'Bug queue' }).getAttribute('value') },
    });

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Ready')).getByText('Ready item')).toBeInTheDocument();
      expect(within(screen.getByTestId('column-Backlog')).queryByTestId('issue-card-issue-1')).not.toBeInTheDocument();
    });
  });

  it('sorts issues inside a board column using the selected sort field and direction', async () => {
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
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
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

    renderApp({ data: customData, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Sort board by'), {
      target: { value: 'title' },
    });
    fireEvent.change(screen.getByLabelText('Sort board direction'), {
      target: { value: 'desc' },
    });

    const backlogCards = within(screen.getByTestId('column-Backlog'))
      .getAllByTestId(/issue-card-/)
      .map((card) => within(card).getByRole('heading', { level: 3 }).textContent);

    expect(backlogCards).toEqual(['Zulu task', 'Delta task', 'Alpha task']);
  });

  it('supports keyboard selection and bulk move for board issues', async () => {
    const updateIssue = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            state: { id: 'state-ready', name: 'Ready' },
          },
        },
      } satisfies IssueUpdateMutationData,
    });

    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : 'loc' in document && document.loc?.source.body
            ? document.loc.source.body
            : String(document);

      if (source.includes('mutation IssueUpdate')) {
        return [updateIssue];
      }

      return [vi.fn()];
    });

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-focused', 'true');

    fireEvent.keyDown(window, { key: 'x' });
    expect(screen.getByRole('checkbox', { name: 'Select INV-1' })).toBeChecked();

    fireEvent.change(screen.getByLabelText('Bulk move selected issues to state'), {
      target: { value: 'state-ready' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to selected' }));

    await waitFor(() =>
      expect(updateIssue).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: {
            stateId: 'state-ready',
          },
        },
      }),
    );
  });

  it('focuses board search with slash and clears it with Escape', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    const searchInput = await screen.findByLabelText('Search board issues');
    fireEvent.keyDown(window, { key: '/' });
    expect(searchInput).toHaveFocus();

    fireEvent.change(searchInput, {
      target: { value: 'Ready' },
    });
    expect(searchInput).toHaveValue('Ready');

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(searchInput).toHaveValue('');
  });

  it('applies bulk assignee and bulk label actions to the selected issues', async () => {
    const updateIssue = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              assignee: null,
            },
          },
        } satisfies IssueUpdateMutationData,
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              assignee: null,
              labels: {
                nodes: [
                  ...(boardQueryResult.issues.nodes[0] as IssueSummary).labels.nodes,
                  { id: 'label-bug', name: 'Bug' },
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
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              assignee: null,
              labels: {
                nodes: [{ id: 'label-bug', name: 'Bug' }],
              },
            },
          },
        } satisfies IssueUpdateMutationData,
      });

    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : 'loc' in document && document.loc?.source.body
            ? document.loc.source.body
            : String(document);

      if (source.includes('mutation IssueUpdate')) {
        return [updateIssue];
      }

      return [vi.fn()];
    });

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'x' });

    fireEvent.change(screen.getByLabelText('Bulk assign selected issues'), {
      target: { value: 'unassigned' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply assignee' }));

    await waitFor(() =>
      expect(updateIssue).toHaveBeenNthCalledWith(1, {
        variables: {
          id: 'issue-1',
          input: {
            assigneeId: null,
          },
        },
      }),
    );

    fireEvent.change(screen.getByLabelText('Bulk add label to selected issues'), {
      target: { value: 'label-bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));

    await waitFor(() =>
      expect(updateIssue).toHaveBeenNthCalledWith(2, {
        variables: {
          id: 'issue-1',
          input: {
            labelIds: ['label-bug', 'label-task'],
          },
        },
      }),
    );

    fireEvent.change(screen.getByLabelText('Bulk remove label from selected issues'), {
      target: { value: 'label-task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove label' }));

    await waitFor(() =>
      expect(updateIssue).toHaveBeenNthCalledWith(3, {
        variables: {
          id: 'issue-1',
          input: {
            labelIds: ['label-bug'],
          },
        },
      }),
    );
  });

  it('lets the user remove active board filters from the summary tokens', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    const filters = screen.getByLabelText('Board filters');
    fireEvent.click(within(filters).getByText('Labels'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bug' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove Label: Bug' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Label: Bug' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove Label: Bug' })).not.toBeInTheDocument();
      expect(within(screen.getByTestId('column-Backlog')).getByText('Backlog item')).toBeInTheDocument();
    });
  });
});
