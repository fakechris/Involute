import type { ApolloClient } from '@apollo/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSavedBoardViews, writeSavedBoardViews, type BoardViewState } from '../board/views';
import { SAVED_VIEW_DELETE_MUTATION, SAVED_VIEW_UPSERT_MUTATION } from '../work/queries';
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
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { stop?.(); stop = null; window.localStorage.clear(); });

  // INV-1192: a view made in the browser (id view-<time>) gets a server UUID on its first upsert.
  it('keeps a newly created view on the server instead of deleting its new UUID in the same round', async () => {
    window.localStorage.setItem(SAVED_VIEWS_MIGRATED_KEY('INV'), 'done');
    const server: ServerView[] = [];
    const { client, mutate } = fakeClient(server);
    stop = startSavedViewsSync(client, 'INV');
    await flush();

    writeSavedBoardViews('INV', [{ id: 'view-1700000000000', name: 'Mine', state: BOARD_STATE }]);
    await vi.waitFor(() => expect(upsertCalls(mutate)).toHaveLength(1));
    await flush();

    expect(deleteCalls(mutate)).toHaveLength(0);
    expect(server.map((view) => view.id)).toEqual([uuid(100)]);
    expect(readSavedBoardViews('INV').map((view) => view.id)).toEqual([uuid(100)]);
  });

  it('still deletes a server view that was removed locally', async () => {
    window.localStorage.setItem(SAVED_VIEWS_MIGRATED_KEY('INV'), 'done');
    const server: ServerView[] = [serverView(uuid(1), 'Keep'), serverView(uuid(2), 'Drop')];
    const { client, mutate } = fakeClient(server);
    stop = startSavedViewsSync(client, 'INV');
    await vi.waitFor(() => expect(readSavedBoardViews('INV')).toHaveLength(2));

    writeSavedBoardViews('INV', readSavedBoardViews('INV').filter((view) => view.name === 'Keep'));
    await vi.waitFor(() => expect(deleteCalls(mutate)).toHaveLength(1));
    expect(deleteCalls(mutate)[0]![0]).toMatchObject({ variables: { id: uuid(2) } });
    expect(server.map((view) => view.name)).toEqual(['Keep']);
  });
});
