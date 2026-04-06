import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { accessQueryResult, apolloMocks, boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

describe('App access management', () => {
  it('shows the Access nav item for authenticated users and renders the team access page', async () => {
    mockSessionState({
      authMode: 'session',
      authenticated: true,
      googleOAuthConfigured: true,
      viewer: {
        email: 'admin@involute.local',
        globalRole: 'ADMIN',
        id: 'user-1',
        name: 'Admin',
      },
    });

    renderApp({ accessData: accessQueryResult, data: boardQueryResult, loading: false }, ['/settings/access']);

    expect(await screen.findByRole('heading', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Current viewer' })).toBeInTheDocument();
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.getByLabelText('Team visibility')).toHaveValue('PRIVATE');
    expect(screen.getByText('OWNER · ADMIN')).toBeInTheDocument();
  });

  it('updates visibility and membership entries from the minimal access UI', async () => {
    mockSessionState({
      authMode: 'session',
      authenticated: true,
      googleOAuthConfigured: true,
      viewer: {
        email: 'admin@involute.local',
        globalRole: 'ADMIN',
        id: 'user-1',
        name: 'Admin',
      },
    });

    const teamUpdateAccess = vi.fn().mockResolvedValue({
      data: {
        teamUpdateAccess: {
          success: true,
          team: {
            ...accessQueryResult.teams.nodes[0],
            visibility: 'PUBLIC',
          },
        },
      },
    });
    const teamMembershipUpsert = vi.fn().mockResolvedValue({
      data: {
        teamMembershipUpsert: {
          success: true,
          membership: {
            id: 'membership-2',
            role: 'EDITOR',
            user: {
              email: 'editor@example.com',
              globalRole: 'USER',
              id: 'user-2',
              name: 'Editor User',
            },
          },
        },
      },
    });
    const teamMembershipRemove = vi.fn().mockResolvedValue({
      data: {
        teamMembershipRemove: {
          success: true,
          membershipId: 'membership-2',
        },
      },
    });

    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : (document as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? String(document);

      if (source.includes('mutation TeamUpdateAccess')) {
        return [teamUpdateAccess];
      }

      if (source.includes('mutation TeamMembershipUpsert')) {
        return [teamMembershipUpsert];
      }

      if (source.includes('mutation TeamMembershipRemove')) {
        return [teamMembershipRemove];
      }

      return [vi.fn()];
    });

    renderApp({ accessData: accessQueryResult, data: boardQueryResult, loading: false }, ['/settings/access']);

    fireEvent.change(await screen.findByLabelText('Team visibility'), {
      target: { value: 'PUBLIC' },
    });

    await waitFor(() => {
      expect(teamUpdateAccess).toHaveBeenCalled();
    });
    expect(teamUpdateAccess).toHaveBeenCalledWith({
      variables: {
        input: {
          teamId: 'team-1',
          visibility: 'PUBLIC',
        },
      },
    });
    expect(await screen.findByText('Involute is now PUBLIC.')).toBeInTheDocument();
    expect(screen.getByLabelText('Team visibility')).toHaveValue('PUBLIC');

    fireEvent.change(screen.getByLabelText('Member email'), {
      target: { value: 'editor@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Member name'), {
      target: { value: 'Editor User' },
    });
    fireEvent.change(screen.getByLabelText('Member role'), {
      target: { value: 'EDITOR' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save member' }));

    await waitFor(() => {
      expect(teamMembershipUpsert).toHaveBeenCalled();
    });
    expect(teamMembershipUpsert).toHaveBeenCalledWith({
      variables: {
        input: {
          email: 'editor@example.com',
          name: 'Editor User',
          role: 'EDITOR',
          teamId: 'team-1',
        },
      },
    });
    expect(await screen.findByText('Saved editor@example.com as EDITOR.')).toBeInTheDocument();
    expect(screen.getByText('EDITOR · USER')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove editor@example.com from Involute' }));

    await waitFor(() => {
      expect(teamMembershipRemove).toHaveBeenCalled();
    });
    expect(teamMembershipRemove).toHaveBeenCalledWith({
      variables: {
        input: {
          teamId: 'team-1',
          userId: 'user-2',
        },
      },
    });
    expect(await screen.findByText('Removed editor@example.com from Involute.')).toBeInTheDocument();
  });

  it('shows a read-only access state for viewers who cannot manage the selected team', async () => {
    mockSessionState({
      authMode: 'session',
      authenticated: true,
      googleOAuthConfigured: true,
      viewer: {
        email: 'viewer@involute.local',
        globalRole: 'USER',
        id: 'user-9',
        name: 'Viewer',
      },
    });

    renderApp(
      {
        accessData: {
          viewer: {
            email: 'viewer@involute.local',
            globalRole: 'USER',
            id: 'user-9',
            name: 'Viewer',
          },
          teams: {
            nodes: [
              {
                ...accessQueryResult.teams.nodes[0]!,
                memberships: {
                  nodes: [],
                },
                visibility: 'PUBLIC',
              },
            ],
          },
        },
        data: boardQueryResult,
        loading: false,
      },
      ['/settings/access'],
    );

    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.getByLabelText('Team visibility')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save member' })).toBeDisabled();
    expect(
      screen.getByText(
        'Membership details are only shown to owners and admins for this team.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        'Access changes are disabled for you on this team. Only a team `OWNER` or global `ADMIN` can manage visibility and memberships.',
      ),
    ).toHaveLength(2);
  });
});
