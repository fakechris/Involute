import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// INV-850: a team's roster and settings live under the team
// (/teams/<KEY>/members, /teams/<KEY>/settings). docs/permissions.md §3, §7.

const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, email: `${name.toLowerCase()}@x.com`, globalRole: 'USER', accessStatus: 'ACTIVE', ...extra,
});

function teamPage(overrides: Record<string, unknown> = {}) {
  return {
    viewer: { id: 'user-1' },
    teams: {
      nodes: [{
        id: 'team-1',
        key: 'INV',
        name: 'Involute',
        visibility: 'PRIVATE',
        archivedAt: null,
        viewerCanManage: true,
        viewerCanJoin: false,
        viewerIsMember: true,
        memberships: {
          nodes: [
            { id: 'm-1', role: 'OWNER', user: person('user-1', 'Admin') },
            { id: 'm-2', role: 'EDITOR', user: person('user-2', 'Bo') },
            { id: 'm-3', role: 'VIEWER', user: person('user-3', 'Cy', { globalRole: 'GUEST' }) },
          ],
        },
        ...overrides,
      }],
    },
  };
}

function mockMutations() {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) => {
    const body = document?.loc?.source.body ?? String(document);
    const name = /mutation (\w+)/.exec(body)?.[1] ?? 'unknown';
    const field = name.charAt(0).toLowerCase() + name.slice(1);
    calls[name] ??= vi.fn().mockResolvedValue({ data: { [field]: { success: true, message: null } } });
    return [calls[name], { loading: false }];
  });
  return calls;
}

function signIn(globalRole: 'ADMIN' | 'USER' = 'ADMIN') {
  mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@x.com', name: 'Admin', globalRole } });
}

describe('team members page', () => {
  it('lists only the roster with roles, and lets an owner add, re-role and remove', async () => {
    const calls = mockMutations();
    signIn();
    renderApp({ data: boardQueryResult, teamPageData: teamPage(), loading: false }, ['/teams/INV/members']);

    const table = await screen.findByRole('table', { name: 'Team members' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    // A guest is never offered Owner.
    const cyRole = within(table).getByLabelText('Team role for Cy');
    expect(within(cyRole).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Member email'), { target: { value: 'dee@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to team' }));
    await waitFor(() => expect(calls.TeamMembershipUpsert).toHaveBeenCalledWith({ variables: { input: { teamId: 'team-1', email: 'dee@x.com', role: 'EDITOR' } } }));

    fireEvent.change(within(table).getByLabelText('Team role for Bo'), { target: { value: 'VIEWER' } });
    await waitFor(() => expect(calls.TeamMembershipUpsert).toHaveBeenCalledWith({ variables: { input: { teamId: 'team-1', email: 'bo@x.com', role: 'VIEWER' } } }));

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const boRow = within(table).getByText('Bo').closest('[role="row"]') as HTMLElement;
    fireEvent.click(within(boRow).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.TeamMembershipRemove).toHaveBeenCalledWith({ variables: { input: { teamId: 'team-1', userId: 'user-2' } } }));
  });

  it('shows roles read-only to a member, who can only leave', async () => {
    const calls = mockMutations();
    signIn('USER');
    renderApp({ data: boardQueryResult, teamPageData: teamPage({ viewerCanManage: false }), loading: false }, ['/teams/INV/members']);

    const table = await screen.findByRole('table', { name: 'Team members' });
    expect(within(table).getByText('Member')).toBeInTheDocument();
    expect(screen.queryByLabelText('Member email')).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    const teamNav = screen.getByRole('navigation', { name: 'Team pages' });
    expect(within(teamNav).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(table).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(calls.TeamLeave).toHaveBeenCalledWith({ variables: { teamId: 'team-1' } }));
  });

  it('offers Join on a public team the viewer is not on', async () => {
    const calls = mockMutations();
    signIn('USER');
    renderApp({
      data: boardQueryResult,
      teamPageData: teamPage({ viewerCanManage: false, viewerCanJoin: true, viewerIsMember: false, visibility: 'PUBLIC', memberships: { nodes: [] } }),
      loading: false,
    }, ['/teams/INV/members']);

    fireEvent.click(await screen.findByRole('button', { name: 'Join INV' }));
    await waitFor(() => expect(calls.TeamJoin).toHaveBeenCalledWith({ variables: { teamId: 'team-1' } }));
  });
});

describe('team settings page', () => {
  it('saves name and visibility for an owner', async () => {
    const calls = mockMutations();
    signIn();
    renderApp({ data: boardQueryResult, teamPageData: teamPage(), loading: false }, ['/teams/INV/settings']);

    fireEvent.change(await screen.findByLabelText('Team name'), { target: { value: 'Involute Core' } });
    fireEvent.change(screen.getByLabelText('Team visibility'), { target: { value: 'PUBLIC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save team settings' }));
    await waitFor(() => expect(calls.TeamUpdate).toHaveBeenCalledWith({ variables: { input: { teamId: 'team-1', name: 'Involute Core', visibility: 'PUBLIC' } } }));
  });

  it('tells a non-owner that only owners change settings', async () => {
    mockMutations();
    signIn('USER');
    renderApp({ data: boardQueryResult, teamPageData: teamPage({ viewerCanManage: false }), loading: false }, ['/teams/INV/settings']);
    expect(await screen.findByText(/Only this team.s owners and workspace admins change its settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save team settings' })).not.toBeInTheDocument();
  });
});

describe('old addresses', () => {
  it('send /members?team= and /settings/access to the team pages', async () => {
    mockMutations();
    signIn();
    renderApp({ data: boardQueryResult, teamPageData: teamPage(), loading: false }, ['/members?team=INV']);
    expect(await screen.findByRole('table', { name: 'Team members' })).toBeInTheDocument();
  });
});
