import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueRelationsQueryData } from './board/types';

const inProgress = { id: 'state-progress', name: 'In Progress', type: 'STARTED' as const };
const done = { id: 'state-done', name: 'Done', type: 'COMPLETED' as const };
const self = { id: 'issue-2', identifier: 'INV-2', title: 'Ready item', commitmentStatus: 'COMMITTED' as const, state: inProgress };

const relationsData: IssueRelationsQueryData = {
  issue: {
    id: 'issue-2',
    links: {
      nodes: [
        {
          id: 'link-open-blocker',
          type: 'BLOCKS',
          from: { id: 'issue-636', identifier: 'INV-636', title: 'Observation contract', commitmentStatus: 'COMMITTED', state: inProgress },
          to: self,
        },
        {
          id: 'link-done-blocker',
          type: 'BLOCKS',
          from: { id: 'issue-637', identifier: 'INV-637', title: 'Result contract', commitmentStatus: 'COMMITTED', state: done },
          to: self,
        },
        {
          id: 'link-blocking',
          type: 'BLOCKS',
          from: self,
          to: { id: 'issue-700', identifier: 'INV-700', title: 'Downstream work', commitmentStatus: 'COMMITTED', state: inProgress },
        },
        {
          id: 'link-duplicate',
          type: 'DUPLICATE_OF',
          from: { id: 'issue-701', identifier: 'INV-701', title: 'Same ask again', commitmentStatus: 'CANDIDATE', state: inProgress },
          to: self,
        },
        {
          id: 'link-contains',
          type: 'CONTAINS',
          from: { id: 'issue-1', identifier: 'INV-1', title: 'Backlog item', commitmentStatus: 'COMMITTED', state: inProgress },
          to: self,
        },
      ],
    },
  },
};

function sourceOf(document: unknown): string {
  return (document as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? '';
}

function stubLinkMutations() {
  const workLink = vi.fn().mockResolvedValue({ data: { workLink: { success: true, link: { id: 'link-new' } } } });
  const workLinkDelete = vi.fn().mockResolvedValue({ data: { workLinkDelete: { success: true, id: 'link-blocking' } } });
  const fallback = apolloMocks.useMutation.getMockImplementation() as ((...args: unknown[]) => unknown) | undefined;
  apolloMocks.useMutation.mockImplementation((document: unknown, ...rest: unknown[]) => {
    const source = sourceOf(document);
    if (source.includes('mutation WorkLinkDelete')) return [workLinkDelete];
    if (source.includes('mutation WorkLink(')) return [workLink];
    return fallback ? fallback(document, ...rest) : [vi.fn()];
  });
  return { workLink, workLinkDelete };
}

async function openDrawer() {
  renderApp(App, { data: boardQueryResult, loading: false, relationsData }, ['/']);
  fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
  const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
  return within(drawer).getByLabelText('Relations');
}

describe('issue relations in the detail drawer (INV-679)', () => {
  it('groups links by how they read from the open issue and leaves hierarchy to its own section', async () => {
    const relations = await openDrawer();

    const blockedBy = within(relations).getByRole('list', { name: 'Blocked by' });
    expect(within(blockedBy).getByText('INV-636')).toBeInTheDocument();
    expect(within(blockedBy).getByText('INV-637')).toBeInTheDocument();
    expect(within(relations).getByRole('list', { name: 'Blocking' })).toHaveTextContent('INV-700');
    expect(within(relations).getByRole('list', { name: 'Duplicated by' })).toHaveTextContent('INV-701');
    expect(within(relations).getByRole('list', { name: 'Duplicated by' })).toHaveTextContent('Candidate');
    expect(within(relations).queryByText('INV-1')).not.toBeInTheDocument();

    const rows = within(blockedBy).getAllByRole('listitem');
    const openRow = rows.find((row) => row.textContent?.includes('INV-636'));
    const doneRow = rows.find((row) => row.textContent?.includes('INV-637'));
    expect(openRow).toHaveClass('issue-relations__row--open-blocker');
    expect(doneRow).not.toHaveClass('issue-relations__row--open-blocker');
  });

  it('adds a blocked-by relation with the target as the link source', async () => {
    const { workLink } = stubLinkMutations();
    const relations = await openDrawer();

    fireEvent.click(within(relations).getByRole('button', { name: 'Add relation' }));
    fireEvent.change(within(relations).getByLabelText('Relation type'), { target: { value: 'blocked-by' } });
    fireEvent.change(within(relations).getByLabelText('Related issue identifier'), { target: { value: 'inv-42' } });
    fireEvent.click(within(relations).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(workLink).toHaveBeenCalledWith({ variables: { fromId: 'INV-42', toId: 'issue-2', type: 'BLOCKS' } }),
    );
  });

  it('adds a related relation from the open issue', async () => {
    const { workLink } = stubLinkMutations();
    const relations = await openDrawer();

    fireEvent.click(within(relations).getByRole('button', { name: 'Add relation' }));
    fireEvent.change(within(relations).getByLabelText('Relation type'), { target: { value: 'related' } });
    fireEvent.change(within(relations).getByLabelText('Related issue identifier'), { target: { value: 'INV-9' } });
    fireEvent.click(within(relations).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(workLink).toHaveBeenCalledWith({ variables: { fromId: 'issue-2', toId: 'INV-9', type: 'RELATED_TO' } }),
    );
  });

  it('shows the server refusal instead of silently dropping it', async () => {
    const { workLink } = stubLinkMutations();
    workLink.mockResolvedValueOnce({
      data: { workLink: { success: false, link: null, message: 'Adding this link would create a cycle.' } },
    });
    const relations = await openDrawer();

    fireEvent.click(within(relations).getByRole('button', { name: 'Add relation' }));
    fireEvent.change(within(relations).getByLabelText('Related issue identifier'), { target: { value: 'INV-3' } });
    fireEvent.click(within(relations).getByRole('button', { name: 'Add' }));

    expect(await within(relations).findByRole('alert')).toHaveTextContent('Adding this link would create a cycle.');
  });

  it('removes a relation by its link id', async () => {
    const { workLinkDelete } = stubLinkMutations();
    const relations = await openDrawer();

    fireEvent.click(within(relations).getByRole('button', { name: 'Remove blocking INV-700' }));

    await waitFor(() => expect(workLinkDelete).toHaveBeenCalledWith({ variables: { id: 'link-blocking' } }));
  });

  it('starts each issue with a fresh relation form, so a typed target cannot carry over', async () => {
    window.localStorage.setItem('involute.activeTeamKey', 'INV');
    window.localStorage.setItem(
      'involute.board.viewState.INV',
      JSON.stringify({ sortField: 'updatedAt', sortDirection: 'asc' }),
    );
    renderApp(App, { data: boardQueryResult, loading: false, relationsData }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const relations = within(drawer).getByLabelText('Relations');

    fireEvent.click(within(relations).getByRole('button', { name: 'Add relation' }));
    fireEvent.change(within(relations).getByLabelText('Related issue identifier'), { target: { value: 'INV-42' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next issue' }));

    await waitFor(() => expect(within(drawer).getByLabelText('Issue title')).not.toHaveValue('Backlog item'));
    expect(within(drawer).queryByLabelText('Related issue identifier')).not.toBeInTheDocument();
  });
});
