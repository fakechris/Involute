import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, lifecycleMutationMocks, mockSessionState, renderApp } from './test/app-test-helpers';

function profile(overrides: { viewerCanManage?: boolean; deactivatedAt?: string | null } = {}) {
  return {
    agentProfile: {
      actor: {
        id: 'agent-mia',
        name: 'Mia',
        email: 'mia@agents.involute.local',
        handle: 'mia',
        actorKind: 'AGENT',
        runtime: 'codex',
        description: 'Review bot',
        agentCardUrl: null,
        presence: 'idle',
        presenceDetail: 'idle',
        lastSeenAt: null,
        deactivatedAt: overrides.deactivatedAt ?? null,
        owner: { id: 'user-1', name: 'Admin', handle: null },
      },
      viewerCanManage: overrides.viewerCanManage ?? true,
      counts: { proposedWork: 1, openRequests: 0, answeredRequests: 0, runs: 0, evidence: 0 },
      credentials: [
        { id: 'cred-1', name: 'Mia', scopes: ['read', 'propose'], teamKey: 'INV', createdAt: '2026-09-15T00:00:00.000Z', expiresAt: null, revokedAt: null },
      ],
      receipts: [],
      timeline: [
        { at: '2026-09-17T07:00:00.000Z', kind: 'owner-transferred', detail: 'by @admin — INV-593: legacy actor had no owner', workIdentifier: null },
      ],
    },
  };
}

describe('Agent lifecycle controls (INV-605)', () => {
  it('lets a manager deactivate the actor with a reason', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
    renderApp({ data: boardQueryResult, agentProfileData: profile(), loading: false }, ['/agents/mia']);

    const manage = await screen.findByRole('region', { name: 'Lifecycle' });
    fireEvent.click(within(manage).getByRole('button', { name: 'Deactivate' }));
    fireEvent.change(within(manage).getByLabelText('Reason for deactivating'), { target: { value: 'Duplicate actor' } });
    fireEvent.click(within(manage).getByRole('button', { name: 'Confirm deactivate' }));

    await waitFor(() => {
      expect(lifecycleMutationMocks.actorDeactivate).toHaveBeenCalledWith({ variables: { id: 'agent-mia', reason: 'Duplicate actor' } });
    });
  });

  it('offers Reactivate instead when the actor is already deactivated', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
    renderApp({ data: boardQueryResult, agentProfileData: profile({ deactivatedAt: '2026-09-18T09:00:00.000Z' }), loading: false }, ['/agents/mia']);

    const manage = await screen.findByRole('region', { name: 'Lifecycle' });
    expect(within(manage).queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    fireEvent.click(within(manage).getByRole('button', { name: 'Reactivate' }));
    fireEvent.click(within(manage).getByRole('button', { name: 'Confirm reactivate' }));

    await waitFor(() => {
      expect(lifecycleMutationMocks.actorReactivate).toHaveBeenCalledWith({ variables: { id: 'agent-mia' } });
    });
  });

  it('hides the controls and the per-credential Revoke from viewers who may not manage the actor', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-9', email: 'sam@example.com', name: 'Sam', globalRole: 'USER' } });
    renderApp({ data: boardQueryResult, agentProfileData: profile({ viewerCanManage: false }), loading: false }, ['/agents/mia']);

    expect(await screen.findByText('Accountable owner: Admin')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lifecycle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('shows lifecycle audit rows on the timeline', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
    renderApp({ data: boardQueryResult, agentProfileData: profile(), loading: false }, ['/agents/mia']);

    expect(await screen.findByText('owner-transferred')).toBeInTheDocument();
    expect(screen.getByText(/by @admin — INV-593/)).toBeInTheDocument();
  });
});
