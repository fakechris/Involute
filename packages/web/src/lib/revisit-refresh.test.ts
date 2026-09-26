import { describe, expect, it, vi } from 'vitest';

import { createRevisitRefresher, FOCUS_REFETCH_MIN_INTERVAL_MS } from './revisit-refresh';

describe('createRevisitRefresher (INV-738)', () => {
  it('refetches when navigating to the page already shown (g c on Candidates), not on first load or a real route change', () => {
    const refetch = vi.fn();
    const refresher = createRevisitRefresher(refetch);
    refresher.onNavigate({ key: 'a', pathname: '/candidates' });
    expect(refetch).not.toHaveBeenCalled();
    refresher.onNavigate({ key: 'a', pathname: '/candidates' }); // re-render, same entry
    expect(refetch).not.toHaveBeenCalled();
    refresher.onNavigate({ key: 'b', pathname: '/candidates' }); // navigated to the same page
    expect(refetch).toHaveBeenCalledTimes(1);
    refresher.onNavigate({ key: 'c', pathname: '/' }); // a real move: the new page fetches itself
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('refetches when the tab comes back, at most once per interval', () => {
    const refetch = vi.fn();
    let clock = 1_000_000;
    const refresher = createRevisitRefresher(refetch, () => clock);
    refresher.onReturn();
    refresher.onReturn();
    expect(refetch).toHaveBeenCalledTimes(1);
    clock += FOCUS_REFETCH_MIN_INTERVAL_MS;
    refresher.onReturn();
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
