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
                { id: 'state-triage', name: 'Triage', type: 'BACKLOG', position: 0 },
                { id: 'state-todo', name: 'Todo', type: 'UNSTARTED', position: 1 },
                { id: 'state-progress', name: 'In Progress', type: 'STARTED', position: 2 },
                { id: 'state-done', name: 'Done', type: 'COMPLETED', position: 3 },
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
            state: { id: 'state-triage', name: 'Triage', type: 'BACKLOG', position: 0 },
            team: { id: 'team-1', key: 'INV' },
          },
          {
            ...(boardQueryResult.issues.nodes[1] as IssueSummary),
            id: 'issue-todo',
            identifier: 'INV-11',
            title: 'Todo item',
            state: { id: 'state-todo', name: 'Todo', type: 'UNSTARTED', position: 1 },
            team: { id: 'team-1', key: 'INV' },
          },
        ],
        pageInfo: boardQueryResult.issues.pageInfo,
      },
    };

    renderTestApp({ data: customStateData, loading: false });

    const headers = await screen.findAllByRole('heading', { level: 2 });
    // Columns order by state group (backlog → unstarted → started → review →
    // completed → canceled), so custom names land in the right section.
    expect(headers.map((header) => header.textContent)).toEqual(['Triage', 'Todo', 'In Progress', 'Done']);
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
            state: { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
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
          teamFilter: {
            key: {
              eq: 'INV',
            },
          },
          filter: {
            commitmentStatus: 'COMMITTED',
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

  it('moves an issue to Done via drag-and-drop and keeps it visible in Done with project filter active', async () => {
    const updateIssue = vi.fn().mockImplementation(({ variables }) => {
      const is104 = variables.id === 'issue-104';
      const identifier = is104 ? 'INV-104' : 'INV-105';
      const title = is104 ? 'Task 104' : 'Task 105';
      return Promise.resolve({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              id: variables.id,
              identifier,
              title,
              repository: 'fakechris/Involute',
              state: { id: 'state-done', name: 'Done', type: 'COMPLETED', position: 4 },
            },
          },
        } satisfies IssueUpdateMutationData,
      });
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

    const projectData: BoardPageQueryData = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: [
          {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            id: 'issue-104',
            identifier: 'INV-104',
            title: 'Task 104',
            repository: 'fakechris/Involute',
            state: { id: 'state-review', name: 'In Review', type: 'REVIEW', position: 3 },
          },
          {
            ...(boardQueryResult.issues.nodes[1] as IssueSummary),
            id: 'issue-105',
            identifier: 'INV-105',
            title: 'Task 105',
            repository: 'fakechris/Involute',
            state: { id: 'state-review', name: 'In Review', type: 'REVIEW', position: 3 },
          },
        ],
      },
    };

    renderTestApp({ data: projectData, loading: false }, ['/?project=fakechris%2FInvolute']);

    const contextProps = dndMocks.lastContextProps as {
      onDragEnd?: (event: unknown) => void;
      onDragOver?: (event: unknown) => void;
      onDragStart?: (event: unknown) => void;
    } | null;

    // Drag INV-104 from In Review to Done
    await act(async () => {
      contextProps?.onDragStart?.({ active: { id: 'issue-104' } });
    });

    await act(async () => {
      contextProps?.onDragOver?.({
        active: { id: 'issue-104' },
        over: {
          id: 'state-done',
          data: {
            current: {
              stateId: 'state-done',
              title: 'Done',
              type: 'column',
            },
          },
        },
      });
    });

    await act(async () => {
      contextProps?.onDragEnd?.({
        active: { id: 'issue-104' },
        over: {
          id: 'state-done',
          data: {
            current: {
              stateId: 'state-done',
              title: 'Done',
              type: 'column',
            },
          },
        },
      });
    });

    // INV-104 must NOT disappear! It must be in the Done column!
    await waitFor(() => {
      expect(within(screen.getByTestId('column-Done')).getByText('INV-104')).toBeInTheDocument();
    });

    // Now drag INV-105 to Done
    await act(async () => {
      contextProps?.onDragStart?.({ active: { id: 'issue-105' } });
    });

    await act(async () => {
      contextProps?.onDragOver?.({
        active: { id: 'issue-105' },
        over: {
          id: 'state-done',
          data: {
            current: {
              stateId: 'state-done',
              title: 'Done',
              type: 'column',
            },
          },
        },
      });
    });

    await act(async () => {
      contextProps?.onDragEnd?.({
        active: { id: 'issue-105' },
        over: {
          id: 'state-done',
          data: {
            current: {
              stateId: 'state-done',
              title: 'Done',
              type: 'column',
            },
          },
        },
      });
    });

    // Both INV-104 and INV-105 must be in the Done column! Neither disappeared!
    await waitFor(() => {
      expect(within(screen.getByTestId('column-Done')).getByText('INV-104')).toBeInTheDocument();
      expect(within(screen.getByTestId('column-Done')).getByText('INV-105')).toBeInTheDocument();
    });
  });
});
