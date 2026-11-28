import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { AppApolloProvider } from './lib/apollo';
import { RevisitRefresh } from './lib/revisit-refresh';

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
const unavailable = () => Response.json({ error: 'Unavailable' }, { status: 500 });

function renderBoard(board: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (req: string, init?: RequestInit) => {
    if (req.endsWith('/auth/session')) {
      return Response.json({
        authMode: 'session',
        authenticated: true,
        viewer: { id: 'viewer-1', email: 'viewer@example.test', name: 'Viewer', globalRole: 'USER' },
        authProviders: [],
        googleOAuthConfigured: false,
      });
    }
    const { operationName } = JSON.parse(String(init?.body ?? '{}'));
    return operationName === 'BoardPage' ? board() : Response.json({ data: null });
  }));
  return render(<AppApolloProvider><BrowserRouter><RevisitRefresh /><App /></BrowserRouter></AppApolloProvider>);
}

/** Wait until the mock has had no new call for 300 ms. */
async function settled(mock: { mock: { calls: unknown[] } }) {
  let seen = -1;
  while (seen !== mock.mock.calls.length) {
    seen = mock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Board refresh failures (INV-2312)', () => {
  it('keeps the board on screen and offers Retry when a refresh fails', async () => {
    window.history.replaceState(null, '', '/?team=INV');
    let failing = false;
    const board = vi.fn(() => (failing ? unavailable() : boardResponse()));
    renderBoard(board);

    expect(await screen.findByRole('button', { name: 'Report bug' })).toBeVisible();
    failing = true;
    fireEvent.focus(window);

    expect(await screen.findByText(/The board could not refresh, so it shows what was loaded before\./)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeVisible();
    expect(screen.queryByText('Board unavailable')).not.toBeInTheDocument();

    failing = false;
    const before = board.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/The board could not refresh/)).not.toBeInTheDocument());
    expect(board.mock.calls.length).toBeGreaterThan(before);
  });

  it('opening and closing a drawer does not refetch the board', async () => {
    window.history.replaceState(null, '', '/?team=INV');
    const board = vi.fn(boardResponse);
    renderBoard(board);

    expect(await screen.findByRole('button', { name: 'Report bug' })).toBeVisible();
    // The first load may ask twice; count from when it has settled.
    await settled(board);
    const before = board.mock.calls.length;
    // What the board does when a drawer opens (?issue=) and closes: a new
    // history entry on the same path with a different query string.
    window.history.pushState({ usr: null, key: 'drawer-open', idx: 1 }, '', '/?team=INV&issue=INV-1');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    await settled(board); // a person looks at the drawer before closing it
    window.history.pushState({ usr: null, key: 'drawer-closed', idx: 2 }, '', '/?team=INV');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    await settled(board);
    expect(board).toHaveBeenCalledTimes(before);

    // Coming back to exactly the same page is still a revisit and refreshes (INV-738).
    window.history.pushState({ usr: null, key: 'same-page', idx: 3 }, '', '/?team=INV');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    await waitFor(() => expect(board.mock.calls.length).toBeGreaterThan(before));
  });

  it('still shows the full error when the board never loaded', async () => {
    window.history.replaceState(null, '', '/?team=INV');
    renderBoard(unavailable);
    expect(await screen.findByText('Board unavailable')).toBeVisible();
  });
});
