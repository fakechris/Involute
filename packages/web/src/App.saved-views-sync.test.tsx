import type { ApolloClient } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The helpers mock Apollo's hooks; they load before App so App sees the mocks.
import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';
import { App } from './App';
import { ACTIVE_TEAM_STORAGE_KEY } from './board/utils';
import { type BoardViewState } from './board/views';
import { getSavedViewsAccount, setSavedViewsAccount } from './lib/saved-views-account';
import { SAVED_VIEW_UPSERT_MUTATION, SAVED_VIEWS_ACCOUNT_QUERY, SAVED_VIEWS_QUERY } from './work/queries';

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

  it('keeps a view saved on another device when this board saves a new one (INV-2157)', async () => {
    const server = fakeServer();
    server.views.push({ id: '00000000-0000-4000-8000-000000000999', ownerId: 'user-a', name: 'Other device', kind: 'board', visibility: 'PRIVATE', stateJson: JSON.stringify(BOARD_STATE) });
    vi.spyOn(window, 'prompt').mockReturnValue('Saved here');
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    signIn('user-a', 'Alice');
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('option', { name: 'Other device' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(server.views.map((view) => view.name).sort()).toEqual(['Other device', 'Saved here']));
    expect(server.mutate.mock.calls.filter(([options]) => (options as { mutation: unknown }).mutation !== SAVED_VIEW_UPSERT_MUTATION)).toHaveLength(0);
  });

  it('restores the same Board state filter from the saved view card and the Board dropdown', async () => {
    const server = fakeServer();
    const viewName = 'Ready queue';
    vi.spyOn(window, 'prompt').mockReturnValue(viewName);
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    signIn('user-a', 'Alice');
    const openApp = () => renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    openApp();
    await screen.findByRole('button', { name: 'Sign out' });
    await waitFor(() => expect(savedViewsQueries(server.query)).toHaveLength(1));

    const readyFilter = () => screen.queryByRole('button', { name: 'Remove State: Ready' });
    const expectReadyOnly = () => {
      expect(readyFilter()).toBeInTheDocument();
      expect(within(screen.getByTestId('column-Ready')).getByText('Ready item')).toBeInTheDocument();
      expect(screen.queryByTestId('issue-card-issue-1')).not.toBeInTheDocument();
    };
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(within(screen.getByLabelText('Board filters')).getByRole('button', { name: 'States' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ready' }));
    expectReadyOnly();
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(server.views.map((view) => view.name)).toEqual([viewName]));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(readyFilter()).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Load saved board view'), { target: { value: server.views[0]!.id } });
    expectReadyOnly();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(readyFilter()).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Views' }));
    const card = await screen.findByLabelText(`View ${viewName}`);
    fireEvent.click(within(card).getByRole('button', { name: /Ready queue/ }));
    await waitFor(expectReadyOnly);

    cleanup();
    openApp();
    await waitFor(expectReadyOnly);
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

// INV-2157: token sign-in (bearer token + viewer assertion, as the e2e stack runs) has no cookie
// session, so /auth/session names nobody; the views are kept for the viewer GraphQL names.
describe('saved views in token sign-in mode', () => {
  beforeEach(() => setSavedViewsAccount(null));

  it('stores a view saved on the board for the GraphQL viewer and syncs it', async () => {
    const server = fakeServer();
    const answer = server.query.getMockImplementation()!;
    server.query.mockImplementation((async (options: { query: unknown }) =>
      options.query === SAVED_VIEWS_ACCOUNT_QUERY ? { data: { viewer: { id: 'user-token' } } } : answer()) as never);
    vi.spyOn(window, 'prompt').mockReturnValue('Token queue');
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    mockSessionState({ authMode: 'token', authenticated: false, googleOAuthConfigured: false });
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    await waitFor(() => expect(getSavedViewsAccount()).toBe('user-token'));
    await waitFor(() => expect(savedViewsQueries(server.query)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(server.views.map((view) => view.name)).toEqual(['Token queue']));
    expect(window.localStorage.getItem('involute.board.savedViews.user-token.INV')).toContain('Token queue');
  });

  it('keeps a view saved before the GraphQL viewer is known (INV-2157)', async () => {
    const server = fakeServer();
    const answer = server.query.getMockImplementation()!;
    let knowViewer: () => void = () => undefined;
    const viewerKnown = new Promise<void>((resolve) => { knowViewer = resolve; });
    server.query.mockImplementation((async (options: { query: unknown }) => {
      if (options.query !== SAVED_VIEWS_ACCOUNT_QUERY) return answer();
      await viewerKnown;
      return { data: { viewer: { id: 'user-early' } } };
    }) as never);
    vi.spyOn(window, 'prompt').mockReturnValue('Early token queue');
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'INV');
    mockSessionState({ authMode: 'token', authenticated: false, googleOAuthConfigured: false });
    renderApp(server.Device, { data: boardQueryResult, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(getSavedViewsAccount()).toBeNull();

    knowViewer();
    await waitFor(() => expect(server.views.map((view) => view.name)).toEqual(['Early token queue']));
    expect(screen.getByRole('option', { name: 'Early token queue' })).toBeInTheDocument();
    expect(window.localStorage.getItem('involute.board.savedViews.user-early.INV')).toContain('Early token queue');
  });
});
