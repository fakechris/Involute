import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SAVED_VIEW_DELETE_MUTATION, SAVED_VIEW_UPSERT_MUTATION } from '../work/queries';
import { ViewsPage } from './ViewsPage';

// INV-1005: sharing and deleting a saved view go to the server.
const mutations = new Map<unknown, ReturnType<typeof vi.fn>>();
const mutationFor = (doc: unknown) => {
  if (!mutations.has(doc)) mutations.set(doc, vi.fn());
  return mutations.get(doc)!;
};
vi.mock('@apollo/client/react', () => ({
  useMutation: (doc: unknown) => [mutationFor(doc)],
  useQuery: () => ({ data: undefined }),
}));

describe('ViewsPage saved views (INV-1005)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('involute.activeTeamKey', 'INV');
    window.localStorage.setItem('involute.board.savedViews.INV', JSON.stringify([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Mine to review', state: { groupBy: 'status', sortField: 'updatedAt', sortDirection: 'desc', query: 'state:review', assigneeIds: [], labelIds: [], stateIds: [], viewMode: 'list' }, visibility: 'PRIVATE' },
    ]));
    mutationFor(SAVED_VIEW_UPSERT_MUTATION).mockResolvedValue({ data: { savedViewUpsert: { success: true } } });
    mutationFor(SAVED_VIEW_DELETE_MUTATION).mockResolvedValue({ data: { savedViewDelete: { success: true, id: '11111111-1111-4111-8111-111111111111' } } });
  });
  afterEach(() => { cleanup(); mutations.forEach((fn) => fn.mockClear()); });

  const renderPage = () => render(<MemoryRouter><ViewsPage /></MemoryRouter>);

  it('shares a private view with the team through savedViewUpsert', async () => {
    renderPage();
    const card = screen.getByLabelText('View Mine to review');
    fireEvent.click(within(card).getByRole('button', { name: 'Share with team' }));
    await waitFor(() => expect(mutationFor(SAVED_VIEW_UPSERT_MUTATION)).toHaveBeenCalledWith({
      variables: { input: { id: '11111111-1111-4111-8111-111111111111', teamKey: 'INV', name: 'Mine to review', kind: 'board', visibility: 'TEAM', stateJson: expect.stringContaining('"query":"state:review"') } },
    }));
    expect(await within(card).findByText('shared with team')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Make private' })).toBeInTheDocument();
  });

  it('deletes a view through savedViewDelete and drops it from the list', async () => {
    renderPage();
    const card = screen.getByLabelText('View Mine to review');
    fireEvent.click(within(card).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(mutationFor(SAVED_VIEW_DELETE_MUTATION)).toHaveBeenCalledWith({ variables: { id: '11111111-1111-4111-8111-111111111111' } }));
    await waitFor(() => expect(screen.queryByLabelText('View Mine to review')).toBeNull());
    expect(JSON.parse(window.localStorage.getItem('involute.board.savedViews.INV') ?? '[]')).toEqual([]);
  });

  it('shows the server\'s reason when sharing is refused', async () => {
    mutationFor(SAVED_VIEW_UPSERT_MUTATION).mockResolvedValue({ data: { savedViewUpsert: { success: false, message: 'Team write access is required to share a view.' } } });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Share with team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Team write access is required');
  });
});
