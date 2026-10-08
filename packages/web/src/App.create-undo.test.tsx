import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp, type IssueCreateMutationData, type IssueSummary } from './test/app-test-helpers';
import { App } from './App';
import type { PlacementOptionsQueryData } from './work/types';
import { getStatusUndoSnapshot, resetStatusUndo } from './undo/status-undo';

// INV-841: creating an issue is one undo entry. ⌘Z deletes the new card,
// ⇧⌘Z brings it back under the same number (issueUndelete, INV-840) and the toast names it.

const placementData: PlacementOptionsQueryData = {
  projects: { nodes: [{ id: 'project-79', identifier: 'INV-79', title: 'fakechris/Involute', kind: 'PROJECT' }] },
  milestones: { nodes: [] },
  epics: { nodes: [] },
};

const created: IssueSummary = {
  id: 'issue-3',
  identifier: 'INV-3',
  revision: 1,
  title: 'Created issue',
  description: null,
  priority: 0,
  createdAt: '2026-04-02T13:00:00.000Z',
  updatedAt: '2026-04-02T13:00:00.000Z',
  state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
  team: { id: 'team-1', key: 'INV' },
  labels: { nodes: [] },
  assignee: null,
  children: { nodes: [] },
  parent: null,
  comments: { nodes: [] },
};

function mutationSource(document: unknown) {
  return typeof document === 'string'
    ? document
    : document && typeof document === 'object' && 'loc' in document && document.loc && typeof document.loc === 'object' && 'source' in document.loc && document.loc.source && typeof document.loc.source === 'object' && 'body' in document.loc.source
      ? String(document.loc.source.body)
      : String(document);
}

function installMocks() {
  const createIssue = vi.fn().mockResolvedValue({
    data: { issueCreate: { success: true, message: null, issue: created } } satisfies IssueCreateMutationData,
  });
  const deleteIssue = vi.fn(async (options: { variables: { id: string } }) => ({ data: { issueDelete: { success: true, issueId: options.variables.id } } }));
  const undeleteIssue = vi.fn().mockResolvedValue({ data: { issueUndelete: { success: true, message: null, issue: { ...created, revision: 2 } } } });
  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    const source = mutationSource(document);
    if (source.includes('mutation IssueCreate')) return [createIssue];
    if (source.includes('mutation IssueUndelete')) return [undeleteIssue];
    if (source.includes('mutation IssueDelete')) return [deleteIssue];
    return [vi.fn()];
  });
  return { createIssue, deleteIssue, undeleteIssue };
}

describe('create undo (INV-841)', () => {
  beforeEach(() => {
    resetStatusUndo();
    window.localStorage.setItem('involute.createPlacement.INV', JSON.stringify({ repository: 'fakechris/Involute', parentId: 'INV-79' }));
  });

  it('undoes a creation with ⌘Z, ignores ⌘Z in the title box, and redoes it with ⇧⌘Z naming the number', async () => {
    const { createIssue, deleteIssue, undeleteIssue } = installMocks();
    renderApp(App, {
      data: {
        ...boardQueryResult,
        projectSummary: {
          totalCount: 3,
          noRepositoryCount: 0,
          projects: [{ repository: 'fakechris/Involute', name: 'Involute', identifier: 'INV-79', totalCount: 3 }],
        },
      },
      loading: false,
      placementData,
    }, ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    const title = within(dialog).getByLabelText('Issue title');
    fireEvent.change(title, { target: { value: 'Created issue' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));
    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    const backlog = screen.getByTestId('column-Backlog');
    expect(await within(backlog).findByText('INV-3')).toBeInTheDocument();
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-3 created');
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);

    // Typing in a text box keeps ⌘Z for the text.
    const box = document.createElement('input');
    document.body.appendChild(box);
    box.focus();
    fireEvent.keyDown(box, { key: 'z', metaKey: true });
    box.remove();
    expect(deleteIssue).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(deleteIssue).toHaveBeenCalledWith({ variables: { id: 'issue-3' } }));
    await waitFor(() => expect(within(screen.getByTestId('column-Backlog')).queryByText('INV-3')).not.toBeInTheDocument());
    expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('INV-3 deleted');

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(undeleteIssue).toHaveBeenCalledWith({ variables: { id: 'issue-3' } }));
    await waitFor(() => expect(within(screen.getByTestId('column-Backlog')).getByText('INV-3')).toBeInTheDocument());
    expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('INV-3 created');
    expect(screen.getByTestId('issue-card-issue-3')).toHaveAttribute('data-selected', 'true');
  });
});
