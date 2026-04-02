import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { getAuthToken } from './lib/apollo';
import { getDropTargetStateId } from './routes/BoardPage';
import type {
  BoardPageQueryData,
  CommentCreateMutationData,
  IssueCreateMutationData,
  IssueSummary,
  IssueUpdateMutationData,
} from './board/types';
import type { DragEndEvent } from '@dnd-kit/core';

const apolloMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn((document) => {
    const source = String(document);

    if (source.includes('mutation CommentCreate')) {
      return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
    }

    return [vi.fn()];
  }),
}));

vi.mock('@apollo/client/react', async () => {
  const actual = await vi.importActual<typeof import('@apollo/client/react')>('@apollo/client/react');

  return {
    ...actual,
    useQuery: apolloMocks.useQuery,
    useMutation: apolloMocks.useMutation,
  };
});

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');

  return {
    ...actual,
    DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useSensor: vi.fn(() => ({})),
    useSensors: vi.fn(() => []),
  };
});

beforeEach(() => {
  apolloMocks.useQuery.mockReset();
  apolloMocks.useMutation.mockReset();
  apolloMocks.useMutation.mockImplementation((document) => {
    const source = String(document);

    if (source.includes('mutation CommentCreate')) {
      return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
    }

    return [vi.fn()];
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

const boardQueryResult: BoardPageQueryData = {
  teams: {
    nodes: [
      {
        id: 'team-1',
        key: 'INV',
        name: 'Involute',
        states: {
          nodes: [
            { id: 'state-backlog', name: 'Backlog' },
            { id: 'state-ready', name: 'Ready' },
            { id: 'state-progress', name: 'In Progress' },
            { id: 'state-review', name: 'In Review' },
            { id: 'state-done', name: 'Done' },
            { id: 'state-canceled', name: 'Canceled' },
          ],
        },
      },
      {
        id: 'team-2',
        key: 'SON',
        name: 'Sonata',
        states: {
          nodes: [
            { id: 'son-backlog', name: 'Backlog' },
            { id: 'son-ready', name: 'Ready' },
            { id: 'son-progress', name: 'In Progress' },
            { id: 'son-review', name: 'In Review' },
            { id: 'son-done', name: 'Done' },
            { id: 'son-canceled', name: 'Canceled' },
          ],
        },
      },
    ],
  },
  users: {
    nodes: [
      {
        id: 'user-1',
        name: 'Admin',
        email: 'admin@involute.local',
      },
    ],
  },
  issueLabels: {
    nodes: [
      { id: 'label-task', name: 'task' },
      { id: 'label-bug', name: 'Bug' },
      { id: 'label-feature', name: 'Feature' },
    ],
  },
  issues: {
    nodes: [
      {
        id: 'issue-1',
        identifier: 'INV-1',
        title: 'Backlog item',
        description: 'Backlog description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-backlog', name: 'Backlog' },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-task', name: 'task' }] },
        assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
        children: { nodes: [] },
        parent: null,
        comments: { nodes: [] },
      },
      {
        id: 'issue-2',
        identifier: 'INV-2',
        title: 'Ready item',
        description: 'Ready description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-ready', name: 'Ready' },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-bug', name: 'Bug' }] },
        assignee: null,
        children: { nodes: [] },
        parent: {
          id: 'issue-1',
          identifier: 'INV-1',
          title: 'Backlog item',
        },
        comments: { nodes: [] },
      },
      {
        id: 'issue-3',
        identifier: 'SON-1',
        title: 'Sonata backlog item',
        description: 'Sonata description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'son-backlog', name: 'Backlog' },
        team: { id: 'team-2', key: 'SON' },
        labels: { nodes: [{ id: 'label-feature', name: 'Feature' }] },
        assignee: null,
        children: { nodes: [] },
        parent: null,
        comments: { nodes: [] },
      },
    ],
  },
};

function renderApp(queryState: {
  data?: BoardPageQueryData;
  error?: Error;
  loading?: boolean;
} = {
  data: boardQueryResult,
  loading: false,
}, initialEntries: string[] = ['/']) {
  apolloMocks.useQuery.mockImplementation((_, options) => {
    if (options?.variables && 'id' in options.variables) {
      const issueId = String(options.variables.id);
      return {
        data: {
          issue: queryState.data?.issues.nodes.find((issue) => issue.id === issueId) ?? null,
          users: queryState.data?.users ?? { nodes: [] },
          issueLabels: queryState.data?.issueLabels ?? { nodes: [] },
        },
        error: queryState.error,
        loading: queryState.loading ?? false,
      };
    }

    return {
      data: queryState.data,
      error: queryState.error,
      loading: queryState.loading ?? false,
    };
  });

  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('resolves a drag-end drop target from the destination card column state', () => {
    const event = {
      active: { id: 'issue-1' },
      over: {
        id: 'issue-2',
        data: {
          current: {
            issue: boardQueryResult.issues.nodes[1],
            stateId: 'state-ready',
            type: 'issue-card',
          },
        },
      },
    } as unknown as DragEndEvent;

    expect(getDropTargetStateId(event)).toBe('state-ready');
  });

  it('falls back to the droppable column id when drag-end lands on a column body', () => {
    const event = {
      active: { id: 'issue-1' },
      over: {
        id: 'state-progress',
        data: {
          current: {
            stateId: 'state-progress',
            title: 'In Progress',
            type: 'column',
          },
        },
      },
    } as unknown as DragEndEvent;

    expect(getDropTargetStateId(event)).toBe('state-progress');
  });

  it('prefers the runtime localStorage auth token when creating Apollo requests', async () => {
    window.localStorage.setItem('involute.authToken', 'runtime-token');
    expect(getAuthToken()).toBe('runtime-token');
  });

  it('falls back to the default dev auth token when no runtime token is configured', () => {
    expect(getAuthToken()).toBe('changeme-set-your-token');
  });

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
        },
      },
      loading: false,
    });

    expect(await screen.findByText('No issues in Backlog yet.')).toBeInTheDocument();
    expect(screen.getByText('No issues in Canceled yet.')).toBeInTheDocument();
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

  it('shows an authentication/bootstrap specific error when the board request is unauthenticated', async () => {
    renderApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Authentication required')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The board could not find a runtime auth token. Set `VITE_INVOLUTE_AUTH_TOKEN` or store the token in localStorage under `involute.authToken`, then reload.',
      ),
    ).toBeInTheDocument();
  });

  it('renders comments in chronological order with author and timestamp details', async () => {
    renderApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              comments: {
                nodes: [
                  {
                    id: 'comment-2',
                    body: 'Second comment',
                    createdAt: '2026-04-02T11:00:00.000Z',
                    user: {
                      id: 'user-1',
                      name: 'Admin',
                      email: 'admin@involute.local',
                    },
                  },
                  {
                    id: 'comment-1',
                    body: 'First comment',
                    createdAt: '2026-04-02T10:00:00.000Z',
                    user: {
                      id: 'user-1',
                      name: 'Admin',
                      email: 'admin@involute.local',
                    },
                  },
                ],
              },
            },
            ...(boardQueryResult.issues.nodes.slice(1) as IssueSummary[]),
          ],
        },
      },
      loading: false,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const comments = within(drawer).getAllByRole('listitem');

    expect(comments).toHaveLength(2);
    const firstComment = comments[0]!;
    const secondComment = comments[1]!;
    expect(firstComment).toHaveTextContent('First comment');
    expect(secondComment).toHaveTextContent('Second comment');
    expect(within(firstComment).getByText('Admin')).toBeInTheDocument();
    expect(within(firstComment).getByText(/Apr/)).toBeInTheDocument();
  });

  it('shows an empty comments message when the issue has no comments', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(within(drawer).getByText('No comments yet. Start the discussion below.')).toBeInTheDocument();
  });

  it('enables comment submission only when comment body has text', async () => {
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const submitButton = within(drawer).getByRole('button', { name: 'Add comment' });

    expect(submitButton).toBeDisabled();

    fireEvent.change(within(drawer).getByLabelText('Comment body'), {
      target: { value: 'Freshly added comment' },
    });

    expect(submitButton).toBeEnabled();
  });

  it('submits a new comment and renders it at the bottom without a reload', async () => {
    const createComment = vi.fn().mockResolvedValue({
      data: {
        commentCreate: {
          success: true,
          comment: {
            id: 'comment-3',
            body: 'Newest comment',
            createdAt: '2026-04-02T12:00:00.000Z',
            user: {
              id: 'user-1',
              name: 'Admin',
              email: 'admin@involute.local',
            },
          },
        },
      } satisfies CommentCreateMutationData,
    });
    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : 'loc' in document && document.loc?.source.body
            ? document.loc.source.body
            : String(document);

      if (source.includes('mutation CommentCreate')) {
        return [createComment];
      }

      return [vi.fn()];
    });

    renderApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              comments: {
                nodes: [
                  {
                    id: 'comment-1',
                    body: 'Oldest comment',
                    createdAt: '2026-04-02T10:00:00.000Z',
                    user: {
                      id: 'user-1',
                      name: 'Admin',
                      email: 'admin@involute.local',
                    },
                  },
                ],
              },
            },
            ...(boardQueryResult.issues.nodes.slice(1) as IssueSummary[]),
          ],
        },
      },
      loading: false,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.change(within(drawer).getByLabelText('Comment body'), {
      target: { value: '  Newest comment  ' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add comment' }));

    await waitFor(() =>
      expect(createComment).toHaveBeenCalledWith({
        variables: {
          input: {
            issueId: 'issue-1',
            body: 'Newest comment',
          },
        },
      }),
    );

    await waitFor(() => {
      const comments = within(drawer).getAllByRole('listitem');
      expect(comments).toHaveLength(2);
      expect(comments[1]).toHaveTextContent('Newest comment');
    });

    expect(within(drawer).getByLabelText('Comment body')).toHaveValue('');
  });

  it('preserves locally added comments after a later issue update response omits comments', async () => {
    const createComment = vi.fn().mockResolvedValue({
      data: {
        commentCreate: {
          success: true,
          comment: {
            id: 'comment-3',
            body: 'Newest comment',
            createdAt: '2026-04-02T12:00:00.000Z',
            user: {
              id: 'user-1',
              name: 'Admin',
              email: 'admin@involute.local',
            },
          },
        },
      } satisfies CommentCreateMutationData,
    });
    const updateIssue = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            title: 'Retitled issue',
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

      if (source.includes('mutation CommentCreate')) {
        return [createComment];
      }

      if (source.includes('mutation IssueUpdate')) {
        return [updateIssue];
      }

      return [vi.fn()];
    });

    renderApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...(boardQueryResult.issues.nodes[0] as IssueSummary),
              comments: {
                nodes: [],
              },
            },
            ...(boardQueryResult.issues.nodes.slice(1) as IssueSummary[]),
          ],
        },
      },
      loading: false,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.change(within(drawer).getByLabelText('Comment body'), {
      target: { value: 'Newest comment' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add comment' }));

    await waitFor(() => expect(within(drawer).getByText('Newest comment')).toBeInTheDocument());

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.focus(titleInput);
    fireEvent.change(titleInput, { target: { value: 'Retitled issue' } });
    fireEvent.keyDown(titleInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    expect(within(drawer).getByText('Newest comment')).toBeInTheDocument();
  });

  it('navigates between board and backlog via header links', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Backlog' }));

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Identifier' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Board' }));

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
  });

  it('renders real issue details on the direct /issue/:id route', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/issue/issue-2']);

    expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();
    expect(screen.getByText('INV-2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ready item')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ready description')).toBeInTheDocument();
    expect(screen.getByText('INV-1 — Backlog item')).toBeInTheDocument();
  });

  it('renders backlog list rows and opens issue details from the table', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'INV-1' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Backlog item' }));

    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Backlog item');
  });

  it('keeps the shared header team selector on backlog and removes the duplicate backlog-only selector', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();

    const selectors = screen.getAllByLabelText('Select team');
    expect(selectors).toHaveLength(1);
    const sharedSelector = selectors[0]!;
    expect(sharedSelector).toHaveValue('INV');
    expect(within(sharedSelector).getAllByRole('option')).toHaveLength(2);
  });

  it('switches backlog rows when changing teams from the shared header selector', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    expect(await screen.findByText('Backlog item')).toBeInTheDocument();
    expect(screen.queryByText('Sonata backlog item')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    expect(await screen.findByText('Sonata backlog item')).toBeInTheDocument();
    expect(screen.queryByText('Backlog item')).not.toBeInTheDocument();
    expect(screen.getByText('List view for Sonata issues.')).toBeInTheDocument();
  });

  it('keeps board filtering in sync after changing teams and navigating from backlog', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    fireEvent.change(await screen.findByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    expect(await screen.findByText('Sonata backlog item')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Board' }));

    expect(await screen.findByText('Workflow overview for Sonata.')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-Backlog')).getByText('SON-1')).toBeInTheDocument();
    expect(screen.queryByText('INV-1')).not.toBeInTheDocument();
  });

  it('creates an issue from the board UI and shows it in the backlog column', async () => {
    const createIssue = vi.fn().mockResolvedValue({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: 'issue-3',
            identifier: 'INV-3',
            title: 'Created issue',
            description: 'Created description',
            createdAt: '2026-04-02T13:00:00.000Z',
            updatedAt: '2026-04-02T13:00:00.000Z',
            state: { id: 'state-backlog', name: 'Backlog' },
            team: { id: 'team-1', key: 'INV' },
            labels: { nodes: [] },
            assignee: null,
            children: { nodes: [] },
            parent: null,
            comments: { nodes: [] },
          },
        },
      } satisfies IssueCreateMutationData,
    });

    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : 'loc' in document && document.loc?.source.body
            ? document.loc.source.body
            : String(document);

      if (source.includes('mutation IssueCreate')) {
        return [createIssue];
      }

      if (source.includes('mutation CommentCreate')) {
        return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
      }

      return [vi.fn()];
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    fireEvent.change(within(dialog).getByLabelText('Issue title'), {
      target: { value: 'Created issue' },
    });
    fireEvent.change(within(dialog).getByLabelText('Issue description'), {
      target: { value: 'Created description' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));

    await waitFor(() =>
      expect(createIssue).toHaveBeenCalledWith({
        variables: {
          input: {
            teamId: 'team-1',
            title: 'Created issue',
            description: 'Created description',
          },
        },
      }),
    );

    expect(await within(screen.getByTestId('column-Backlog')).findByText('INV-3')).toBeInTheDocument();
    expect(screen.getByText('Created issue')).toBeInTheDocument();
  });
});
