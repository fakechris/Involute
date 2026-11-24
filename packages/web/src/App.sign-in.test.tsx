import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { AppApolloProvider } from './lib/apollo';
import { readSignInReturn } from './lib/session';

function renderApp(session: 'signed-out' | 'signed-in', graphql: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((req: string) => Promise.resolve(req.endsWith('/auth/session')
    ? Response.json({
      authMode: session === 'signed-in' ? 'session' : 'none',
      authenticated: session === 'signed-in',
      viewer: session === 'signed-in' ? { id: 'viewer-1', email: 'viewer@example.test', name: 'Viewer', globalRole: 'USER' } : null,
      authProviders: [{ id: 'google', startUrl: '/auth/google/start', label: 'Sign in with Google' }],
      googleOAuthConfigured: true,
    }, { status: session === 'signed-in' ? 200 : 401 })
    : graphql())));

  return render(<AppApolloProvider><BrowserRouter><App /></BrowserRouter></AppApolloProvider>);
}

const graphqlAuthError = () => Response.json({ errors: [{ message: 'Not authenticated' }] });
const codedAuthError = () => Response.json({ errors: [{ message: 'Session ended', extensions: { code: 'UNAUTHENTICATED' } }] });
const httpAuthError = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
const unavailable = () => Response.json({ error: 'Unavailable' }, { status: 500 });

afterEach(() => {
  cleanup();
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
    expect(main.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute('href', expect.stringContaining('/auth/google/start'));
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Not authenticated|Delivery changes could not be loaded/i)).not.toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Sign in with Google' })).toHaveLength(2);
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
