import { getServerBaseUrl } from './apollo';

export interface SessionViewer {
  email: string;
  globalRole: 'ADMIN' | 'USER';
  id: string;
  name: string;
}

export interface SessionState {
  authMode: 'none' | 'session' | 'token';
  authenticated: boolean;
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
    return payload;
  } catch (error) {
    console.error('Failed to fetch session state.', error);
    return {
      authMode: 'none',
      authenticated: false,
      googleOAuthConfigured: false,
      viewer: null,
    };
  }
}

export function getGoogleLoginUrl(): string {
  return `${getServerBaseUrl()}/auth/google/start`;
}

export async function logoutSession(): Promise<void> {
  await fetch(`${getServerBaseUrl()}/auth/logout`, {
    credentials: 'include',
    method: 'POST',
  });
}
