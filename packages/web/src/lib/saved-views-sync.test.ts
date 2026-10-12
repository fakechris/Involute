import type { ApolloClient } from '@apollo/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSavedBoardViews, writeSavedBoardViews, type BoardViewState } from '../board/views';
import { SAVED_VIEW_DELETE_MUTATION, SAVED_VIEW_UPSERT_MUTATION } from '../work/queries';
import { setSavedViewsAccount } from './saved-views-account';
import { SAVED_VIEWS_MIGRATED_KEY, startSavedViewsSync } from './saved-views-sync';

type ServerView = { id: string; ownerId: string; name: string; kind: string; visibility: 'PRIVATE' | 'TEAM'; stateJson: string };

const BOARD_STATE: BoardViewState = { assigneeIds: [], groupBy: 'status', labelIds: [], query: '', sortDirection: 'desc', sortField: 'updatedAt', stateIds: [], viewMode: 'board', projectKey: null };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const serverView = (id: string, name: string): ServerView => ({ id, ownerId: 'user-a', name, kind: 'board', visibility: 'PRIVATE', stateJson: JSON.stringify(BOARD_STATE) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A stand-in for Apollo: savedViews returns `server`; upsert creates (fresh UUID) or refuses names over 120 characters like the server does. */
function fakeClient(server: ServerView[]) {
  let next = 100;
  const mutate = vi.fn(async ({ mutation, variables }: { mutation: unknown; variables: { input?: { id?: string; name: string }; id?: string } }) => {
    if (mutation === SAVED_VIEW_UPSERT_MUTATION) {
      const input = variables.input!;
      if (input.name.length > 120) return { data: { savedViewUpsert: { success: false, message: 'A saved view needs a name (1–120 characters)', view: null } } };
      const view = serverView(input.id ?? uuid(next++), input.name);
      server.push(view);
      return { data: { savedViewUpsert: { success: true, view } } };
    }
    if (mutation === SAVED_VIEW_DELETE_MUTATION) {
      const index = server.findIndex((view) => view.id === variables.id);
      if (index >= 0) server.splice(index, 1);
      return { data: { savedViewDelete: { success: true, id: variables.id } } };
    }
    throw new Error('unexpected mutation');
  });
  const query = vi.fn(async () => ({ data: { savedViews: server.map((view) => ({ ...view })) } }));
  return { client: { mutate, query } as unknown as ApolloClient, mutate, query };
}

const upsertCalls = (mutate: ReturnType<typeof vi.fn>) => mutate.mock.calls.filter(([options]) => (options as { mutation: unknown }).mutation === SAVED_VIEW_UPSERT_MUTATION);
const deleteCalls = (mutate: ReturnType<typeof vi.fn>) => mutate.mock.calls.filter(([options]) => (options as { mutation: unknown }).mutation === SAVED_VIEW_DELETE_MUTATION);

describe('saved views sync', () => {
  let stop: (() => void) | null = null;
  beforeEach(() => { window.localStorage.clear(); setSavedViewsAccount('user-a'); });
  afterEach(() => { stop?.(); stop = null; setSavedViewsAccount(null); window.localStorage.clear(); });

  // INV-1192: a view made in the browser (id view-<time>) gets a server UUID on its first upsert.
  it('keeps a newly created view on the server instead of deleting its new UUID in the same round', async () => {
    window.localStorage.setItem(SAVED_VIEWS_MIGRATED_KEY('user-a', 'INV'), 'done');
    const server: ServerView[] = [];
    const { client, mutate } = fakeClient(server);
    stop = startSavedViewsSync(client, 'INV', 'user-a');
    await flush();

    writeSavedBoardViews('INV', [{ id: 'view-1700000000000', name: 'Mine', state: BOARD_STATE }]);
    await vi.waitFor(() => expect(upsertCalls(mutate)).toHaveLength(1));
    await flush();

    expect(deleteCalls(mutate)).toHaveLength(0);
    expect(server.map((view) => view.id)).toEqual([uuid(100)]);
    expect(readSavedBoardViews('INV').map((view) => view.id)).toEqual([uuid(100)]);
  });

  it('still deletes a server view that was removed locally', async () => {
    window.localStorage.setItem(SAVED_VIEWS_MIGRATED_KEY('user-a', 'INV'), 'done');
    const server: ServerView[] = [serverView(uuid(1), 'Keep'), serverView(uuid(2), 'Drop')];
    const { client, mutate } = fakeClient(server);
    stop = startSavedViewsSync(client, 'INV', 'user-a');
    await vi.waitFor(() => expect(readSavedBoardViews('INV')).toHaveLength(2));

    writeSavedBoardViews('INV', readSavedBoardViews('INV').filter((view) => view.name === 'Keep'));
    await vi.waitFor(() => expect(deleteCalls(mutate)).toHaveLength(1));
    expect(deleteCalls(mutate)[0]![0]).toMatchObject({ variables: { id: uuid(2) } });
    expect(server.map((view) => view.name)).toEqual(['Keep']);
  });

  // INV-1193: an upsert the server refuses (success=false) must not cost the only copy of the view.
  it('keeps local views the server refused during the first migration and retries them without duplicates', async () => {
    const tooLong = 'x'.repeat(121);
    writeSavedBoardViews('INV', [
      { id: 'view-ok', name: 'Fine', state: BOARD_STATE },
      { id: 'view-long', name: tooLong, state: BOARD_STATE },
    ]);
    const server: ServerView[] = [];
    const first = fakeClient(server);
    stop = startSavedViewsSync(first.client, 'INV', 'user-a');
    await vi.waitFor(() => expect(upsertCalls(first.mutate)).toHaveLength(2));
    await flush();

    // Not declared done; the refused view is still here, the accepted one now carries its server id.
    expect(window.localStorage.getItem(SAVED_VIEWS_MIGRATED_KEY('user-a', 'INV'))).toBeNull();
    expect(readSavedBoardViews('INV').map((view) => [view.id, view.name])).toEqual([[uuid(100), 'Fine'], ['view-long', tooLong]]);
    stop();

    // The person shortens the name; the next start uploads only that view.
    window.localStorage.setItem('involute.board.savedViews.user-a.INV', JSON.stringify(readSavedBoardViews('INV').map((view) => (view.id === 'view-long' ? { ...view, name: 'Shorter' } : view))));
    const second = fakeClient(server);
    stop = startSavedViewsSync(second.client, 'INV', 'user-a');
    await vi.waitFor(() => expect(window.localStorage.getItem(SAVED_VIEWS_MIGRATED_KEY('user-a', 'INV'))).not.toBeNull());

    expect(upsertCalls(second.mutate).map(([options]) => (options as { variables: { input: { name: string } } }).variables.input.name)).toEqual(['Shorter']);
    expect(server.map((view) => view.name)).toEqual(['Fine', 'Shorter']);
    expect(readSavedBoardViews('INV').map((view) => view.name)).toEqual(['Fine', 'Shorter']);
  });

  // INV-1194: the browser's copy belongs to one account.
  it('drops a pull still in flight for the previous account instead of writing it into the next account\'s copy', async () => {
    window.localStorage.setItem(SAVED_VIEWS_MIGRATED_KEY('user-a', 'INV'), 'done');
    let answer: (value: unknown) => void = () => {};
    const query = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const mutate = vi.fn();
    stop = startSavedViewsSync({ query, mutate } as unknown as ApolloClient, 'INV', 'user-a');

    setSavedViewsAccount('user-b');
    answer({ data: { savedViews: [serverView(uuid(1), 'A private')] } });
    await flush();

    expect(readSavedBoardViews('INV')).toEqual([]);
    expect(Object.keys(window.localStorage).some((key) => key.includes('user-b'))).toBe(false);
    setSavedViewsAccount('user-a');
    expect(readSavedBoardViews('INV')).toEqual([]);
  });

  it('shows the next account nothing of the previous one when its own pull fails', async () => {
    writeSavedBoardViews('INV', [{ id: uuid(1), name: 'A private', state: BOARD_STATE, visibility: 'PRIVATE', ownerId: 'user-a' }]);
    setSavedViewsAccount('user-b');
    const query = vi.fn(async () => { throw new Error('offline'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stop = startSavedViewsSync({ query, mutate: vi.fn() } as unknown as ApolloClient, 'INV', 'user-b');
    await flush();

    expect(readSavedBoardViews('INV')).toEqual([]);
    setSavedViewsAccount('user-a');
    expect(readSavedBoardViews('INV').map((view) => view.name)).toEqual(['A private']);
  });

  it('moves only team-shared and own views out of a copy saved before views were kept per account', () => {
    setSavedViewsAccount(null);
    window.localStorage.setItem('involute.board.savedViews.INV', JSON.stringify([
      { id: 'view-1', name: 'Nobody knows whose', state: BOARD_STATE },
      { id: uuid(2), name: 'Shared', state: BOARD_STATE, visibility: 'TEAM', ownerId: 'user-a' },
      { id: uuid(3), name: 'Bob own', state: BOARD_STATE, visibility: 'PRIVATE', ownerId: 'user-b' },
      { id: uuid(4), name: 'Alice own', state: BOARD_STATE, visibility: 'PRIVATE', ownerId: 'user-a' },
    ]));
    window.localStorage.setItem('involute.views.migrated.INV', 'done');

    setSavedViewsAccount('user-b');

    expect(readSavedBoardViews('INV').map((view) => view.name)).toEqual(['Shared', 'Bob own']);
    expect(window.localStorage.getItem('involute.board.savedViews.INV')).toBeNull();
    expect(window.localStorage.getItem('involute.views.migrated.INV')).toBeNull();
    setSavedViewsAccount('user-a');
    expect(readSavedBoardViews('INV')).toEqual([]);
  });
});
