import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, dndMocks, renderApp } from './test/app-test-helpers';
import { SHORTCUT_SECTIONS } from './app/KeyboardShortcutsDialog';
import { App } from './App';
import type { BoardPageQueryData, IssueSummary, IssueUpdateMutationData } from './board/types';
import { getStatusUndoSnapshot, recordStatusGesture, resetStatusUndo } from './undo/status-undo';

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

function mutationSource(document: unknown) {
  return typeof document === 'string'
    ? document
    : document && typeof document === 'object' && 'loc' in document && document.loc && typeof document.loc === 'object' && 'source' in document.loc && document.loc.source && typeof document.loc.source === 'object' && 'body' in document.loc.source
      ? String(document.loc.source.body)
      : String(document);
}

function installStatusUpdateMock(
  conflictOn?: (variables: { id: string; input: { stateId?: string } }) => boolean,
  extras: IssueSummary[] = [],
) {
  const catalog = [...boardQueryResult.issues.nodes, ...extras];
  const updateIssue = vi.fn(async (options: { variables: { id: string; input: { stateId?: string; expectedRevision?: number } } }) => {
    const variables = options.variables;
    const sourceIssue = catalog.find((issue) => issue.id === variables.id);
    const state = boardQueryResult.teams.nodes
      .flatMap((team) => team.states.nodes)
      .find((item) => item.id === variables.input.stateId);
    if (!sourceIssue || !state || conflictOn?.(variables)) {
      return { data: { issueUpdate: { success: false, message: 'revision conflict', issue: null } } };
    }
    return {
      data: {
        issueUpdate: {
          success: true,
          message: null,
          issue: {
            ...sourceIssue,
            revision: (variables.input.expectedRevision ?? sourceIssue.revision) + 1,
            state,
          },
        },
      },
    };
  });

  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    if (mutationSource(document).includes('mutation IssueUpdate')) {
      return [updateIssue];
    }
    return [vi.fn()];
  });
  return updateIssue;
}

async function dragIssue(issueId: string, targetStateId: string) {
  const props = () => dndMocks.lastContextProps as {
    onDragStart?: (event: unknown) => void;
    onDragOver?: (event: unknown) => void;
    onDragEnd?: (event: unknown) => void;
  } | null;
  const over = {
    id: targetStateId,
    data: { current: { stateId: targetStateId, type: 'column' } },
  };
  await act(async () => {
    props()?.onDragStart?.({ active: { id: issueId } });
  });
  await act(async () => {
    props()?.onDragOver?.({ active: { id: issueId }, over });
  });
  await act(async () => {
    props()?.onDragEnd?.({ active: { id: issueId }, over });
  });
}

describe('board status undo', () => {
  it('names a dragged issue and puts it back, selected, from the toast or ⌘Z', async () => {
    const updateIssue = installStatusUpdateMock();
    renderTestApp();
    expect(await screen.findByText('INV-1')).toBeInTheDocument();

    await dragIssue('issue-1', 'state-ready');

    const toast = await screen.findByTestId('status-undo-toast');
    expect(toast).toHaveTextContent('INV-1 moved to Ready');
    expect(within(screen.getByTestId('column-Ready')).getByText('INV-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getByRole('button', { name: /Undo · INV-1 moved to Ready/ })).toBeInTheDocument();
    expect(within(palette).getByRole('button', { name: /^Redo/ })).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole('button', { name: 'Close command palette' }));

    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-selected', 'true');
    expect(updateIssue).toHaveBeenLastCalledWith({
      variables: {
        id: 'issue-1',
        input: { expectedRevision: 2, stateId: 'state-backlog' },
      },
    });

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(within(screen.getByTestId('column-Ready')).getByText('INV-1')).toBeInTheDocument();
    });
    expect(updateIssue).toHaveBeenLastCalledWith({
      variables: {
        id: 'issue-1',
        input: { expectedRevision: 3, stateId: 'state-ready' },
      },
    });

    const callsBeforeTyping = updateIssue.mock.calls.length;
    const search = document.createElement('input');
    document.body.appendChild(search);
    search.focus();
    fireEvent.keyDown(search, { key: 'z', metaKey: true });
    search.remove();
    expect(updateIssue.mock.calls.length).toBe(callsBeforeTyping);
    expect(within(screen.getByTestId('column-Ready')).getByText('INV-1')).toBeInTheDocument();

    const labels = SHORTCUT_SECTIONS.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).toEqual(expect.arrayContaining(['Undo', 'Redo']));
  });

  it('undoes only the latest drag when several issues were moved', async () => {
    installStatusUpdateMock();
    renderTestApp();
    expect(await screen.findByText('INV-1')).toBeInTheDocument();

    await dragIssue('issue-1', 'state-ready');
    await screen.findByText('INV-1 moved to Ready');
    await dragIssue('issue-2', 'state-progress');
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-2 moved to In Progress');

    fireEvent.keyDown(window, { key: 'z', metaKey: true });

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Ready')).getByText('INV-2')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('column-Ready')).getByText('INV-1')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-In Progress')).queryByText('INV-2')).not.toBeInTheDocument();
  });

  it('treats a bulk move as one undo and names the issue that conflicted', async () => {
    const issue4: IssueSummary = {
      ...(boardQueryResult.issues.nodes[0] as IssueSummary),
      id: 'issue-4',
      identifier: 'INV-4',
      title: 'Fourth backlog item',
    };
    const updateIssue = installStatusUpdateMock(
      (variables) => variables.id === 'issue-2' && variables.input.stateId === 'state-ready',
      [issue4],
    );
    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          ...boardQueryResult.issues,
          nodes: [...boardQueryResult.issues.nodes, issue4],
        },
      },
      loading: false,
    });
    expect(await screen.findByText('INV-4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select INV-1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select INV-2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select INV-4' }));
    fireEvent.change(screen.getByLabelText('Bulk move selected issues to state'), {
      target: { value: 'state-canceled' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to selected' }));

    const moved = await screen.findByTestId('status-undo-toast');
    expect(moved).toHaveTextContent('moved to Canceled');
    expect(moved).toHaveTextContent('INV-1');
    expect(moved).toHaveTextContent('INV-2');
    expect(moved).toHaveTextContent('INV-4');
    expect(updateIssue).toHaveBeenCalledTimes(3);

    fireEvent.click(within(screen.getByTestId('status-undo-toast')).getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('Could not change INV-2');
    });
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-4')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-Canceled')).getByText('INV-2')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('issue-card-issue-2')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('issue-card-issue-4')).toHaveAttribute('data-selected', 'true');
    expect(updateIssue).toHaveBeenCalledTimes(6);
  });
});

describe('status undo stack', () => {
  it('keeps the latest fifty gestures', () => {
    resetStatusUndo();
    for (let index = 0; index < 51; index += 1) {
      recordStatusGesture([
        {
          issueId: `issue-${index}`,
          identifier: `INV-${index}`,
          stateId: 'state-ready',
          stateName: 'Ready',
          previousStateId: 'state-backlog',
          previousStateName: 'Backlog',
          revision: 2,
        },
      ]);
    }
    const capped = getStatusUndoSnapshot();
    const first = capped.undo[0];
    const last = capped.undo[49];
    expect(capped.undo).toHaveLength(50);
    expect(first && 'changes' in first ? first.changes[0]?.identifier : '').toBe('INV-1');
    expect(last && 'changes' in last ? last.changes[0]?.identifier : '').toBe('INV-50');
    expect(capped.redo).toHaveLength(0);
  });
});
