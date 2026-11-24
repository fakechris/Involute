import { getServerBaseUrl } from './apollo';

const SIGN_IN_RETURN_KEY = 'involute.signInReturn';
/** A sign-in takes minutes; an older saved page is from an abandoned one (INV-2147). */
const SIGN_IN_RETURN_MAX_AGE_MS = 15 * 60_000;

export interface SessionViewer {
  email: string;
  globalRole: 'ADMIN' | 'USER';
  id: string;
  name: string;
}

/** A sign-in line this server offers (INV-1288). */
export interface AuthProviderDescriptor {
  id: string;
  label: string;
  startUrl: string;
}

export interface SessionState {
  authMode: 'none' | 'session' | 'token';
  authenticated: boolean;
  /** The sign-in buttons to show, in order. Empty on a server that offers none. */
  authProviders: AuthProviderDescriptor[];
  googleOAuthConfigured: boolean;
  viewer: SessionViewer | null;
}

export async function fetchSessionState(): Promise<SessionState> {
  try {
    const response = await fetch(`${getServerBaseUrl()}/auth/session`, {
      credentials: 'include',
    });

    if (!response.ok && response.status !== 401) {
      throw new Error(`Session request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as SessionState;
    return {
      ...payload,
      authProviders: payload.authProviders ?? [],
    };
  } catch (error) {
    console.error('Failed to fetch session state.', error);
    return {
      authMode: 'none',
      authenticated: false,
      authProviders: [],
      googleOAuthConfigured: false,
      viewer: null,
    };
  }
}

export function getProviderLoginUrl(startUrl: string): string {
  return `${getServerBaseUrl()}${startUrl}`;
}

export function getGoogleLoginUrl(): string {
  return getProviderLoginUrl('/auth/google/start');
}

// The OAuth callback returns to the app root. Keep the destination in this
// tab rather than sending private routes or filter terms to the provider.
export function rememberSignInReturn(): void {
  try {
    const url = new URL(window.location.href);
    const fromCallback = url.searchParams.has('authError');
    if (fromCallback && window.sessionStorage.getItem(SIGN_IN_RETURN_KEY)) return;
    if (fromCallback) url.searchParams.delete('authError');
    const path = url.pathname + url.search + url.hash;
    if (path === '/') window.sessionStorage.removeItem(SIGN_IN_RETURN_KEY);
    else window.sessionStorage.setItem(SIGN_IN_RETURN_KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Sign-in still works if the browser blocks storage.
  }
}

export function readSignInReturn(): string | null {
  try {
    const saved = window.sessionStorage.getItem(SIGN_IN_RETURN_KEY);
    if (!saved) return null;
    let path: string | null = null;
    try {
      const entry = JSON.parse(saved) as { path?: unknown; at?: unknown };
      // Only a recent sign-in returns here (INV-2147): an abandoned one would
      // otherwise send a later, ordinary visit to the old page.
      if (typeof entry.path === 'string' && typeof entry.at === 'number' && Date.now() - entry.at <= SIGN_IN_RETURN_MAX_AGE_MS) path = entry.path;
    } catch {
      // An unreadable or old-format entry is treated as stale.
    }
    if (!path) {
      window.sessionStorage.removeItem(SIGN_IN_RETURN_KEY);
      return null;
    }
    // Only return to an app route, not a different origin.
    if (!path?.startsWith('/') || path === '/' || path.startsWith('//') || new URL(path, window.location.origin).origin !== window.location.origin) return null;
    return path;
  } catch {
    return null;
  }
}

export function clearSignInReturn(): void {
  try {
    window.sessionStorage.removeItem(SIGN_IN_RETURN_KEY);
  } catch {
    // The saved destination is optional.
  }
}

export async function logoutSession(): Promise<boolean> {
  const response = await fetch(`${getServerBaseUrl()}/auth/logout`, {
    credentials: 'include',
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Logout failed with status ${response.status}.`);
  }

  return true;
}
