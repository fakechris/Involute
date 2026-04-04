import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import {
  COMMENT_CREATE_MUTATION,
  COMMENT_DELETE_MUTATION,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
} from './board/queries';
import type { BoardPageQueryData, IssueSummary } from './board/types';

const apolloMocks = vi.hoisted(() => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock('@apollo/client/react', async () => {
  const actual = await vi.importActual<typeof import('@apollo/client/react')>('@apollo/client/react');

  return {
    ...actual,
    useMutation: apolloMocks.useMutation,
    useQuery: apolloMocks.useQuery,
  };
});

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');

  return {
    ...actual,
    DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    useSensor: vi.fn(() => ({})),
    useSensors: vi.fn(() => []),
  };
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
            { id: 'state-done', name: 'Done' },
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
      { id: 'label-feature', name: 'Feature' },
    ],
  },
  issues: {
    nodes: [
      {
        id: 'issue-1',
        identifier: 'INV-1',
        title: 'Mutable issue',
        description: 'Initial description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-backlog', name: 'Backlog' },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-feature', name: 'Feature' }] },
        assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
        children: { nodes: [] },
        parent: null,
        comments: {
          nodes: [
            {
              id: 'comment-1',
              body: 'Disposable comment',
              createdAt: '2026-04-02T10:30:00.000Z',
              user: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
            },
          ],
        },
      } satisfies IssueSummary,
    ],
  },
};

function renderApp() {
  apolloMocks.useQuery.mockImplementation((_, options) => {
    if (options?.variables && 'id' in options.variables) {
      const issueId = String(options.variables.id);

      return {
        data: {
          issue: boardQueryResult.issues.nodes.find((issue) => issue.id === issueId) ?? null,
          issueLabels: boardQueryResult.issueLabels,
          users: boardQueryResult.users,
        },
        error: undefined,
        loading: false,
      };
    }

    return {
      data: boardQueryResult,
      error: undefined,
      loading: false,
    };
  });

  return render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apolloMocks.useQuery.mockReset();
  apolloMocks.useMutation.mockReset();
  apolloMocks.useMutation.mockImplementation((document) => {
    if (document === COMMENT_DELETE_MUTATION) {
      return [vi.fn().mockResolvedValue({ data: { commentDelete: { success: true, commentId: 'comment-1' } } })];
    }

    if (document === COMMENT_CREATE_MUTATION) {
      return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
    }

    if (document === ISSUE_UPDATE_MUTATION || document === ISSUE_CREATE_MUTATION) {
      return [vi.fn()];
    }

    return [vi.fn()];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('App delete flows', () => {
  it('deletes a comment from the issue drawer', async () => {
    const deleteComment = vi.fn().mockResolvedValue({
      data: {
        commentDelete: {
          success: true,
          commentId: 'comment-1',
        },
      },
    });

    apolloMocks.useMutation.mockImplementation((document) => {
      if (document === COMMENT_DELETE_MUTATION) {
        return [deleteComment];
      }

      if (document === COMMENT_CREATE_MUTATION) {
        return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
      }

      return [vi.fn()];
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderApp();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Open INV-1' }))[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete comment' }));

    await waitFor(() =>
      expect(deleteComment).toHaveBeenCalledWith({
        variables: {
          id: 'comment-1',
        },
      }),
    );
    await waitFor(() =>
      expect(within(drawer).queryByText('Disposable comment')).not.toBeInTheDocument(),
    );
  });
});
