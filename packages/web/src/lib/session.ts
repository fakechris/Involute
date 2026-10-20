import { getServerBaseUrl } from './apollo';

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
