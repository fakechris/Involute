import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueUndeleteMutationData } from './board/types';
import { getStatusUndoSnapshot, resetStatusUndo } from './undo/status-undo';

// INV-840: deleting work is one undo entry. ⌘Z calls issueUndelete and the
// card comes back under its original id, selected; ⇧⌘Z deletes it again.

function mutationSource(document: unknown) {
  return typeof document === 'string'
    ? document
    : document && typeof document === 'object' && 'loc' in document && document.loc && typeof document.loc === 'object' && 'source' in document.loc && document.loc.source && typeof document.loc.source === 'object' && 'body' in document.loc.source
      ? String(document.loc.source.body)
      : String(document);
}

function installDeleteMocks(undeleteSucceeds = true) {
  const deleteIssue = vi.fn(async (options: { variables: { id: string } }) => ({
    data: { issueDelete: { success: true, issueId: options.variables.id } },
  }));
  const undeleteIssue = vi.fn(async (options: { variables: { id: string } }) => ({
    data: {
      issueUndelete: undeleteSucceeds
        ? { success: true, message: null, issue: { ...getIssue(options.variables.id), revision: 2 } }
        : { success: false, message: 'Nothing to restore', issue: null },
    } satisfies IssueUndeleteMutationData,
  }));
  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    const source = mutationSource(document);
    if (source.includes('mutation IssueUndelete')) return [undeleteIssue];
    if (source.includes('mutation IssueDelete')) return [deleteIssue];
    return [vi.fn()];
  });
  return { deleteIssue, undeleteIssue };
}

describe('delete undo (INV-840)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetStatusUndo();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => confirmSpy.mockRestore());

  it('restores a deleted issue with ⌘Z, selected in its column, and deletes it again with ⇧⌘Z', async () => {
    const { deleteIssue, undeleteIssue } = installDeleteMocks();
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete issue' }));

    await waitFor(() => expect(deleteIssue).toHaveBeenCalledWith({ variables: { id: 'issue-1' } }));
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('⌘Z');
    await waitFor(() => expect(within(screen.getByTestId('column-Backlog')).queryByText('INV-1')).not.toBeInTheDocument());
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-1 deleted');

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(undeleteIssue).toHaveBeenCalledWith({ variables: { id: 'issue-1' } }));
    await waitFor(() => expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument());
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('INV-1 restored');
    expect(getStatusUndoSnapshot().redo).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(deleteIssue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(screen.getByTestId('column-Backlog')).queryByText('INV-1')).not.toBeInTheDocument());
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);
  });

  it('names the issue when the server has nothing to restore', async () => {
    const { undeleteIssue } = installDeleteMocks(false);
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delete issue' }));
    await waitFor(() => expect(within(screen.getByTestId('column-Backlog')).queryByText('INV-1')).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(undeleteIssue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('Could not change INV-1.'));
    expect(within(screen.getByTestId('column-Backlog')).queryByText('INV-1')).not.toBeInTheDocument();
    expect(getStatusUndoSnapshot().redo).toHaveLength(0);
  });
});
