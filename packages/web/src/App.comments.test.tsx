import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  apolloMocks,
  boardQueryResult,
  type CommentDeleteMutationData,
  renderApp,
  type CommentCreateMutationData,
  type IssueSummary,
  type IssueUpdateMutationData,
} from './test/app-test-helpers';
import { mergeIssueWithPreservedComments } from './routes/BoardPage';

describe('App comments', () => {
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

  it('deletes a comment and removes it from the drawer without a reload', async () => {
    const deleteComment = vi.fn().mockResolvedValue({
      data: {
        commentDelete: {
          success: true,
          commentId: 'comment-1',
        },
      } satisfies CommentDeleteMutationData,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
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
                    body: 'Delete me',
                    createdAt: '2026-04-02T10:00:00.000Z',
                    user: {
                      id: 'user-1',
                      name: 'Admin',
                      email: 'admin@involute.local',
                    },
                  },
                  {
                    id: 'comment-2',
                    body: 'Keep me',
                    createdAt: '2026-04-02T11:00:00.000Z',
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

    await waitFor(() => expect(within(drawer).queryByText('Delete me')).not.toBeInTheDocument());
    expect(within(drawer).getByText('Keep me')).toBeInTheDocument();
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

  it('mergeIssueWithPreservedComments handles undefined comments gracefully', () => {
    const previousIssue: IssueSummary = {
      ...(boardQueryResult.issues.nodes[0] as IssueSummary),
      comments: {
        nodes: [
          {
            id: 'comment-1',
            body: 'Previous comment',
            createdAt: '2026-04-02T10:00:00.000Z',
            user: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
          },
        ],
      },
    };
    const nextIssue = {
      ...(boardQueryResult.issues.nodes[0] as IssueSummary),
      title: 'Updated title',
    } as IssueSummary;
    delete (nextIssue as unknown as Record<string, unknown>).comments;

    const merged = mergeIssueWithPreservedComments(previousIssue, nextIssue);
    expect(merged.comments.nodes).toHaveLength(1);
    expect(merged.comments.nodes[0]!.body).toBe('Previous comment');
    expect(merged.title).toBe('Updated title');
  });

  it('mergeIssueWithPreservedComments handles undefined children gracefully', () => {
    const previousIssue: IssueSummary = {
      ...(boardQueryResult.issues.nodes[0] as IssueSummary),
      children: {
        nodes: [{ id: 'child-1', identifier: 'INV-10', title: 'Child issue' }],
      },
    };
    const nextIssue = {
      ...(boardQueryResult.issues.nodes[0] as IssueSummary),
      title: 'Updated title',
    } as IssueSummary;
    delete (nextIssue as unknown as Record<string, unknown>).children;

    const merged = mergeIssueWithPreservedComments(previousIssue, nextIssue);
    expect(merged.children.nodes).toHaveLength(1);
    expect(merged.children.nodes[0]!.identifier).toBe('INV-10');
  });

  it('shows "No labels available" message when labels array is empty', async () => {
    renderApp({
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
});
