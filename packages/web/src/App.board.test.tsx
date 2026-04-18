import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, dndMocks, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { BoardPageQueryData, IssueUpdateMutationData, IssueSummary } from './board/types';

function renderTestApp(
  queryState: {
    data: BoardPageQueryData;
    fetchMore?: ReturnType<typeof vi.fn>;
    loading: boolean;
  } = { data: boardQueryResult, loading: false },
  initialEntries: string[] = ['/'],
) {
  return renderApp(App, queryState, initialEntries);
}

describe('App board UI', () => {
  it('renders all six board columns in order', async () => {
    renderTestApp();

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
    renderTestApp();

    const backlogColumn = await screen.findByTestId('column-Backlog');
    const readyColumn = screen.getByTestId('column-Ready');

    expect(within(backlogColumn).getByText('INV-1')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('Backlog item')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('task')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('Admin')).toBeInTheDocument();
    expect(within(readyColumn).getByText('INV-2')).toBeInTheDocument();
    expect(within(readyColumn).getByText('Ready item')).toBeInTheDocument();
  });

  it('renders custom team workflow states as board columns instead of dropping them', async () => {
    const customStateData: BoardPageQueryData = {
      ...boardQueryResult,
      teams: {
        nodes: [
          {
            id: 'team-1',
            key: 'INV',
            name: 'Involute',
            states: {
              nodes: [
                { id: 'state-triage', name: 'Triage' },
                { id: 'state-todo', name: 'Todo' },
                { id: 'state-progress', name: 'In Progress' },
                { id: 'state-done', name: 'Done' },
              ],
            },
          },
        ],
      },
      issues: {
        nodes: [
          {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            id: 'issue-triage',
            identifier: 'INV-10',
            title: 'Triage item',
            state: { id: 'state-triage', name: 'Triage' },
            team: { id: 'team-1', key: 'INV' },
          },
          {
            ...(boardQueryResult.issues.nodes[1] as IssueSummary),
            id: 'issue-todo',
            identifier: 'INV-11',
            title: 'Todo item',
            state: { id: 'state-todo', name: 'Todo' },
            team: { id: 'team-1', key: 'INV' },
          },
        ],
        pageInfo: boardQueryResult.issues.pageInfo,
      },
    };

    renderTestApp({ data: customStateData, loading: false });

    const headers = await screen.findAllByRole('heading', { level: 2 });
    expect(headers.map((header) => header.textContent)).toEqual(['In Progress', 'Done', 'Todo', 'Triage']);
    expect(within(screen.getByTestId('column-Triage')).getByText('INV-10')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-Todo')).getByText('INV-11')).toBeInTheDocument();
  });

  it('reverts a preview-only drag when the drop ends outside a valid column and skips the mutation', async () => {
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

    renderTestApp();

    const contextProps = dndMocks.lastContextProps as {
      onDragEnd?: (event: unknown) => void;
      onDragOver?: (event: unknown) => void;
      onDragStart?: (event: unknown) => void;
    } | null;

    expect(contextProps?.onDragStart).toBeTypeOf('function');
    expect(contextProps?.onDragOver).toBeTypeOf('function');
    expect(contextProps?.onDragEnd).toBeTypeOf('function');

    await act(async () => {
      contextProps?.onDragStart?.({
        active: { id: 'issue-1' },
      });
    });

    await act(async () => {
      contextProps?.onDragOver?.({
        active: { id: 'issue-1' },
        over: {
          id: 'state-ready',
          data: {
            current: {
              stateId: 'state-ready',
              title: 'Ready',
              type: 'column',
            },
          },
        },
      });
    });

    expect(within(screen.getByTestId('column-Ready')).getByText('INV-1')).toBeInTheDocument();

    const latestContextProps = dndMocks.lastContextProps as {
      onDragEnd?: (event: unknown) => void;
    } | null;

    await act(async () => {
      latestContextProps?.onDragEnd?.({
        active: { id: 'issue-1' },
        over: null,
      });
    });

    await waitFor(() =>
      expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId('column-Ready')).queryByText('INV-1')).not.toBeInTheDocument();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('renders stable drag surfaces and state-id based droppable selectors for board automation', async () => {
    renderTestApp();

    expect(await screen.findByTestId('issue-drag-surface-INV-1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-drag-surface-INV-2')).toBeInTheDocument();

    expect(screen.getByTestId('board-column-state-backlog')).toHaveAttribute('data-state-id', 'state-backlog');
    expect(screen.getByTestId('board-column-state-ready')).toHaveAttribute('data-state-id', 'state-ready');
    expect(screen.getByTestId('column-Backlog')).toHaveAttribute('data-droppable-state-id', 'state-backlog');
    expect(screen.getByTestId('column-Ready')).toHaveAttribute('data-droppable-state-id', 'state-ready');
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('draggable', 'true');
  });

  it('loads the next page only when the user explicitly asks for more issues', async () => {
    const fetchMore = vi.fn().mockResolvedValue(undefined);

    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          ...boardQueryResult.issues,
          pageInfo: {
            endCursor: 'cursor-2',
            hasNextPage: true,
          },
        },
      },
      fetchMore,
      loading: false,
    });

    expect(fetchMore).not.toHaveBeenCalled();

    const loadMoreButton = await screen.findByRole('button', { name: 'Load more issues' });
    await act(async () => {
      loadMoreButton.click();
    });

    await waitFor(() =>
      expect(fetchMore).toHaveBeenCalledWith({
        variables: {
          first: 200,
          after: 'cursor-2',
          filter: {
            team: {
              key: {
                eq: 'INV',
              },
            },
          },
        },
        updateQuery: expect.any(Function),
      }),
    );
  });
});
