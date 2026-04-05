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
  const response = await fetch(`${getServerBaseUrl()}/auth/session`, {
    credentials: 'include',
  });

  const payload = (await response.json()) as SessionState;
  return payload;
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
