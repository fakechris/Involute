import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

// INV-1194: saved views cached in this browser belong to the account that made them.
const viewer = (id: string, name: string) => ({ id, email: `${id}@example.com`, name, globalRole: 'USER' as const });
const signIn = (id: string, name: string) => mockSessionState({ authMode: 'session', authenticated: true, googleOAuthConfigured: true, viewer: viewer(id, name) });

async function expectNoViewNamed(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  expect(screen.queryByRole('option', { name })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));
  const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  expect(within(palette).queryByRole('button', { name: new RegExp(`Load board view · ${name}`) })).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
}

describe('saved views per account (INV-1194)', () => {
  it('does not show one account\'s private views to the next account in the same browser', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('A private queue');
    signIn('user-a', 'Alice');
    renderApp({ data: boardQueryResult, loading: false }, ['/']);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(screen.getByRole('option', { name: 'A private queue' })).toBeInTheDocument();
    cleanup();

    // Bob signs in on the same browser: not before his session is known, not after.
    signIn('user-b', 'Bob');
    renderApp({ data: boardQueryResult, loading: false }, ['/']);
    expect(screen.queryByRole('option', { name: 'A private queue' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
    await expectNoViewNamed('A private queue');
    cleanup();

    renderApp({ data: boardQueryResult, loading: false }, ['/views']);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByLabelText('View A private queue')).toBeNull();
    cleanup();

    // Alice's copy is still hers.
    signIn('user-a', 'Alice');
    renderApp({ data: boardQueryResult, loading: false }, ['/views']);
    expect(await screen.findByLabelText('View A private queue')).toBeInTheDocument();
  });
});
