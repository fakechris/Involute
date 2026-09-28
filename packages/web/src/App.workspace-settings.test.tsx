import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// INV-797: workspace settings tabs are for admins; the server refuses everyone else.
const session = (globalRole: 'ADMIN' | 'USER') =>
  mockSessionState({
    authMode: 'session',
    authenticated: true,
    googleOAuthConfigured: true,
    viewer: { email: 'someone@involute.local', globalRole, id: 'user-1', name: 'Someone' },
  });

describe('workspace settings tabs', () => {
  it('shows the Administration group to admins (INV-849)', async () => {
    session('ADMIN');
    renderApp({ data: boardQueryResult, loading: false }, ['/settings']);
    for (const name of ['Members', 'Teams', 'Security', 'Labels', 'Workflow states', 'Server features']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('does not offer them to other people', async () => {
    session('USER');
    renderApp({ data: boardQueryResult, loading: false }, ['/settings']);
    expect(await screen.findByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Workflow states' })).not.toBeInTheDocument());
  });
});
