import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueSummary, IssueUpdateMutationData } from './board/types';
import { fieldChange, formatFieldChanges } from './undo/field-gesture';
import { getStatusUndoSnapshot, recordFieldGesture, resetStatusUndo } from './undo/status-undo';

// INV-839: every field edit a person makes — state, assignee, labels, priority,
// snooze — is one entry on the session undo stack, reversed with ⌘Z and
// repeated with ⇧⌘Z from any page.

function mutationSource(document: unknown) {
  return typeof document === 'string'
    ? document
    : document && typeof document === 'object' && 'loc' in document && document.loc && typeof document.loc === 'object' && 'source' in document.loc && document.loc.source && typeof document.loc.source === 'object' && 'body' in document.loc.source
      ? String(document.loc.source.body)
      : String(document);
}

/** issueUpdate that applies the patch to the fixture issue and bumps the revision. */
function installFieldUpdateMock(catalog: IssueSummary[] = boardQueryResult.issues.nodes, conflictOn?: (input: Record<string, unknown>) => boolean) {
  const updateIssue = vi.fn(async (options: { variables: { id: string; input: Record<string, unknown> } }) => {
    const { id, input } = options.variables;
    const source = catalog.find((issue) => issue.id === id) ?? getIssue(id);
    if (conflictOn?.(input)) {
      return { data: { issueUpdate: { success: false, message: 'revision conflict', issue: null } } };
    }
    const states = boardQueryResult.teams.nodes.flatMap((team) => team.states.nodes);
    const users = boardQueryResult.users.nodes;
    const next: IssueSummary = {
      ...source,
      revision: Number(input.expectedRevision ?? source.revision) + 1,
      ...(typeof input.stateId === 'string' ? { state: states.find((state) => state.id === input.stateId) ?? source.state } : {}),
      ...('assigneeId' in input
        ? { assignee: input.assigneeId ? users.find((user) => user.id === input.assigneeId) ?? null : null }
        : {}),
      ...(Array.isArray(input.labelIds)
        ? { labels: { nodes: boardQueryResult.issueLabels.nodes.filter((label) => (input.labelIds as string[]).includes(label.id)) } }
        : {}),
    };
    return { data: { issueUpdate: { success: true, message: null, issue: next } } satisfies IssueUpdateMutationData };
  });
  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    if (mutationSource(document).includes('mutation IssueUpdate')) return [updateIssue];
    return [vi.fn()];
  });
  return updateIssue;
}

// The issue page reads states from the issue's own team.
const team = boardQueryResult.teams.nodes[0]!;
const issuePageData = {
  ...boardQueryResult,
  issues: {
    ...boardQueryResult.issues,
    nodes: boardQueryResult.issues.nodes.map((issue) =>
      issue.id === 'issue-1' ? { ...issue, team: { ...issue.team, name: team.name, states: team.states } } : issue,
    ),
  },
};

describe('field undo (INV-839)', () => {
  beforeEach(() => resetStatusUndo());

  it('undoes a state change made on the issue page with ⌘Z and redoes it with ⇧⌘Z', async () => {
    const updateIssue = installFieldUpdateMock(issuePageData.issues.nodes);
    renderApp(App, { data: issuePageData, loading: false }, ['/issue/issue-1']);
    const stateSelect = await screen.findByLabelText('Issue state');
    await within(stateSelect).findByRole('option', { name: 'Ready' });

    fireEvent.change(stateSelect, { target: { value: 'state-ready' } });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
    expect(updateIssue).toHaveBeenLastCalledWith({ variables: { id: 'issue-1', input: { stateId: 'state-ready', expectedRevision: 1 } } });

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getByRole('button', { name: /Undo · INV-1 moved to Ready/ })).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole('button', { name: 'Close command palette' }));

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(2));
    // The reverse write carries the revision the gesture left behind.
    expect(updateIssue).toHaveBeenLastCalledWith({ variables: { id: 'issue-1', input: { stateId: 'state-backlog', expectedRevision: 2 } } });
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-1 moved to Backlog');
    await waitFor(() => expect(screen.getByLabelText('Issue state')).toHaveValue('state-backlog'));

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(3));
    expect(updateIssue).toHaveBeenLastCalledWith({ variables: { id: 'issue-1', input: { stateId: 'state-ready', expectedRevision: 3 } } });
    await waitFor(() => expect(screen.getByLabelText('Issue state')).toHaveValue('state-ready'));
  });

  it('undoes an assignee change made in the board drawer and ignores ⌘Z while typing', async () => {
    const updateIssue = installFieldUpdateMock();
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue assignee'), { target: { value: '' } });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
    expect(updateIssue).toHaveBeenLastCalledWith({ variables: { id: 'issue-1', input: { assigneeId: null, expectedRevision: 1 } } });

    const search = document.createElement('input');
    document.body.appendChild(search);
    search.focus();
    fireEvent.keyDown(search, { key: 'z', metaKey: true });
    search.remove();
    expect(updateIssue).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(2));
    expect(updateIssue).toHaveBeenLastCalledWith({ variables: { id: 'issue-1', input: { assigneeId: 'user-1', expectedRevision: 2 } } });
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-1 assigned to Admin');
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-selected', 'true');
  });

  it('names the issue that conflicted and drops it from redo', async () => {
    const updateIssue = installFieldUpdateMock(issuePageData.issues.nodes, (input) => input.expectedRevision === 2);
    renderApp(App, { data: issuePageData, loading: false }, ['/issue/issue-1']);
    const stateSelect = await screen.findByLabelText('Issue state');
    await within(stateSelect).findByRole('option', { name: 'Ready' });
    fireEvent.change(stateSelect, { target: { value: 'state-ready' } });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(2));
    const toast = await screen.findByTestId('status-undo-toast');
    expect(toast).toHaveTextContent('Could not change INV-1.');
    expect(getStatusUndoSnapshot().redo).toHaveLength(0);
  });
});

describe('field gesture entries', () => {
  beforeEach(() => resetStatusUndo());

  it('records the reverse patch with names for the toast', () => {
    const issue = getIssue('issue-1');
    const change = fieldChange(issue, { priority: 1, labelIds: ['label-bug'] }, 2, { labelNames: () => ['Bug'] });
    expect(change).toMatchObject({
      issueId: 'issue-1',
      identifier: 'INV-1',
      revision: 2,
      before: { priority: 0, labelIds: ['label-task'] },
      summary: 'priority set to Urgent, labels set to Bug',
    });
    expect(change?.reverseSummary).toContain('priority set to');
    expect(fieldChange(issue, {}, 2)).toBeNull();
  });

  it('keeps a bulk gesture as one entry and names the first three issues', () => {
    const changes = ['issue-1', 'issue-2', 'issue-3', 'issue-4'].flatMap((id) => {
      const change = fieldChange({ ...getIssue('issue-1'), id, identifier: id.toUpperCase() }, { assigneeId: null }, 2);
      return change ? [change] : [];
    });
    recordFieldGesture(changes);
    const { undo } = getStatusUndoSnapshot();
    expect(undo).toHaveLength(1);
    expect(formatFieldChanges(changes)).toBe('ISSUE-1, ISSUE-2, ISSUE-3 and 1 more unassigned');
  });
});
