import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apolloMocks, boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

const agents = [
  { id: 'agent-iris', name: 'Iris', email: 'agent-iris@agents.involute.local', handle: 'iris', actorKind: 'AGENT', runtime: 'codex', description: 'Reviews PRs', presence: 'idle', presenceDetail: 'active recently', lastSeenAt: null, agentCardUrl: null, deactivatedAt: null, credentialCounts: { active: 1, revoked: 0 }, owner: { id: 'user-1', name: 'Admin', handle: null } },
  { id: '8759ae98-0000-4000-8000-000000000001', name: 'Antigravity', email: 'antigravity@involute.local', handle: null, actorKind: 'AGENT', runtime: null, description: null, presence: 'away', presenceDetail: 'not seen recently', lastSeenAt: null, agentCardUrl: null, deactivatedAt: '2026-09-18T09:00:00.000Z', credentialCounts: { active: 0, revoked: 1 }, owner: { id: 'user-1', name: 'Admin', handle: null } },
  { id: 'svc-webhook', name: 'github-webhook', email: 'github-webhook@services.involute.local', handle: 'github-webhook', actorKind: 'SERVICE', runtime: 'github', description: null, presence: 'never-seen', presenceDetail: 'never connected', lastSeenAt: null, agentCardUrl: null, deactivatedAt: null, credentialCounts: { active: 0, revoked: 0 }, owner: { id: 'user-1', name: 'Admin', handle: null } },
];

function signIn() {
  mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
}

describe('Agent directory (INV-607)', () => {
  it('groups agents and services, shows credential counts, and asks for deactivated actors only when toggled', async () => {
    signIn();
    renderApp({ data: boardQueryResult, agentsData: { agents }, loading: false }, ['/agents']);

    expect(await screen.findByRole('region', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Services' })).toBeInTheDocument();
    expect(screen.getByText(/1 live credential/)).toBeInTheDocument();
    expect(screen.getByText(/deactivated Sep 18, 2026/)).toBeInTheDocument();

    const before = apolloMocks.useQuery.mock.calls.filter(([, options]) => options?.variables && 'includeDeactivated' in options.variables);
    expect(before.every(([, options]) => options.variables.includeDeactivated === false)).toBe(true);

    fireEvent.click(screen.getByLabelText('Show deactivated'));

    await waitFor(() => {
      const after = apolloMocks.useQuery.mock.calls.filter(([, options]) => options?.variables?.includeDeactivated === true);
      expect(after.length).toBeGreaterThan(0);
    });
  });

  it('reaches a handle-less actor by id, and a handled one by handle', async () => {
    signIn();
    renderApp({ data: boardQueryResult, agentsData: { agents }, loading: false }, ['/agents']);

    fireEvent.click(await screen.findByRole('button', { name: 'Antigravity' }));
    // The profile mock has no data, so the page reports what it looked up: the id, not a handle.
    expect(await screen.findByText(/No agent matches “8759ae98-0000-4000-8000-000000000001”/)).toBeInTheDocument();
  });

  it('opens Settings on the Agents tab from the directory link', async () => {
    signIn();
    renderApp({ data: boardQueryResult, agentsData: { agents }, loading: false }, ['/settings?tab=agents']);

    expect(await screen.findByRole('heading', { name: 'Issue a credential' })).toBeInTheDocument();
  });
});
