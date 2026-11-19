import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, dndMocks, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueSummary } from './board/types';
import { getStatusUndoSnapshot } from './undo/status-undo';
import { getDefaultBoardViewState, writeStoredBoardViewState } from './board/views';

function fixture(path = '/', manual = false, conflict = false, activeClaim = false, serverFilter = false) {
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
    if (input.stateId === 'state-canceled' && !input.resolution) return Promise.resolve({ data: { issueUpdate: { success: false, message: 'Choose a resolution', issue: null } } });
    const next = { ...issue, revision: issue.revision + 1, state: states.find((state) => state.id === input.stateId)! };
    current.set(id, next);
    // Apollo awaits the BoardPage IQL refetch before resolving issueUpdate.
    if (serverFilter) queryState.data = { ...queryState.data, issues: { ...queryState.data.issues, nodes: [...current.values()].filter((item) => item.state.type !== 'CANCELED') } };
    return Promise.resolve({ data: { issueUpdate: { success: true, issue: next } } });
  });
  apolloMocks.useMutation.mockReturnValue([mutate]);
  const queryState = { data: { ...boardQueryResult, issues: { ...boardQueryResult.issues, nodes: originals } }, loading: false };
  renderApp(App, queryState, [path]);
  return { mutate, originals };
}

async function selectAndClose(path: string, keyboard = false) {
  await screen.findByRole('checkbox', { name: 'Select INV-1' });
  const filter = screen.queryByRole('button', { name: 'Filter' });
  if (path === '/' && filter) fireEvent.click(filter);
  for (const n of [1, 2, 4]) fireEvent.click(screen.getByRole('checkbox', { name: `Select INV-${n}` }));
  if (keyboard) {
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.mouseDown(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Canceled' }));
  } else {
    fireEvent.change(screen.getByLabelText('Bulk move selected issues to state'), { target: { value: 'state-canceled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to selected' }));
  }
  return screen.findByRole('dialog', { name: 'Close reason' });
}

function undoIdentifiers() {
  const entry = getStatusUndoSnapshot().undo[0];
  if (!entry || !('fields' in entry)) throw new Error('Expected a field undo gesture');
  return entry.fields.map((change) => change.identifier).sort();
}

describe('batch cancel superseded items (INV-1930)', () => {
  for (const path of ['/', '/backlog']) it(`filters superseded open work on the server at ${path}`, async () => {
    fixture(path);
    await screen.findByRole('checkbox', { name: 'Select INV-1' });
    if (path === '/') fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Superseded, open' }));
    await waitFor(() => expect(apolloMocks.useQuery.mock.calls.some(([, options]) => options?.variables?.query === 'superseded:yes -state-type:canceled,completed')).toBe(true));
  });

  for (const path of ['/', '/backlog']) it(`removes canceled results from a server-filtered batch while keeping conflicts at ${path}`, async () => {
    fixture(path, false, true, false, true);
    await screen.findByRole('checkbox', { name: 'Select INV-1' });
    if (path === '/') fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Superseded, open' }));
    const dialog = await selectAndClose(path);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'Select INV-1' })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Select INV-4' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('checkbox', { name: 'Select INV-2' })).not.toBeChecked();
    expect(await screen.findByText(/Kept open.*INV-2.*Revision conflict/)).toBeInTheDocument();
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
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(9));
    for (const n of [1, 2, 4]) expect(mutate).toHaveBeenCalledWith({ variables: { id: `issue-${n}`, input: { expectedRevision: 3, stateId: 'state-canceled', resolution: n === 1 ? 'OBSOLETE' : 'DUPLICATE', reason: `Superseded by INV-${n + 10}: Replacement ${n}` } } });
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

  it('redoes a keyboard batch cancellation with each original close payload', async () => {
    const { mutate } = fixture();
    const dialog = await selectAndClose('/', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel work' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(6));
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(9));
    for (const n of [1, 2, 4]) expect(mutate).toHaveBeenCalledWith({ variables: { id: `issue-${n}`, input: { expectedRevision: 3, stateId: 'state-canceled', resolution: n === 1 ? 'OBSOLETE' : 'DUPLICATE', reason: `Superseded by INV-${n + 10}: Replacement ${n}` } } });
    expect(getStatusUndoSnapshot().redo).toHaveLength(0);
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);
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

  for (const filtered of [false, true]) it(`dragging selected cards closes and undoes the whole batch (state filter: ${filtered})`, async () => {
    if (filtered) writeStoredBoardViewState('INV', { ...getDefaultBoardViewState(), stateIds: ['state-backlog'] });
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
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(6));
    for (const n of [1, 2, 4]) expect(mutate).toHaveBeenCalledWith({ variables: { id: `issue-${n}`, input: { expectedRevision: 2, stateId: 'state-backlog' } } });
  });
});
