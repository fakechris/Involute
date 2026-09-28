import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apolloMocks, boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// INV-853: the sidebar's Teams section comes from the server, so a browser that
// never opened the board still reaches a team's Members and Settings.
describe('sidebar teams', () => {
  it('are loaded for a signed-in person on a page other than the board', async () => {
    window.localStorage.clear();
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'a@x.com', name: 'A', globalRole: 'ADMIN' } });
    renderApp({ data: boardQueryResult, loading: false }, ['/settings']);

    const nav = await screen.findByRole('complementary', { name: 'Workspace navigation' });
    expect(await within(nav).findByText('Teams')).toBeInTheDocument();
    const sources = apolloMocks.useQuery.mock.calls.map(([doc]) => String((doc as { loc?: { source: { body: string } } })?.loc?.source.body ?? ''));
    expect(sources.some((body) => body.includes('query ShellTeams'))).toBe(true);
  });
});
