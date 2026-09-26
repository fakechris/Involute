import { useApolloClient } from '@apollo/client/react';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/** Returning to a visible tab refetches at most this often. */
export const FOCUS_REFETCH_MIN_INTERVAL_MS = 10_000;

export interface RevisitRefresher {
  /** A navigation happened; refresh when it lands on the page already shown. */
  onNavigate(location: { key: string; pathname: string }): void;
  /** The tab became visible or the window regained focus. */
  onReturn(): void;
}

/**
 * When to refetch the page's live queries without a reload (INV-738). Work
 * changes behind the reader's back — agents propose, claim and report — and
 * a page that is already mounted never asks again on its own:
 * - navigating to the page already shown (g c on Candidates, clicking its
 *   sidebar link) means "show me the current state";
 * - coming back to the tab after looking elsewhere means the same, throttled
 *   so focus flicker does not hammer the API.
 */
export function createRevisitRefresher(refetch: () => void, now: () => number = Date.now): RevisitRefresher {
  let previous: { key: string; pathname: string } | null = null;
  let lastReturnRefetch = Number.NEGATIVE_INFINITY;
  return {
    onNavigate(location) {
      if (previous && previous.key !== location.key && previous.pathname === location.pathname) {
        refetch();
      }
      previous = { key: location.key, pathname: location.pathname };
    },
    onReturn() {
      const at = now();
      // A clock set backwards must not suppress refreshes until it catches up.
      if (at >= lastReturnRefetch && at - lastReturnRefetch < FOCUS_REFETCH_MIN_INTERVAL_MS) return;
      lastReturnRefetch = at;
      refetch();
    },
  };
}

/** Mount once inside the Apollo provider and the router. Renders nothing. */
export function RevisitRefresh() {
  const client = useApolloClient();
  const location = useLocation();
  const refresher = useRef<RevisitRefresher | null>(null);
  refresher.current ??= createRevisitRefresher(() => {
    void client.refetchQueries({ include: 'active' }).catch(() => undefined);
  });

  useEffect(() => {
    refresher.current?.onNavigate({ key: location.key, pathname: location.pathname });
  }, [location.key, location.pathname]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresher.current?.onReturn();
    };
    const onFocus = () => refresher.current?.onReturn();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return null;
}
