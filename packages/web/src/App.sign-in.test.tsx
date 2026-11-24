import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { AppApolloProvider } from './lib/apollo';
import { FOCUS_REFETCH_MIN_INTERVAL_MS, RevisitRefresh } from './lib/revisit-refresh';
import { readSignInReturn, type AuthProviderDescriptor } from './lib/session';

vi.mock('./routes/IssuePage', async () => {
  const { useState } = await import('react');
  const { useCloseReason } = await import('./components/CloseReasonDialog');
  const { DialogShell } = await import('./components/DialogShell');
  return {
    IssuePage() {
      const [open, setOpen] = useState(false);
      const { askCloseReason, closeReasonDialog } = useCloseReason();
      return (
        <main>
          <button onClick={() => setOpen(true)}>Edit issue</button>
          {closeReasonDialog}
          {open ? (
            <DialogShell
              title="Edit issue"
              variant="side"
              eyebrow={<button type="button" onClick={() => void askCloseReason({ title: 'Cancel issue', needsReason: true })}>Cancel issue</button>}
              onClose={() => setOpen(false)}
              onSubmit={(event) => event.preventDefault()}
            >
              <textarea aria-label="Description" />
            </DialogShell>
          ) : null}
        </main>
      );
    },
  };
});

function renderApp(
  session: 'signed-out' | 'signed-in',
  graphql: (operation: string, variables: { query?: string }) => Response | Promise<Response>,
  provider: AuthProviderDescriptor | null = { id: 'google', startUrl: '/auth/google/start', label: 'Sign in with Google' },
) {
  vi.stubGlobal('fetch', vi.fn(async (req: string, init?: RequestInit) => {
    if (req.endsWith('/auth/session')) return Response.json({
      authMode: session === 'signed-in' ? 'session' : 'none',
      authenticated: session === 'signed-in',
      viewer: session === 'signed-in' ? { id: 'viewer-1', email: 'viewer@example.test', name: 'Viewer', globalRole: 'USER' } : null,
      authProviders: provider ? [provider] : [],
      googleOAuthConfigured: provider?.id === 'google',
    }, { status: session === 'signed-in' ? 200 : 401 });
    const { operationName, variables } = JSON.parse(String(init?.body ?? '{}'));
    return graphql(operationName ?? '', variables ?? {});
  }));

  return render(<AppApolloProvider><BrowserRouter><RevisitRefresh /><App /></BrowserRouter></AppApolloProvider>);
}

const graphqlAuthError = () => Response.json({ errors: [{ message: 'Not authenticated' }] });
const codedAuthError = () => Response.json({ errors: [{ message: 'Session ended', extensions: { code: 'UNAUTHENTICATED' } }] });
const httpAuthError = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
const unavailable = () => Response.json({ error: 'Unavailable' }, { status: 500 });
const boardResponse = () => Response.json({
  data: {
    teams: { nodes: [{
      id: 'team-1', key: 'INV', name: 'Involute', viewerCanWrite: true, viewerCanManage: true, issueCount: 0,
      memberships: { nodes: [] }, states: { nodes: [] },
    }] },
    projectSummary: { totalCount: 0, noRepositoryCount: 0, projects: [], projectsWithoutRepository: [] },
    users: { nodes: [] }, issueLabels: { nodes: [] }, issueStateCounts: [],
    issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('expired session query failures', () => {
  it.each([
    ['/candidates', graphqlAuthError],
    ['/todo', codedAuthError],
    ['/graph', httpAuthError],
    ['/work/INV-1', graphqlAuthError],
    ['/agents', httpAuthError],
    ['/ops', codedAuthError],
    ['/hygiene', graphqlAuthError],
    ['/projects', httpAuthError],
    ['/my-issues', httpAuthError],
    ['/inbox', httpAuthError],
  ] as const)('offers one page-level sign-in action without Retry on %s', async (path, graphql) => {
    window.history.replaceState(null, '', path);
    renderApp('signed-out', graphql);

    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    const main = within(screen.getByRole('main'));
    expect(screen.queryByText(/Your session ended/i)).not.toBeInTheDocument();
    expect(main.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', expect.stringContaining('/auth/google/start'));
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Not authenticated|Delivery changes could not be loaded/i)).not.toBeInTheDocument();
  });

  it('clears the session-ended notice when the tab comes back after signing in again (INV-2146)', async () => {
    window.history.replaceState(null, '', '/candidates');
    let signedIn = false;
    vi.stubGlobal('fetch', vi.fn(async (req: string, init?: RequestInit) => {
      if (req.endsWith('/auth/session')) return Response.json({
        authMode: 'session', authenticated: true,
        viewer: { id: 'viewer-1', email: 'viewer@example.test', name: 'Viewer', globalRole: 'USER' },
        authProviders: [{ id: 'google', startUrl: '/auth/google/start', label: 'Sign in with Google' }], googleOAuthConfigured: true,
      });
      void init;
      return signedIn ? Response.json({ data: null }) : graphqlAuthError();
    }));
    render(<AppApolloProvider><BrowserRouter><RevisitRefresh /><App /></BrowserRouter></AppApolloProvider>);
    expect(await screen.findByText('Your session ended. Copy any unsaved text before you sign in.')).toBeVisible();

    // Signed in again elsewhere; this tab finds out when it gets focus back.
    signedIn = true;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  it('removes stale signed-in controls when a query reports an expired session', async () => {
    window.history.replaceState(null, '', '/candidates');
    let finishRequest!: () => void;
    const gate = new Promise<void>((resolve) => { finishRequest = resolve; });
    renderApp('signed-in', async () => {
      await gate;
      return graphqlAuthError();
    });
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeVisible();
    finishRequest();

    expect(await screen.findByText('Your session ended. Copy any unsaved text before you sign in.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(within(screen.getByText(/Your session ended/).parentElement!).getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  it('keeps an open form and its draft when the Activity poll finds an expired session', async () => {
    window.history.replaceState(null, '', '/issue/INV-1');
    const setTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
      setTimeout(callback, delay === 60_000 ? 50 : delay, ...args),
    );
    let expired = false;
    const unreadCount = vi.fn(() => expired ? codedAuthError() : Response.json({ data: { unreadNotificationCount: 0 } }));
    renderApp('signed-in', (operation) =>
      operation === 'UnreadNotificationCount' ? unreadCount() : Response.json({ data: null }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit issue' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit issue' });
    const draft = within(dialog).getByRole('textbox', { name: 'Description' });
    fireEvent.change(draft, { target: { value: 'Unsaved description' } });
    await waitFor(() => expect(unreadCount).toHaveBeenCalled());
    expect(screen.queryByText(/Your session ended/i)).not.toBeInTheDocument();
    expired = true;

    const prompt = await within(dialog).findByText('Your session ended. Copy any unsaved text before you sign in.');
    expect(screen.getAllByText(prompt.textContent!)).toEqual([prompt]);
    expect(within(dialog).getByRole('alert')).toContainElement(prompt);
    expect(within(prompt.parentElement!).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', expect.stringContaining('/auth/google/start'));
    expect(screen.getByRole('dialog', { name: 'Edit issue' })).toBe(dialog);
    expect(draft).toHaveValue('Unsaved description');
    expect(draft).toHaveFocus();

    fireEvent.keyDown(draft, { key: 'Tab' });
    expect(within(dialog).getByRole('link', { name: 'Sign in' })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Edit issue' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('alert')).getByText(prompt.textContent!)).toBeVisible();
  });

  it('keeps a Board bug draft when tab return discovers expiry and skips later refreshes', async () => {
    window.history.replaceState(null, '', '/?team=INV');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    let expired = false;
    const board = vi.fn(() => expired ? httpAuthError() : boardResponse());
    renderApp('signed-in', (operation) => operation === 'BoardPage' ? board() : Response.json({ data: null }));

    fireEvent.click(await screen.findByRole('button', { name: 'Report bug' }));
    const dialog = screen.getByRole('dialog', { name: 'Report bug drawer' });
    const draft = within(dialog).getByRole('textbox', { name: 'Bug title' });
    fireEvent.change(draft, { target: { value: 'Unsaved bug title' } });
    const initialRequests = board.mock.calls.length;
    expired = true;
    fireEvent.focus(window);

    const prompt = await within(dialog).findByText('Your session ended. Copy any unsaved text before you sign in.');
    expect(screen.getAllByText(prompt.textContent!)).toEqual([prompt]);
    expect(board).toHaveBeenCalledTimes(initialRequests + 1);
    expect(screen.getByRole('dialog', { name: 'Report bug drawer' })).toBe(dialog);
    expect(draft).toHaveValue('Unsaved bug title');

    clock.mockReturnValue(Date.now() + FOCUS_REFETCH_MIN_INTERVAL_MS);
    fireEvent.focus(window);
    expect(board).toHaveBeenCalledTimes(initialRequests + 1);
  });

  it('puts the only session notice inside the Close reason dialog above the open drawer', async () => {
    window.history.replaceState(null, '', '/issue/INV-1');
    const setTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
      setTimeout(callback, delay === 60_000 ? 50 : delay, ...args),
    );
    let expired = false;
    renderApp('signed-in', (operation) => operation === 'UnreadNotificationCount'
      ? expired ? codedAuthError() : Response.json({ data: { unreadNotificationCount: 0 } })
      : Response.json({ data: null }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit issue' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit issue' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel issue' }));
    const dialog = screen.getByRole('dialog', { name: 'Close reason' });
    const reason = within(dialog).getByRole('textbox', { name: 'Close reason text' });
    fireEvent.change(reason, { target: { value: 'Unsaved reason' } });
    expired = true;

    const prompt = await within(dialog).findByText('Your session ended. Copy any unsaved text before you sign in.');
    expect(screen.getAllByText(prompt.textContent!)).toEqual([prompt]);
    expect(reason).toHaveValue('Unsaved reason');
    const keepOpen = within(dialog).getByRole('button', { name: 'Keep open' });
    keepOpen.focus();
    fireEvent.keyDown(keepOpen, { key: 'Tab' });
    expect(within(dialog).getByRole('link', { name: 'Sign in' })).toHaveFocus();

    fireEvent.click(keepOpen);
    const drawerPrompt = within(drawer).getByText(prompt.textContent!);
    expect(screen.getAllByText(prompt.textContent!)).toEqual([drawerPrompt]);
  });

  it('shows the Board load error instead of the old view when a new filter gets an auth error', async () => {
    window.history.replaceState(null, '', '/?team=INV');
    const board = vi.fn((query?: string) => query ? httpAuthError() : boardResponse());
    renderApp('signed-in', (operation, variables) =>
      operation === 'BoardPage' ? board(variables.query) : Response.json({ data: null }),
    );

    expect(await screen.findByRole('button', { name: 'Report bug' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Superseded, open' }));

    expect(await screen.findByText('Your session ended. Sign in to load this view.')).toBeVisible();
    expect(board).toHaveBeenCalledWith('superseded:yes -state-type:canceled,completed');
    expect(screen.queryByRole('button', { name: 'Report bug' })).not.toBeInTheDocument();
  });

  it('warns people to copy unsaved text when no sign-in provider is configured', async () => {
    window.history.replaceState(null, '', '/candidates');
    let finishRequest!: () => void;
    const gate = new Promise<void>((resolve) => { finishRequest = resolve; });
    renderApp('signed-in', async () => {
      await gate;
      return codedAuthError();
    }, null);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeVisible();
    finishRequest();

    const prompt = await screen.findByText('Your session ended. Copy any unsaved text, then contact your workspace admin to sign in.');
    expect(prompt).toBeVisible();
    expect(within(prompt.parentElement!).queryByRole('link')).not.toBeInTheDocument();
  });

  it('uses the DingTalk session notice and saves the failed Board filter as the sign-in destination', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_INVOLUTE_AUTH_TOKEN', '');
    window.history.replaceState(null, '', '/?team=INV');
    renderApp(
      'signed-in',
      (operation, { query }) => operation === 'BoardPage'
        ? query ? graphqlAuthError() : boardResponse()
        : Response.json({ data: null }),
      { id: 'dingtalk', label: '钉钉登录', startUrl: '/auth/dingtalk/start' },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Superseded, open' }));
    expect(await screen.findByText('Your session ended. Sign in to load this view.')).toBeVisible();
    expect(within(screen.getByRole('main')).queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with Google' })).not.toBeInTheDocument();

    const signIn = within(screen.getByRole('alert')).getByRole('link', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('href', expect.stringContaining('/auth/dingtalk/start'));
    signIn.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(signIn);

    expect(window.location.href).toContain('query=');
    expect(readSignInReturn()).toBe(`/${window.location.search}`);
  });

  it('leaves a 500 as a retryable error', async () => {
    window.history.replaceState(null, '', '/candidates');
    renderApp('signed-out', unavailable);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Sign in to continue' })).not.toBeInTheDocument();
  });

  it('returns to the original path, filters and anchor after sign-in', async () => {
    const destination = '/graph?project=acme/tools&view=timeline#graph';
    window.history.replaceState(null, '', destination);
    const app = renderApp('signed-out', httpAuthError);
    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    const signIn = await within(screen.getByRole('main')).findByRole('link', { name: 'Sign in with Google' });
    signIn.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(signIn);
    app.unmount();

    window.history.replaceState(null, '', '/');
    renderApp('signed-in', unavailable);

    expect(screen.getByText('Restoring your page…')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Board' })).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.href).toContain(destination));
    expect(readSignInReturn()).toBeNull();
  });
});
