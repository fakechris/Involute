import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { CommentCreateMutationData, IssueSummary, IssueUpdateMutationData } from './board/types';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App comments', () => {
  it('renders comments in chronological order with author and timestamp details', async () => {
    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...getIssue('issue-1'),
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
          pageInfo: boardQueryResult.issues.pageInfo,
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
    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(within(drawer).getByText('No comments yet. Start the discussion below.')).toBeInTheDocument();
  });

  it('enables comment submission only when comment body has text', async () => {
    renderTestApp();

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

    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...getIssue('issue-1'),
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
          pageInfo: boardQueryResult.issues.pageInfo,
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
            ...getIssue('issue-1'),
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

    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...getIssue('issue-1'),
              comments: {
                nodes: [],
              },
            },
            ...(boardQueryResult.issues.nodes.slice(1) as IssueSummary[]),
          ],
          pageInfo: boardQueryResult.issues.pageInfo,
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

  it('deletes a comment from the drawer after confirmation', async () => {
    const deleteComment = vi.fn().mockResolvedValue({
      data: {
        commentDelete: {
          success: true,
          commentId: 'comment-1',
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

      if (source.includes('mutation CommentDelete')) {
        return [deleteComment];
      }

      if (source.includes('mutation CommentCreate')) {
        return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
      }

      return [vi.fn()];
    });

    renderTestApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [
            {
              ...getIssue('issue-1'),
              comments: {
                nodes: [
                  {
                    id: 'comment-1',
                    body: 'Disposable comment',
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
          pageInfo: boardQueryResult.issues.pageInfo,
        },
      },
      loading: false,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Delete comment' })[0]!);

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

    confirmSpy.mockRestore();
  });
});
