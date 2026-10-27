import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect } from 'vitest';

import { IssueDrawerHost } from '../components/IssueDrawerHost';

function Where() {
  const location = useLocation();
  return <output data-testid="drawer-host-where">{location.pathname + location.search}</output>;
}

/** Renders a page with the shell's drawer host, as App mounts it (INV-1387). */
export function renderWithDrawerHost(page: ReactElement, url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      {page}
      <IssueDrawerHost />
      <Where />
    </MemoryRouter>,
  );
}

/** Path + search, decoded (URLSearchParams writes `/` in a value as %2F). */
export function currentUrl(): string {
  return decodeURIComponent(screen.getByTestId('drawer-host-where').textContent ?? '');
}

/**
 * Clicks a row link and checks the drawer opens for it, then Esc closes it
 * and the URL is back to `url` (filters kept). The link must keep the full
 * page as its href so modifier clicks open the page.
 */
export async function expectRowOpensDrawer(link: HTMLElement, identifier: string, url: string) {
  expect(link).toHaveAttribute('href', `/issue/${identifier}`);
  fireEvent.click(link, { metaKey: true });
  expect(currentUrl()).toBe(decodeURIComponent(url));
  fireEvent.click(link);
  expect(await screen.findByRole('dialog', { name: 'Issue detail drawer' })).toBeInTheDocument();
  expect(screen.getByTestId('drawer-issue')).toHaveTextContent(identifier);
  expect(currentUrl()).toContain(`issue=${identifier}`);
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue detail drawer' })).toBeNull());
  expect(currentUrl()).toBe(decodeURIComponent(url));
}
