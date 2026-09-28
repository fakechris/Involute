import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// Members is a team's roster. With several teams it has to say which one,
// and the sidebar puts it under the team rather than in Workspace.
const twoTeams = {
  ...boardQueryResult,
  teams: {
    nodes: [
      ...boardQueryResult.teams.nodes,
      { ...boardQueryResult.teams.nodes[0]!, id: 'team-2', key: 'LUM', name: 'LumenBox' },
    ],
  },
};

function signIn() {
  mockSessionState({
    authMode: 'session',
    authenticated: true,
    googleOAuthConfigured: true,
    viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' },
  });
}

describe('Members belongs to a team', () => {
  it('shows the team named in the link, not the last team used on the board', async () => {
    window.localStorage.setItem('involute.teamKey', 'INV');
    signIn();
    renderApp({ data: twoTeams, loading: false }, ['/members?team=LUM']);

    expect(await screen.findByText(/of team LumenBox \(LUM\)/)).toBeInTheDocument();
  });

  it('is not a Workspace item', async () => {
    signIn();
    renderApp({ data: twoTeams, loading: false }, ['/']);

    const nav = await screen.findByRole('complementary', { name: 'Workspace navigation' });
    const workspaceLinks = within(nav).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(workspaceLinks).not.toContain('/members');
  });
});
