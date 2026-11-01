import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// INV-1490: an agent's trust level is set by a person with a reason, next to the numbers.

function profile(trust: Record<string, unknown>, viewerCanManage = true) {
  return {
    agentProfile: {
      actor: { id: 'agent-mia', name: 'Mia', email: 'mia@agents.involute.local', handle: 'mia', actorKind: 'AGENT', runtime: 'codex', description: 'Review bot', agentCardUrl: null, presence: 'idle', presenceDetail: 'idle', lastSeenAt: null, deactivatedAt: null, owner: { id: 'user-1', name: 'Admin', handle: null } },
      viewerCanManage,
      counts: { proposedWork: 1, openRequests: 0, answeredRequests: 0, runs: 0, evidence: 0 },
      trust: {
        level: 'OBSERVE',
        descriptionEn: 'Claims and runs work; no gate opens for its proposals or deliveries whatever the project allows.',
        descriptionZh: '可以认领和执行，但不论项目多开放，它的提案和交付都不会自动通过任何门。',
        reason: null,
        updatedAt: null,
        setBy: null,
        allowed: { claimWork: true, fileBugs: true, autoCommit: false, autoAccept: false, delegate: false },
        metrics: { windowDays: 30, deliveries: 42, bugsFiled: 4, falseReports: 0, falseReportRate: 0, reopens: 1, overrides: 0, overridesLastWeek: 0 },
        suggestedLevel: 'L1',
        warning: null,
        ...trust,
      },
      credentials: [],
      receipts: [],
      timeline: [],
    },
  };
}

function mockTrustSet(result: { success: boolean; message?: string | null }) {
  const agentTrustSet = vi.fn().mockResolvedValue({ data: { agentTrustSet: result } });
  apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) => {
    const body = document?.loc?.source.body ?? '';
    return [body.includes('agentTrustSet(') ? agentTrustSet : vi.fn(), { loading: false }];
  });
  return agentTrustSet;
}

describe('Agent trust level (INV-1490)', () => {
  it('shows the level in both languages, what it allows, the 30-day numbers and the suggestion; promotes with a reason', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
    const agentTrustSet = mockTrustSet({ success: true, message: null });
    renderApp({ data: boardQueryResult, agentProfileData: profile({}), loading: false }, ['/agents/mia']);
    const panel = await screen.findByRole('region', { name: 'Trust level' });
    expect(within(panel).getByText(/不论项目多开放/)).toBeInTheDocument();
    expect(within(panel).getByText('— delegate to other agents')).toBeInTheDocument();
    expect(within(panel).getByText('deliveries 42')).toBeInTheDocument();
    expect(within(panel).getByRole('status')).toHaveTextContent('Suggested: L1');
    expect(within(panel).queryByRole('button', { name: /Promote/ })).not.toBeInTheDocument();
    // The control a manager uses (human-surface: agentTrustSet → AgentTrustPanel, label 'Set trust level').
    expect(within(panel).getByText('Set trust level')).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('Trust level'), { target: { value: 'L1' } });
    const promote = within(panel).getByRole('button', { name: 'Promote to L1' });
    expect(promote).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText('Reason for the trust change'), { target: { value: '42 clean deliveries' } });
    fireEvent.click(promote);
    await waitFor(() => expect(agentTrustSet).toHaveBeenCalledWith({ variables: { input: { actorId: 'agent-mia', level: 'L1', reason: '42 clean deliveries' } } }));
    expect(await within(panel).findByText('Trust level set to L1.')).toBeInTheDocument();
  });

  it('warns on overrides, offers a demotion, and shows the server reason when refused; a non-manager only reads', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
    mockTrustSet({ success: false, message: 'An agent cannot change a trust level, its own or another’s (INV-1490).' });
    renderApp({ data: boardQueryResult, agentProfileData: profile({ level: 'L2', suggestedLevel: null, warning: '3 automatic decisions on this agent’s work were undone this week; consider a lower level.', metrics: { windowDays: 30, deliveries: 9, bugsFiled: 0, falseReports: 0, falseReportRate: null, reopens: 2, overrides: 3, overridesLastWeek: 3 } }), loading: false }, ['/agents/mia']);
    const panel = await screen.findByRole('region', { name: 'Trust level' });
    expect(within(panel).getByRole('alert')).toHaveTextContent('3 automatic decisions');
    fireEvent.change(within(panel).getByLabelText('Trust level'), { target: { value: 'OBSERVE' } });
    fireEvent.change(within(panel).getByLabelText('Reason for the trust change'), { target: { value: 'too many overrides' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Demote to Observe' }));
    expect(await within(panel).findByText(/cannot change a trust level/)).toBeInTheDocument();
  });

  it('a reader without manage rights sees the level and numbers but no control', async () => {
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-2', email: 'member@example.com', name: 'Member', globalRole: 'USER' } });
    renderApp({ data: boardQueryResult, agentProfileData: profile({}, false), loading: false }, ['/agents/mia']);
    const panel = await screen.findByRole('region', { name: 'Trust level' });
    expect(within(panel).getByText('deliveries 42')).toBeInTheDocument();
    expect(within(panel).queryByLabelText('Trust level')).not.toBeInTheDocument();
  });
});
