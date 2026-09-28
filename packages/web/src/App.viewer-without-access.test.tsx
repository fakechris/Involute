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

  it('is not offered Add to team on the team members page', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/teams/INV/members']);

    expect(await screen.findByRole('table', { name: 'Team members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to team' })).not.toBeInTheDocument();
  });

  it('does not see the Administration settings', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/settings']);

    expect(await screen.findByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    expect(screen.queryByText('ADMINISTRATION')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Security' })).not.toBeInTheDocument();
  });

  it('is not offered team settings, including agent credentials', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, agentsTabCanManage: false, loading: false }, ['/teams/INV/settings?section=agents']);

    expect(await screen.findByText(/Only this team.s owners and workspace admins change its settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue credential' })).not.toBeInTheDocument();
  });

  it('sees which team the roster belongs to, what the roles mean, and cannot change roles or remove anyone', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/teams/INV/members']);

    expect(await screen.findByRole('navigation', { name: 'Team pages' })).toBeInTheDocument();
    expect(screen.getAllByText('Involute').length).toBeGreaterThan(0);
    expect(screen.getByText(/Roles are per team/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Team role for/)).not.toBeInTheDocument();
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  });

  it('is not offered Create issue or Report bug on the board', async () => {
    signInWithoutAccess();
    renderApp({ data: noAccess, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create issue/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report bug/ })).not.toBeInTheDocument();
  });

  it('still sees the buttons as a team owner', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/teams/INV/members']);
    expect(await screen.findByRole('button', { name: 'Add to team' })).toBeInTheDocument();
  });
});
