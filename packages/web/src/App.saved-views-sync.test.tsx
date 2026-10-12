import type { ApolloClient } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The helpers mock Apollo's hooks; they load before App so App sees the mocks.
import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';
import { App } from './App';
import { ACTIVE_TEAM_STORAGE_KEY } from './board/utils';
import { type BoardViewState } from './board/views';
import { setSavedViewsAccount } from './lib/saved-views-account';
import { SAVED_VIEW_UPSERT_MUTATION, SAVED_VIEWS_QUERY } from './work/queries';

// INV-1196: the running app starts the saved-views server sync (INV-1005) once it knows who is signed in.
type ServerView = { id: string; ownerId: string; name: string; kind: string; visibility: 'PRIVATE' | 'TEAM'; stateJson: string };

const BOARD_STATE: BoardViewState = { assigneeIds: [], groupBy: 'status', labelIds: [], query: '', sortDirection: 'desc', sortField: 'updatedAt', stateIds: [], viewMode: 'board', projectKey: null };
const viewer = (id: string, name: string) => ({ id, email: `${id}@example.com`, name, globalRole: 'USER' as const });
const signIn = (id: string, name: string) => mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: viewer(id, name) });

/** One server shared by every "device": savedViews returns what it holds, upsert stores a view under a fresh UUID. */
function fakeServer() {
  const views: ServerView[] = [];
  let next = 1;
  const mutate = vi.fn(async ({ mutation, variables }: { mutation: unknown; variables: { input: { id?: string; name: string; kind: string; visibility: 'PRIVATE' | 'TEAM'; stateJson: string } } }) => {
    if (mutation !== SAVED_VIEW_UPSERT_MUTATION) return { data: {} };
    const { input } = variables;
    const view: ServerView = { id: input.id ?? `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`, ownerId: 'user-a', name: input.name, kind: input.kind, visibility: input.visibility, stateJson: input.stateJson };
    views.push(view);
    return { data: { savedViewUpsert: { success: true, view } } };
  });
  const query = vi.fn(async () => ({ data: { savedViews: views.map((view) => ({ ...view })) } }));
  const client = { mutate, query } as unknown as ApolloClient;
  const Device = () => (
    <ApolloProvider client={client}>
      <App />
    </ApolloProvider>
  );
  return { Device, mutate, query, views };
}

const savedViewsQueries = (query: ReturnType<typeof vi.fn>) => query.mock.calls.filter(([options]) => (options as { query: unknown }).query === SAVED_VIEWS_QUERY);
const upserts = (mutate: ReturnType<typeof vi.fn>) => mutate.mock.calls.filter(([options]) => (options as { mutation: unknown }).mutation === SAVED_VIEW_UPSERT_MUTATION);

describe('saved views server sync in the running app (INV-1196)', () => {
  // Each test is a fresh page load: nobody is signed in until the session says so.
  beforeEach(() => setSavedViewsAccount(null));

  it('uploads a browser\'s legacy views on the first sign-in, and they are there after a reload and on another device', async () => {
    const server = fakeServer();
    // A browser from before INV-1194: views stored per team only, never sent to the server.
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    window.localStorage.setItem('involute.board.savedViews.INV', JSON.stringify([{ id: 'view-legacy', name: 'Legacy queue', state: BOARD_STATE }]));

    signIn('user-a', 'Alice');
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/views']);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await waitFor(() => expect(savedViewsQueries(server.query)[0]?.[0]).toMatchObject({ variables: { teamKey: 'INV' } }));
    await waitFor(() => expect(server.views.map((view) => view.name)).toEqual(['Legacy queue']));
    expect(upserts(server.mutate)).toHaveLength(1);
    expect(await screen.findByLabelText('View Legacy queue')).toBeInTheDocument();
    cleanup();

    // Reload: the same browser, the view now carries the server's id; nothing is uploaded twice.
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/views']);
    expect(await screen.findByLabelText('View Legacy queue')).toBeInTheDocument();
    await waitFor(() => expect(savedViewsQueries(server.query)).toHaveLength(2));
    expect(upserts(server.mutate)).toHaveLength(1);
    cleanup();

    // Another device: an empty browser sees the view from the server.
    window.localStorage.clear();
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/views']);
    expect(await screen.findByLabelText('View Legacy queue')).toBeInTheDocument();
    expect(upserts(server.mutate)).toHaveLength(1);
  });

  it('mirrors a view saved on the board to the server', async () => {
    const server = fakeServer();
    vi.spyOn(window, 'prompt').mockReturnValue('Saved on the board');
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    signIn('user-a', 'Alice');
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await waitFor(() => expect(savedViewsQueries(server.query)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(server.views.map((view) => view.name)).toEqual(['Saved on the board']));
  });

  it('does not sync before an account is known, and stops when the app goes away', async () => {
    const server = fakeServer();
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    mockSessionState({ authMode: 'session', authenticated: false, googleOAuthConfigured: true });
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    expect(await screen.findByRole('link', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(savedViewsQueries(server.query)).toHaveLength(0);
    cleanup();

    signIn('user-a', 'Alice');
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    await waitFor(() => expect(savedViewsQueries(server.query)).toHaveLength(1));
    cleanup();
    window.dispatchEvent(new CustomEvent('involute:board-saved-views', { detail: { teamKey: 'INV', views: [{ id: 'view-late', name: 'After unmount', state: BOARD_STATE }] } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upserts(server.mutate)).toHaveLength(0);
  });

  it('keeps this browser\'s views when the server cannot be reached', async () => {
    const server = fakeServer();
    server.query.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    window.localStorage.setItem('involute.board.savedViews.INV', JSON.stringify([{ id: 'view-legacy', name: 'Offline queue', state: BOARD_STATE }]));
    signIn('user-a', 'Alice');
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/views']);
    await waitFor(() => expect(savedViewsQueries(server.query)).toHaveLength(1));
    expect(await screen.findByLabelText('View Offline queue')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('involute.board.savedViews.user-a.INV') ?? '[]')).toHaveLength(1);
  });
});
