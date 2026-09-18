import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, lifecycleMutationMocks, mockSessionState, renderApp } from './test/app-test-helpers';

const existingAgents = [
  { id: 'agent-iris', name: 'Iris', email: 'agent-iris@agents.involute.local', handle: 'iris', actorKind: 'AGENT', owner: { id: 'user-1', name: 'Admin', handle: null } },
];

async function openAgentsTab() {
  mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
  renderApp({ data: boardQueryResult, agentsData: { agents: existingAgents }, loading: false }, ['/settings']);
  fireEvent.click(await screen.findByRole('button', { name: 'Agents' }));
  await screen.findByRole('heading', { name: 'Issue a credential' });
}

describe('Settings → Agents issuance form (INV-606)', () => {
  it('derives the handle from the name and sends the profile fields and the answer scope', async () => {
    await openAgentsTab();

    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Codex Review' } });
    expect(screen.getByLabelText('Handle')).toHaveValue('codex-review');
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Reviews PRs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    await waitFor(() => {
      expect(lifecycleMutationMocks.agentCredentialCreate).toHaveBeenCalledWith({
        variables: {
          input: expect.objectContaining({
            team: 'INV',
            name: 'Codex Review',
            handle: 'codex-review',
            runtime: 'codex',
            description: 'Reviews PRs',
            scopes: expect.arrayContaining(['read', 'answer']),
          }),
        },
      });
    });
    expect(await screen.findByText('inv_agent_test-token')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'open its page' })).toHaveAttribute('href', '/agents/codex-review');
  });

  it('refuses a handle that another actor already owns, and a non-email email', async () => {
    await openAgentsTab();

    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Iris' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('@iris already belongs to Iris');
    expect(screen.getByRole('button', { name: 'Issue credential' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'iris-2' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'primary agent' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not an email address');
    expect(screen.getByRole('button', { name: 'Issue credential' })).toBeDisabled();
  });

  it('says when an email will add a credential to an existing actor instead of creating one', async () => {
    await openAgentsTab();

    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Iris again' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'agent-iris@agents.involute.local' } });
    expect(await screen.findByText(/adds a credential to the existing actor Iris \(@iris\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue credential' })).not.toBeDisabled();
  });
});
