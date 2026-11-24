import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSignInReturn, readSignInReturn, rememberSignInReturn } from './session';

// INV-2147: the page to return to after sign-in is used only for a recent sign-in.
describe('sign-in return page', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearSignInReturn();
    window.history.replaceState(null, '', '/');
  });

  it('returns to the saved page shortly after sign-in', () => {
    window.history.replaceState(null, '', '/issue/INV-5?tab=runs');
    rememberSignInReturn();
    expect(readSignInReturn()).toBe('/issue/INV-5?tab=runs');
  });

  it('ignores and forgets a page saved by a sign-in abandoned long ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T08:00:00Z'));
    window.history.replaceState(null, '', '/issue/INV-5');
    rememberSignInReturn();
    vi.setSystemTime(new Date('2026-11-24T08:16:00Z'));
    expect(readSignInReturn()).toBeNull();
    expect(window.sessionStorage.getItem('involute.signInReturn')).toBeNull();
  });

  it('treats an entry from the old format as stale, and still refuses other origins', () => {
    window.sessionStorage.setItem('involute.signInReturn', '/issue/INV-5');
    expect(readSignInReturn()).toBeNull();
    window.sessionStorage.setItem('involute.signInReturn', JSON.stringify({ path: '//evil.example/x', at: Date.now() }));
    expect(readSignInReturn()).toBeNull();
  });
});
