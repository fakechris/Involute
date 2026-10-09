import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueSummary } from './board/types';
import { SHORTCUT_SECTIONS } from './app/KeyboardShortcutsDialog';
import { getStatusUndoSnapshot, resetStatusUndo } from './undo/status-undo';

// INV-1087: S/P/A/I/L change fields of the selected or focused issues from the
// keyboard, one undo entry per gesture; Space peeks; ⌘. copies the identifier.

function sourceOf(document: unknown): string {
  return (document as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? '';
}

function installUpdate() {
  const states = boardQueryResult.teams.nodes.flatMap((team) => team.states.nodes);
  const update = vi.fn(async (options: { variables: { id: string; input: Record<string, unknown> } }) => {
    const { id, input } = options.variables;
    const source = boardQueryResult.issues.nodes.find((issue) => issue.id === id)!;
    const next: IssueSummary = {
      ...source,
      revision: Number(input.expectedRevision) + 1,
      ...(typeof input.priority === 'number' ? { priority: input.priority } : {}),
      ...(typeof input.stateId === 'string' ? { state: states.find((state) => state.id === input.stateId)! } : {}),
      ...('assigneeId' in input ? { assignee: boardQueryResult.users.nodes.find((user) => user.id === input.assigneeId) ?? null } : {}),
      ...(Array.isArray(input.labelIds) ? { labels: { nodes: boardQueryResult.issueLabels.nodes.filter((label) => (input.labelIds as string[]).includes(label.id)) } } : {}),
    };
    return { data: { issueUpdate: { success: true, message: null, issue: next } } };
  });
  apolloMocks.useMutation.mockImplementation((document: unknown) => (sourceOf(document).includes('mutation IssueUpdate') ? [update] : [vi.fn()]));
  return update;
}

async function renderBoard() {
  const result = renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
  await screen.findByText('INV-1');
  // "I" needs to know who the viewer is.
  const base = apolloMocks.useQuery.getMockImplementation() as (document: unknown, options: unknown) => unknown;
  apolloMocks.useQuery.mockImplementation((document: unknown, options: unknown) =>
    sourceOf(document).includes('query ViewerId') ? { data: { viewer: { id: 'user-1' } }, loading: false } : base(document, options));
  return result;
}

const press = (key: string, init: KeyboardEventInit = {}) => act(() => { fireEvent.keyDown(window, { key, ...init }); });
/** Focus a card by walking J/K until it holds the focus ring. */
async function focusCard(id: string) {
  for (let step = 0; step < 6 && screen.getByTestId(`issue-card-${id}`).getAttribute('data-focused') !== 'true'; step += 1) press(step < 3 ? 'k' : 'j');
  await waitFor(() => expect(screen.getByTestId(`issue-card-${id}`)).toHaveAttribute('data-focused', 'true'));
}

describe('board field keys (INV-1087)', () => {
  beforeEach(() => resetStatusUndo());

  it('P then a digit sets priority on the focused issue as one undo entry', async () => {
    const update = installUpdate();
    await renderBoard();
    await focusCard('issue-1');
    press('p');
    const picker = await screen.findByRole('dialog', { name: 'Set priority' });
    fireEvent.keyDown(within(picker).getByLabelText('Set priority filter'), { key: '2' });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ variables: { id: 'issue-1', input: { priority: 2, expectedRevision: 1 } } }));
    expect(screen.queryByRole('dialog', { name: 'Set priority' })).not.toBeInTheDocument();
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);
  });

  it('S over two selected issues moves both in one undo entry, typing to filter', async () => {
    const update = installUpdate();
    await renderBoard();
    await focusCard('issue-1');
    press('x');
    await focusCard('issue-2');
    press('x');
    press('s');
    const picker = await screen.findByRole('dialog', { name: /Change status · 2 issues/ });
    const filter = within(picker).getByLabelText(/filter$/);
    fireEvent.change(filter, { target: { value: 'done' } });
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);
  });

  it('A assigns, I assigns to me, L toggles a label; Esc cancels a picker', async () => {
    const update = installUpdate();
    await renderBoard();
    press('a');
    const assign = await screen.findByRole('dialog', { name: 'Assign to' });
    fireEvent.keyDown(within(assign).getByLabelText('Assign to filter'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Assign to' })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    await focusCard('issue-2'); // INV-2 is unassigned
    press('i');
    await waitFor(() => expect(update).toHaveBeenCalledWith({ variables: { id: 'issue-2', input: { assigneeId: 'user-1', expectedRevision: 1 } } }));

    press('l');
    const labels = await screen.findByRole('dialog', { name: 'Toggle label' });
    const filter = within(labels).getByLabelText('Toggle label filter');
    fireEvent.change(filter, { target: { value: 'feature' } });
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ variables: { id: 'issue-2', input: { labelIds: ["label-bug", "label-feature"], expectedRevision: 2 } } }));
  });

  it('Space peeks, ⌘. copies the identifier, and keys stay quiet while typing or after g', async () => {
    const update = installUpdate();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderBoard();
    await focusCard('issue-1');
    press(' ');
    expect(await screen.findByRole('dialog', { name: 'Peek INV-1' })).toHaveTextContent('Backlog item');
    press(' ');
    expect(screen.queryByRole('dialog', { name: 'Peek INV-1' })).not.toBeInTheDocument();
    press('.', { metaKey: true });
    expect(writeText).toHaveBeenCalledWith('INV-1');

    const box = document.createElement('input');
    document.body.appendChild(box);
    box.focus();
    fireEvent.keyDown(box, { key: 'p' });
    box.remove();
    expect(screen.queryByRole('dialog', { name: 'Set priority' })).not.toBeInTheDocument();

    press('g');
    press('p'); // g p goes to Projects, not the priority picker
    expect(screen.queryByRole('dialog', { name: 'Set priority' })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('lists the keys in the shortcut sheet', () => {
    const labels = SHORTCUT_SECTIONS.flatMap((section) => section.items.map((item) => item.label));
    expect(labels).toEqual(expect.arrayContaining(['Change status', 'Set priority', 'Assign to', 'Assign to me', 'Toggle label', 'Peek', 'Copy identifier', 'Copy link']));
  });
});
