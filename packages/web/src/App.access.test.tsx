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
    expect(screen.getByText('EDITOR · USER')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);

    await waitFor(() => {
      expect(teamMembershipRemove).toHaveBeenCalled();
    });
  });
});
