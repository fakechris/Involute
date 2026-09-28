import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminMembersTab, AdminSecurityTab, AdminTeamsTab } from './AdministrationTabs';

// INV-849: Settings → Administration (docs/permissions.md §7).

const mutations: Record<string, ReturnType<typeof vi.fn>> = {};
const refetch = vi.fn().mockResolvedValue(undefined);

const teamInv = { id: 'team-inv', key: 'INV', name: 'Involute' };

const queryData: Record<string, unknown> = {
  AdminMembers: {
    viewer: { id: 'u-ana' },
    teams: { nodes: [teamInv] },
    users: {
      nodes: [
        { id: 'u-ana', name: 'Ana', email: 'ana@x.com', actorKind: 'HUMAN', globalRole: 'ADMIN', accessStatus: 'ACTIVE', lastSeenAt: null, invitedAt: null, teamMemberships: [{ role: 'OWNER', team: teamInv }] },
        { id: 'u-bo', name: 'Bo', email: 'bo@x.com', actorKind: 'HUMAN', globalRole: 'USER', accessStatus: 'ACTIVE', lastSeenAt: null, invitedAt: null, teamMemberships: [] },
        { id: 'u-cy', name: 'cy', email: 'cy@partner.io', actorKind: 'HUMAN', globalRole: 'GUEST', accessStatus: 'PENDING', lastSeenAt: null, invitedAt: '2026-09-28T00:00:00.000Z', teamMemberships: [] },
        { id: 'u-bot', name: 'Bot', email: 'bot@x.com', actorKind: 'AGENT', globalRole: 'USER', accessStatus: 'ACTIVE', lastSeenAt: null, invitedAt: null, teamMemberships: [] },
      ],
    },
  },
  AdminTeams: {
    teams: {
      nodes: [
        { ...teamInv, visibility: 'PRIVATE', archivedAt: null, memberships: { nodes: [{ role: 'OWNER', user: { id: 'u-ana', name: 'Ana', email: 'ana@x.com' } }] } },
      ],
    },
  },
  WorkspaceSecurity: {
    workspaceSettings: { approvedDomains: ['x.com'], defaultTeams: [], membersCanInvite: false, membersCanCreateTeams: false },
    teams: { nodes: [teamInv] },
  },
};

const operationName = (doc: { definitions: Array<{ name?: { value: string } }> }) => doc.definitions[0]?.name?.value ?? '';

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((doc) => ({ data: queryData[operationName(doc)], loading: false, error: undefined, refetch })),
  useMutation: vi.fn((doc) => {
    const name = operationName(doc);
    mutations[name] ??= vi.fn();
    return [mutations[name], { loading: false }];
  }),
}));

afterEach(() => cleanup());
beforeEach(() => {
  for (const mock of Object.values(mutations)) mock.mockReset();
  refetch.mockClear();
});

const ok = (field: string) => ({ data: { [field]: { success: true, message: null } } });
const inRouter = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe('Administration → Members', () => {
  it('lists people (not agents) with their teams and status, and invites with a role and team', async () => {
    render(<AdminMembersTab />);
    const table = screen.getByRole('table', { name: 'People' });
    expect(within(table).queryByText('Bot')).not.toBeInTheDocument();
    expect(within(table).getByText('INV · Owner')).toBeInTheDocument();
    expect(within(table).getByText('Pending invite')).toBeInTheDocument();

    mutations.UserInvite!.mockResolvedValue(ok('userInvite'));
    fireEvent.change(screen.getByLabelText('Invite email'), { target: { value: 'dee@x.com' } });
    fireEvent.change(screen.getByLabelText('Invite role'), { target: { value: 'GUEST' } });
    fireEvent.change(screen.getByLabelText('Role in INV'), { target: { value: 'VIEWER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(mutations.UserInvite).toHaveBeenCalledWith({
      variables: { input: { email: 'dee@x.com', role: 'GUEST', teams: [{ role: 'VIEWER', teamId: 'team-inv' }] } },
    }));
    expect(await screen.findByText(/dee@x.com is invited/)).toBeInTheDocument();
  });

  it('changes a role with a reason, suspends, and revokes a pending invite; never offers to suspend yourself', async () => {
    render(<AdminMembersTab />);
    const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
    expect(within(rowOf('Ana')).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
    expect(within(rowOf('Ana')).getByLabelText('Workspace role for Ana')).toBeDisabled();

    vi.spyOn(window, 'prompt').mockReturnValue('covers on-call');
    mutations.UserSetGlobalRole!.mockResolvedValue(ok('userSetGlobalRole'));
    fireEvent.change(within(rowOf('Bo')).getByLabelText('Workspace role for Bo'), { target: { value: 'ADMIN' } });
    await waitFor(() => expect(mutations.UserSetGlobalRole).toHaveBeenCalledWith({ variables: { userId: 'u-bo', role: 'ADMIN', reason: 'covers on-call' } }));

    mutations.UserSuspend!.mockResolvedValue(ok('userSuspend'));
    fireEvent.click(within(rowOf('Bo')).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(mutations.UserSuspend).toHaveBeenCalledWith({ variables: { id: 'u-bo', reason: 'covers on-call' } }));

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mutations.UserInviteRevoke!.mockResolvedValue(ok('userInviteRevoke'));
    fireEvent.click(within(rowOf('cy')).getByRole('button', { name: 'Revoke invite' }));
    await waitFor(() => expect(mutations.UserInviteRevoke).toHaveBeenCalledWith({ variables: { id: 'u-cy' } }));
  });
});

describe('Administration → Teams', () => {
  it('creates a team and archives one', async () => {
    inRouter(<AdminTeamsTab />);
    mutations.TeamCreate!.mockResolvedValue(ok('teamCreate'));
    fireEvent.change(screen.getByLabelText('Team key'), { target: { value: 'lum' } });
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'LumenBox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(mutations.TeamCreate).toHaveBeenCalledWith({ variables: { input: { key: 'LUM', name: 'LumenBox', visibility: 'PRIVATE' } } }));

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mutations.TeamArchive!.mockResolvedValue(ok('teamArchive'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mutations.TeamArchive).toHaveBeenCalledWith({ variables: { teamId: 'team-inv' } }));
  });
});

describe('Administration → Security', () => {
  it('saves approved domains, default teams and the member toggles', async () => {
    render(<AdminSecurityTab />);
    mutations.WorkspaceSettingsUpdate!.mockResolvedValue(ok('workspaceSettingsUpdate'));
    fireEvent.change(screen.getByLabelText('Approved email domains'), { target: { value: 'x.com\nlumenopen.com' } });
    fireEvent.click(screen.getByLabelText(/INV · Involute/));
    fireEvent.click(screen.getByLabelText(/Members can invite people/));
    fireEvent.click(screen.getByRole('button', { name: 'Save security settings' }));
    await waitFor(() => expect(mutations.WorkspaceSettingsUpdate).toHaveBeenCalledWith({
      variables: { input: { approvedDomains: ['x.com', 'lumenopen.com'], defaultTeamIds: ['team-inv'], membersCanCreateTeams: false, membersCanInvite: true } },
    }));
  });
});
