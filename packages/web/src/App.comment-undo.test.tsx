import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { BoardPageQueryData } from './board/types';
import { getStatusUndoSnapshot, resetStatusUndo } from './undo/status-undo';

// INV-843: deleting a comment is one undo entry. ⌘Z posts the same text again
// as a new comment; ⇧⌘Z deletes that new one.

const withComment: BoardPageQueryData = {
  ...boardQueryResult,
  issues: {
    ...boardQueryResult.issues,
    nodes: boardQueryResult.issues.nodes.map((issue) =>
      issue.id === 'issue-1'
        ? {
            ...issue,
            comments: {
              nodes: [{ id: 'comment-1', body: 'Disposable comment', createdAt: '2026-04-02T10:30:00.000Z', user: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' } }],
            },
          }
        : issue,
    ),
  },
};

function sourceOf(document: unknown): string {
  return (document as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? '';
}

function installMocks() {
  const commentDelete = vi.fn(async (options: { variables: { id: string } }) => ({ data: { commentDelete: { success: true, commentId: options.variables.id } } }));
  const commentCreate = vi.fn(async (options: { variables: { input: { body: string } } }) => ({
    data: {
      commentCreate: {
        success: true,
        comment: { id: 'comment-new', body: options.variables.input.body, createdAt: '2026-04-02T11:00:00.000Z', user: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' } },
      },
    },
  }));
  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    const source = sourceOf(document);
    if (source.includes('mutation CommentDelete')) return [commentDelete];
    if (source.includes('mutation CommentCreate')) return [commentCreate];
    return [vi.fn()];
  });
  return { commentDelete, commentCreate };
}

describe('comment undo (INV-843)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetStatusUndo();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => confirmSpy.mockRestore());

  it('posts a deleted comment again with ⌘Z, says it is new, and deletes the new one with ⇧⌘Z', async () => {
    const { commentDelete, commentCreate } = installMocks();
    renderApp(App, { data: withComment, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).getByText('Disposable comment')).toBeInTheDocument();

    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Delete comment' })[0]!);
    await waitFor(() => expect(commentDelete).toHaveBeenCalledWith({ variables: { id: 'comment-1' } }));
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('⌘Z');
    await waitFor(() => expect(within(drawer).queryByText('Disposable comment')).not.toBeInTheDocument());
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('Comment on INV-1 deleted');

    // Typing keeps ⌘Z for the text box.
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    box.focus();
    fireEvent.keyDown(box, { key: 'z', metaKey: true });
    box.remove();
    expect(commentCreate).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(commentCreate).toHaveBeenCalledWith({ variables: { input: { issueId: 'issue-1', body: 'Disposable comment' } } }));
    await waitFor(() => expect(within(drawer).getByText('Disposable comment')).toBeInTheDocument());
    expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('Comment on INV-1 posted again as new');
    expect(getStatusUndoSnapshot().redo).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(commentDelete).toHaveBeenLastCalledWith({ variables: { id: 'comment-new' } }));
    await waitFor(() => expect(within(drawer).queryByText('Disposable comment')).not.toBeInTheDocument());
  });

  it('names the comment when the server refuses to post it again', async () => {
    const { commentCreate } = installMocks();
    commentCreate.mockResolvedValueOnce({ data: { commentCreate: { success: false, comment: null } } } as never);
    renderApp(App, { data: withComment, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Delete comment' })[0]!);
    await waitFor(() => expect(within(drawer).queryByText('Disposable comment')).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(commentCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('Could not change comment on INV-1.'));
    expect(getStatusUndoSnapshot().redo).toHaveLength(0);
  });
});
