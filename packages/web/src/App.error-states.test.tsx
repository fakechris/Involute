import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

function renderTestApp(
  queryState: {
    data?: typeof boardQueryResult;
    error?: Error;
    loading?: boolean;
  } = { data: boardQueryResult, loading: false },
  initialEntries: string[] = ['/'],
) {
  return renderApp(App, queryState, initialEntries);
}

describe('App error states', () => {
  it('shows a user-friendly error state when the API request fails', async () => {
    renderTestApp({
      error: new Error('connect ECONNREFUSED 127.0.0.1:4200'),
      loading: false,
    });

    expect(
      await screen.findByText(
        'We could not load the board right now. Please confirm the API server is running and try again.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a distinct invalid-token error when the board request is unauthenticated with a configured token', async () => {
    window.localStorage.setItem('involute.authToken', 'wrong-token');

    renderTestApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The board sent a runtime auth token, but the API rejected it. Confirm the configured token matches the server and reload.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a missing-token bootstrap error when no runtime token exists outside dev fallback', async () => {
    vi.stubEnv('DEV', false);

    renderTestApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Authentication required')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Sign in with Google to use the board, or set `VITE_INVOLUTE_AUTH_TOKEN` / localStorage `involute.authToken` for trusted local development.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a distinct dev-default-token error when the fallback dev token is rejected', async () => {
    renderTestApp({
      error: new Error('Not authenticated'),
      loading: false,
    });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The board used the default development token, but the API rejected it. Set `VITE_INVOLUTE_AUTH_TOKEN` or store a valid token in localStorage under `involute.authToken`, then reload.',
      ),
    ).toBeInTheDocument();
  });
});
