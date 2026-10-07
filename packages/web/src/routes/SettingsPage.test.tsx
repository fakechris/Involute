import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, mockSessionState, renderApp } from '../test/app-test-helpers';
import { App } from '../App';
import { USER_UPDATE_MUTATION } from '../board/queries';

// INV-1015: the personal settings entry point (userUpdate) has a click test.
describe('Settings → Profile', () => {
  it('saves a changed name through userUpdate when the field loses focus', async () => {
    const runUserUpdate = vi.fn().mockResolvedValue({ data: { userUpdate: { success: true, user: { id: 'user-1', name: 'Chris', email: 'admin@example.com' } } } });
    const original = apolloMocks.useMutation.getMockImplementation() as (document: unknown, options?: unknown) => unknown;
    apolloMocks.useMutation.mockImplementation((document: unknown, options?: unknown) =>
      document === USER_UPDATE_MUTATION ? [runUserUpdate] : original(document, options));
    mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: { id: 'user-1', email: 'admin@example.com', name: 'Admin', globalRole: 'ADMIN' } });
    renderApp(App, { data: boardQueryResult, loading: false }, ['/settings']);

    const name = await screen.findByDisplayValue('Admin');
    fireEvent.change(name, { target: { value: 'Chris' } });
    fireEvent.blur(name);

    await waitFor(() => {
      expect(runUserUpdate).toHaveBeenCalledWith({ variables: { input: { name: 'Chris' } } });
    });
    apolloMocks.useMutation.mockImplementation(original);
  });
});
