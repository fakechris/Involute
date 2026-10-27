import { useCallback, useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import { RouteIssueDrawer } from './RouteIssueDrawer';

/**
 * Routes that mount their own issue drawer (the board and backlog drive it
 * with prev/next and their loaded issues) or show the issue itself.
 */
function routeOwnsIssueView(pathname: string): boolean {
  return pathname === '/' || pathname === '/backlog' || pathname.startsWith('/issue/') || pathname.startsWith('/issues/');
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * The issue drawer for every route (INV-1387): `?issue=<id or identifier>`
 * opens it over the current page. Closing (Close, the backdrop, Esc) removes
 * only that param, so filters stay in the URL and the list keeps its scroll.
 * Mounted once in the app shell.
 */
export function IssueDrawerHost() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const issueRef = searchParams.get('issue')?.trim() || null;
  const active = Boolean(issueRef) && !routeOwnsIssueView(location.pathname);

  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('issue');
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [setSearchParams]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || isEditableTarget(event.target)) return;
      event.preventDefault();
      close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, close]);

  if (!active || !issueRef) return null;
  return <RouteIssueDrawer key={issueRef} issueRef={issueRef} onClose={close} />;
}
