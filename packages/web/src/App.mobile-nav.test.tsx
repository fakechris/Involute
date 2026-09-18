import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';

describe('App mobile navigation', () => {
  it('opens the sidebar as a drawer from the Menu button and closes it from the backdrop', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    const menu = await screen.findByRole('button', { name: 'Menu' });
    const sidebar = screen.getByRole('complementary', { name: 'Workspace navigation' });

    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).not.toHaveClass('app-shell__sidebar--open');

    fireEvent.click(menu);

    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar).toHaveClass('app-shell__sidebar--open');

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));

    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).not.toHaveClass('app-shell__sidebar--open');
  });

  it('shows a Sign in link in the mobile bar for signed-out visitors when Google OAuth is configured', async () => {
    mockSessionState({
      authMode: 'none',
      authenticated: false,
      googleOAuthConfigured: true,
      viewer: null,
    });

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    const links = await screen.findAllByRole('link', { name: /^Sign in/ });
    expect(links.some((link) => link.textContent === 'Sign in')).toBe(true);
  });
});
