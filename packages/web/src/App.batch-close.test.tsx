import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, dndMocks, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueSummary } from './board/types';
import { getStatusUndoSnapshot } from './undo/status-undo';

function fixture(path = '/', manual = false, conflict = false, activeClaim = false) {
  const states = boardQueryResult.teams.nodes[0]!.states.nodes;
  const originals: IssueSummary[] = [1, 2, 4].map((n, index) => ({
    ...getIssue('issue-1'), id: `issue-${n}`, identifier: `INV-${n}`, title: `Old work ${n}`,
    kind: index === 0 ? 'DECISION' : 'ISSUE',
    supersededBy: manual && index === 2 ? null : { id: `replacement-${n}`, identifier: `INV-${n + 10}`, title: `Replacement ${n}` },
    ...(activeClaim && index === 1 ? { claim: { id: 'claim', leaseUntil: new Date(Date.now() + 60_000).toISOString(), actor: { id: 'agent', actorKind: 'AGENT' as const } } } : { claim: null }),
  }));
  const current = new Map(originals.map((issue) => [issue.id, issue]));
  const mutate = vi.fn().mockImplementation(({ variables: { id, input } }) => {
    if (conflict && id === 'issue-2') return Promise.resolve({ data: { issueUpdate: { success: false, message: 'Revision conflict', issue: null } } });
    const issue = current.get(id)!;
    const next = { ...issue, revision: issue.revision + 1, state: states.find((state) => state.id === input.stateId)! };
    current.set(id, next);
    return Promise.resolve({ data: { issueUpdate: { success: true, issue: next } } });
  });
  apolloMocks.useMutation.mockReturnValue([mutate]);
  renderApp(App, { data: { ...boardQueryResult, issues: { ...boardQueryResult.issues, nodes: originals } }, loading: false }, [path]);
  return { mutate, originals };
}

async function selectAndClose(path: string) {
  await screen.findByRole('checkbox', { name: 'Select INV-1' });
  if (path === '/') fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  for (const n of [1, 2, 4]) fireEvent.click(screen.getByRole('checkbox', { name: `Select INV-${n}` }));
  fireEvent.change(screen.getByLabelText('Bulk move selected issues to state'), { target: { value: 'state-canceled' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to selected' }));
  return screen.findByRole('dialog', { name: 'Close reason' });
}

function undoIdentifiers() {
  const entry = getStatusUndoSnapshot().undo[0];
  if (!entry || !('changes' in entry)) throw new Error('Expected a status undo gesture');
  return entry.changes.map((change) => change.identifier).sort();
}

describe('batch cancel superseded items (INV-1930)', () => {
  for (const path of ['/', '/backlog']) it(`filters superseded open work on the server at ${path}`, async () => {
    fixture(path);
    await screen.findByRole('checkbox', { name: 'Select INV-1' });
    if (path === '/') fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Superseded, open' }));
    await waitFor(() => expect(apolloMocks.useQuery.mock.calls.some(([, options]) => options?.variables?.query === 'superseded:yes -state-type:canceled,completed')).toBe(true));
  });

  it('does not write anything when the person keeps the batch open', async () => {
    const { mutate } = fixture();
    const dialog = await selectAndClose('/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep open' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(getStatusUndoSnapshot().undo).toHaveLength(0);
  });

  for (const path of ['/', '/backlog']) it(`uses three independent defaults and undoes the batch at ${path}`, async () => {
    const { mutate } = fixture(path);
    const dialog = await selectAndClose(path);
    for (const n of [1, 2, 4]) expect(dialog).toHaveTextContent(`Replacement ${n}`);
    expect(within(dialog).queryByLabelText('Resolution')).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    for (const n of [1, 2, 4]) expect(mutate).toHaveBeenCalledWith({ variables: { id: `issue-${n}`, input: { expectedRevision: 1, stateId: 'state-canceled', resolution: n === 1 ? 'OBSOLETE' : 'DUPLICATE', reason: `Superseded by INV-${n + 10}: Replacement ${n}` } } });
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(6));
    for (const n of [1, 2, 4]) expect(mutate).toHaveBeenCalledWith({ variables: { id: `issue-${n}`, input: { expectedRevision: 2, stateId: 'state-backlog' } } });
  });

  it('uses manual values only for items without a replacement', async () => {
    const { mutate } = fixture('/', true);
    const dialog = await selectAndClose('/');
    fireEvent.change(within(dialog).getByLabelText('Resolution'), { target: { value: 'WONT_DO' } });
    fireEvent.change(within(dialog).getByLabelText('Close reason text'), { target: { value: 'No longer needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    expect(mutate).toHaveBeenCalledWith({ variables: { id: 'issue-4', input: { expectedRevision: 1, stateId: 'state-canceled', resolution: 'WONT_DO', reason: 'No longer needed' } } });
    expect(mutate).toHaveBeenCalledWith({ variables: { id: 'issue-1', input: { expectedRevision: 1, stateId: 'state-canceled', resolution: 'OBSOLETE', reason: 'Superseded by INV-11: Replacement 1' } } });
  });

  it('names and keeps manual items open when the shared fields are empty', async () => {
    const { mutate } = fixture('/', true);
    const dialog = await selectAndClose('/');
    expect(within(dialog).getByRole('status')).toHaveTextContent('INV-4');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Kept open/)).toHaveTextContent('INV-4');
    expect(undoIdentifiers()).toEqual(['INV-1', 'INV-2']);
  });

  it('names revision conflicts while closing and recording undo for the other two', async () => {
    const { mutate } = fixture('/', false, true);
    const dialog = await selectAndClose('/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    expect(screen.getByText(/Kept open/)).toHaveTextContent('INV-2: Revision conflict');
    expect(undoIdentifiers()).toEqual(['INV-1', 'INV-4']);
  });

  it('skips a live claim and names it without stopping the others', async () => {
    const { mutate } = fixture('/', false, false, true);
    const dialog = await selectAndClose('/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Kept open/)).toHaveTextContent('INV-2: active claim');
  });

  it('dragging selected cards to Canceled confirms the whole batch', async () => {
    const { mutate } = fixture();
    await screen.findByRole('checkbox', { name: 'Select INV-1' });
    for (const n of [1, 2, 4]) fireEvent.click(screen.getByRole('checkbox', { name: `Select INV-${n}` }));
    const props = () => dndMocks.lastContextProps as any;
    const over = { id: 'state-canceled', data: { current: { stateId: 'state-canceled', type: 'column' } } };
    await act(async () => { props().onDragStart({ active: { id: 'issue-1' } }); });
    await act(async () => { props().onDragOver({ active: { id: 'issue-1' }, over }); });
    act(() => { void props().onDragEnd({ active: { id: 'issue-1' }, over }); });
    const dialog = await screen.findByRole('dialog', { name: 'Close reason' });
    expect(dialog).toHaveTextContent('Cancel 3 items');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);
  });
});
