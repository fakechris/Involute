import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// 2026-09-28: a newly signed-in person on no team was offered New project,
// Invite and "Manage Team Access & RBAC". The server refuses all three, so
// the buttons were promises the product could not keep.
const noAccess = {
  ...boardQueryResult,
  teams: {
    nodes: boardQueryResult.teams.nodes.map((team) => ({ ...team, viewerCanManage: false, viewerCanWrite: false })),
  },
};

function signInWithoutAccess() {
  mockSessionState({
    authMode: 'session',
    authenticated: true,
    googleOAuthConfigured: true,
    viewer: { id: 'user-9', email: 'newcomer@example.com', name: 'Newcomer', globalRole: 'USER' },
  });
}

describe('a viewer who may neither write nor manage', () => {
  it('is not offered New project', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/projects']);

    expect(await screen.findByText('Projects')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New project/ })).not.toBeInTheDocument();
  });

  it('is not offered Invite on Members', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/members']);

    expect(await screen.findByText('Members')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  it('is told who can change access instead of being offered the RBAC buttons', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/settings?tab=access']);

    expect(await screen.findByText('Only a team owner can change access or invite people.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage Team Access/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite members/ })).not.toBeInTheDocument();
  });

  it('still sees the buttons as a team owner', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/members']);
    expect(await screen.findByRole('button', { name: 'Invite' })).toBeInTheDocument();
  });
});
