import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueRelationsQueryData } from './board/types';
import { getStatusUndoSnapshot, resetStatusUndo } from './undo/status-undo';

// INV-842: adding or removing a work relation is one undo entry. ⌘Z after an
// add removes the link by id; ⌘Z after a remove adds the same link back.

const inProgress = { id: 'state-ready', name: 'Ready', type: 'UNSTARTED' as const };
const self = { id: 'issue-2', identifier: 'INV-2', title: 'Ready item', commitmentStatus: 'COMMITTED' as const, state: inProgress };
const relationsData: IssueRelationsQueryData = {
  issue: {
    id: 'issue-2',
    links: {
      nodes: [
        {
          id: 'link-blocking',
          type: 'BLOCKS',
          from: self,
          to: { id: 'issue-700', identifier: 'INV-700', title: 'Downstream work', commitmentStatus: 'COMMITTED', state: inProgress },
        },
      ],
    },
  },
};

function sourceOf(document: unknown): string {
  return (document as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? '';
}

function stubLinkMutations() {
  const workLink = vi.fn().mockResolvedValue({ data: { workLink: { success: true, message: null, link: { id: 'link-new', type: 'BLOCKS' } } } });
  const workLinkDelete = vi.fn().mockResolvedValue({ data: { workLinkDelete: { success: true, id: 'link-blocking', message: null } } });
  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    const source = sourceOf(document);
    if (source.includes('mutation WorkLinkDelete')) return [workLinkDelete];
    if (source.includes('mutation WorkLink(')) return [workLink];
    return [vi.fn()];
  });
  return { workLink, workLinkDelete };
}

async function openRelations() {
  renderApp(App, { data: boardQueryResult, loading: false, relationsData }, ['/']);
  fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
  const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
  return within(drawer).getByLabelText('Relations');
}

describe('relation undo (INV-842)', () => {
  beforeEach(() => resetStatusUndo());

  it('removes an added relation with ⌘Z and adds it again with ⇧⌘Z', async () => {
    const { workLink, workLinkDelete } = stubLinkMutations();
    const relations = await openRelations();

    fireEvent.click(within(relations).getByRole('button', { name: 'Add relation' }));
    fireEvent.change(within(relations).getByLabelText('Relation type'), { target: { value: 'blocked-by' } });
    fireEvent.change(within(relations).getByLabelText('Related issue identifier'), { target: { value: 'inv-42' } });
    fireEvent.click(within(relations).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(workLink).toHaveBeenCalledWith({ variables: { fromId: 'INV-42', toId: 'issue-2', type: 'BLOCKS' } }));
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-2 blocked by INV-42 added');
    expect(getStatusUndoSnapshot().undo).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(workLinkDelete).toHaveBeenCalledWith({ variables: { id: 'link-new' } }));
    await waitFor(() => expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('INV-2 blocked by INV-42 removed'));
    expect(getStatusUndoSnapshot().redo).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(workLink).toHaveBeenCalledTimes(2));
    expect(workLink).toHaveBeenLastCalledWith({ variables: { fromId: 'INV-42', toId: 'issue-2', type: 'BLOCKS' } });
    await waitFor(() => expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('INV-2 blocked by INV-42 added'));
  });

  it('adds a removed relation back with ⌘Z, by its ends and type', async () => {
    const { workLink, workLinkDelete } = stubLinkMutations();
    const relations = await openRelations();

    fireEvent.click(within(relations).getByRole('button', { name: 'Remove blocking INV-700' }));
    await waitFor(() => expect(workLinkDelete).toHaveBeenCalledWith({ variables: { id: 'link-blocking' } }));
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('INV-2 blocking INV-700 removed');

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(workLink).toHaveBeenCalledWith({ variables: { fromId: 'issue-2', toId: 'issue-700', type: 'BLOCKS' } }));
    await waitFor(() => expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('INV-2 blocking INV-700 added'));

    // Redo removes the link the server just created, not the old id.
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(workLinkDelete).toHaveBeenLastCalledWith({ variables: { id: 'link-new' } }));
  });

  it('names the relation the server refused and keeps nothing to redo', async () => {
    const { workLink, workLinkDelete } = stubLinkMutations();
    workLinkDelete.mockResolvedValueOnce({ data: { workLinkDelete: { success: false, id: null, message: 'Not yours' } } });
    const relations = await openRelations();

    fireEvent.click(within(relations).getByRole('button', { name: 'Add relation' }));
    fireEvent.change(within(relations).getByLabelText('Related issue identifier'), { target: { value: 'INV-42' } });
    fireEvent.click(within(relations).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(workLink).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(workLinkDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('status-undo-toast')).toHaveTextContent('Could not change INV-2 blocked by INV-42.'));
    expect(getStatusUndoSnapshot().redo).toHaveLength(0);
  });
});
