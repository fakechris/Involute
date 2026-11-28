import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
} from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { CombinedGraphQLErrors, ServerError, ServerParseError } from '@apollo/client/errors';
import { setContext } from '@apollo/client/link/context';
import { ErrorLink } from '@apollo/client/link/error';
import { RetryLink } from '@apollo/client/link/retry';
import type { PropsWithChildren } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { VIEWER_ASSERTION_HEADER } from '@turnkeyai/involute-shared';
import { readLocalStorageValue } from './storage';

const DEFAULT_GRAPHQL_URL = import.meta.env.DEV
  ? 'http://localhost:4200/graphql'
  : '/graphql';
const LOCAL_STORAGE_AUTH_KEYS = ['involute.authToken', 'involuteAuthToken'] as const;
const LOCAL_STORAGE_GRAPHQL_URL_KEYS = ['involute.graphqlUrl', 'involuteGraphqlUrl'] as const;
const LOCAL_STORAGE_VIEWER_ASSERTION_KEYS = [
  'involute.viewerAssertion',
  'involuteViewerAssertion',
] as const;
const DEFAULT_AUTH_TOKEN = 'changeme-set-your-token';
const GRAPHQL_URL_OVERRIDE_QUERY_PARAM = 'involuteApiUrl';
const ALLOWED_RUNTIME_GRAPHQL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export type AuthTokenSource = 'env' | 'localStorage' | 'dev-default' | 'missing';
export type GraphqlUrlSource = 'query-param' | 'localStorage' | 'env' | 'default';

export function getAuthTokenDetails(): {
  token: string | null;
  source: AuthTokenSource;
} {
  const envToken = import.meta.env.VITE_INVOLUTE_AUTH_TOKEN;

  if (typeof envToken === 'string' && envToken.length > 0) {
    return {
      token: envToken,
      source: 'env',
    };
  }

  if (typeof window !== 'undefined') {
    for (const storageKey of LOCAL_STORAGE_AUTH_KEYS) {
      const configuredToken = readLocalStorageValue(storageKey);

      if (configuredToken) {
        return {
          token: configuredToken,
          source: 'localStorage',
        };
      }
    }
  }

  const isDev = Boolean(import.meta.env.DEV);

  if (isDev) {
    return {
      token: DEFAULT_AUTH_TOKEN,
      source: 'dev-default',
    };
  }

  return {
    token: null,
    source: 'missing',
  };
}

export function getAuthToken(): string | null {
  return getAuthTokenDetails().token;
}

export function getGraphqlUrl(): string {
  if (typeof window !== 'undefined') {
    const runtimeUrl = resolveRuntimeGraphqlUrlOverride();

    if (runtimeUrl) {
      return runtimeUrl.url;
    }
  }

  const envUrl = import.meta.env.VITE_INVOLUTE_GRAPHQL_URL;

  if (typeof envUrl === 'string' && envUrl.length > 0) {
    return envUrl;
  }

  return DEFAULT_GRAPHQL_URL;
}

export function getGraphqlUrlDetails(): {
  url: string;
  source: GraphqlUrlSource;
} {
  if (typeof window !== 'undefined') {
    const runtimeUrl = resolveRuntimeGraphqlUrlOverride();

    if (runtimeUrl) {
      return runtimeUrl;
    }
  }

  const envUrl = import.meta.env.VITE_INVOLUTE_GRAPHQL_URL;

  if (typeof envUrl === 'string' && envUrl.length > 0) {
    return {
      url: envUrl,
      source: 'env',
    };
  }

  return {
    url: DEFAULT_GRAPHQL_URL,
    source: 'default',
  };
}

export function isAuthenticationError(error: unknown): boolean {
  if (ServerError.is(error)) return error.statusCode === 401;
  const missingSession = (message: string) => /^(not authenticated\.?|unauthenticated)$/i.test(message.trim());
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.some(({ extensions, message }) =>
      extensions?.code === 'UNAUTHENTICATED' || (!extensions?.code && missingSession(message)),
    );
  }
  return error instanceof Error && missingSession(error.message);
}

/**
 * `section` names the part of a page that failed, so several failed parts of one
 * drawer are told apart and the session notice above them is not repeated (INV-2141).
 */
export function loadErrorMessage(error: unknown, fallback?: string, section?: string): string | undefined {
  if (isAuthenticationError(error)) return section ? `${section} did not load. Sign in again to see it.` : 'Your session ended.';
  return fallback ?? (error instanceof Error ? error.message : undefined);
}

/** The server refused a change because the viewer may only read this work (docs/permissions.md). */
export function isForbiddenError(error: unknown): boolean {
  return CombinedGraphQLErrors.is(error) && error.errors.some(({ extensions }) => extensions?.code === 'FORBIDDEN');
}

/** What a person without edit access reads instead of "refresh and try again" (INV-2158..2161). */
export const READ_ONLY_TEAM_MESSAGE = 'You can view this work but not change it. Ask a team owner for edit access.';

/** The message for a failed change: no edit access, or the page's own fallback. */
export function changeErrorMessage(error: unknown, fallback: string): string {
  return isForbiddenError(error) ? READ_ONLY_TEAM_MESSAGE : fallback;
}

/**
 * Answers that mean "try again": the proxy or the connection failed, not the
 * request, or this session sent too much at once (429, INV-2312).
 */
const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

/** Longest wait before resending a read; a longer Retry-After shows the error instead of a frozen page. */
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * How long to wait before resending a read: what a 429 asks for (Retry-After,
 * capped), otherwise a short randomised backoff.
 */
export function retryDelayMs(attempt: number, error: unknown): number {
  if (ServerError.is(error) && error.statusCode === 429) {
    const seconds = Number(error.response.headers.get('retry-after'));
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000) : 1_000;
  }
  return Math.random() * Math.min(2_000, 300 * 2 ** attempt);
}

/**
 * Whether a failed request is worth sending again (INV-2210): a read that hit a
 * dropped connection or a gateway error. Writes are never resent (they may have
 * been applied), and neither are answers the server gave on purpose — GraphQL
 * errors, sign-in or permission refusals, other HTTP statuses — or a request the
 * page cancelled.
 */
export function isRetryableReadFailure(error: unknown, operationType: string | undefined): boolean {
  if (operationType !== 'query') return false;
  if (CombinedGraphQLErrors.is(error)) return false;
  if (ServerError.is(error) || ServerParseError.is(error)) return TRANSIENT_STATUS_CODES.has(error.statusCode);
  if (error instanceof Error && error.name === 'AbortError') return false;
  return error instanceof Error;
}

export function createApolloClient(onAuthenticationError?: () => void) {
  const httpLink = new HttpLink({
    credentials: 'include',
    uri: getGraphqlUrl(),
  });

  const authLink = setContext((_, { headers }) => {
    const token = getAuthToken();
    const viewerHeaders = getViewerHeaders();

    return {
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...viewerHeaders,
      },
    };
  });

  const errorLink = new ErrorLink(({ error, operation }) => {
    // A write may have an unsaved draft. Escalate failed reads, not writes.
    if (operation.operationType === 'query' && isAuthenticationError(error)) onAuthenticationError?.();
  });

  const retryLink = new RetryLink({
    delay: (attempt, _operation, error) => retryDelayMs(attempt, error),
    attempts: { max: 3, retryIf: (error, operation) => isRetryableReadFailure(error, operation.operationType) },
  });

  return new ApolloClient({
    cache: new InMemoryCache({
      typePolicies: {
        Query: {
          fields: {
            // The board reads noRepositoryCount; the drawer's project picker
            // does not. Preserve that field when the picker refreshes the same
            // summary, or Apollo refetches and replaces the accumulated pages.
            projectSummary: { merge: true },
          },
        },
      },
    }),
    // A refresh right after the proxy dropped an idle connection, or a blip
    // between the browser and the edge, must not turn the page into an error:
    // reads are tried up to three times before the error is shown.
    link: errorLink.concat(retryLink).concat(authLink).concat(httpLink),
    defaultOptions: {
      // Work changes behind the reader's back (agents propose, claim and
      // report), so opening a page must not show only what was cached on the
      // last visit: show the cache at once and fetch the current state. While
      // the page stays open, cache updates do not trigger further requests.
      watchQuery: { fetchPolicy: 'cache-and-network', nextFetchPolicy: 'cache-first' },
    },
  });
}

export interface BoardBootstrapErrorState {
  title: string;
  description: string;
  /** A way forward the visitor can click, when one exists (today: sign in). */
  action?: { label: string; href: string };
}

export function getBoardBootstrapErrorMessage(error: Error): BoardBootstrapErrorState {
  const message = error.message.toLowerCase();
  const { source } = getAuthTokenDetails();

  if (message.includes('not authenticated') || message.includes('unauthenticated')) {
    if (source === 'missing') {
      // Production visitors never set tokens by hand; the only thing they
      // can do is sign in, so say that and hand them the link. The token
      // hints stay for local development, where they are the real fix.
      // The sign-in callback says why it refused (docs/permissions.md §1).
      const refusal = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('authError');
      if (refusal === 'not_invited') {
        return {
          title: 'This workspace is invite-only',
          description: 'The Google account you used has not been invited. Ask an admin to invite it, or sign in with the account you were invited with.',
          action: { label: 'Sign in with another account', href: `${getServerBaseUrl()}/auth/google/start` },
        };
      }
      if (refusal === 'suspended') {
        return {
          title: 'This account is suspended',
          description: 'An admin has suspended this account. Ask them to reactivate it.',
        };
      }
      if (!import.meta.env.DEV) {
        return {
          title: 'Sign in to continue',
          description: 'This workspace is private. Sign in with your Google account to see the board.',
          action: { label: 'Sign in with Google', href: `${getServerBaseUrl()}/auth/google/start` },
        };
      }

      return {
        title: 'Authentication required',
        description:
          'Sign in with Google to use the board, or set `VITE_INVOLUTE_AUTH_TOKEN` / localStorage `involute.authToken` for trusted local development.',
        action: { label: 'Sign in with Google', href: `${getServerBaseUrl()}/auth/google/start` },
      };
    }

    return {
      title: 'Authentication failed',
      description:
        source === 'dev-default'
          ? 'The board used the default development token, but the API rejected it. Set `VITE_INVOLUTE_AUTH_TOKEN` or store a valid token in localStorage under `involute.authToken`, then reload.'
          : 'The board sent a runtime auth token, but the API rejected it. Confirm the configured token matches the server and reload.',
    };
  }

  return {
    title: 'Board unavailable',
    description:
      'We could not load the board right now. Please confirm the API server is running and try again.',
  };
}

export function getServerBaseUrl(): string {
  const graphqlUrl = toAbsoluteUrl(getGraphqlUrl());

  return graphqlUrl.origin;
}

const AuthenticationFailureContext = createContext(false);

export function useAuthenticationFailure(): boolean {
  return useContext(AuthenticationFailureContext);
}

export function AppApolloProvider({ children }: PropsWithChildren) {
  const [authenticationFailed, setAuthenticationFailed] = useState(false);
  const client = useMemo(() => createApolloClient(() => setAuthenticationFailed(true)), []);
  // After a sign-in (in this tab or another), coming back to this tab clears the
  // session-ended state and reloads what is on screen, without a page reload (INV-2146).
  useEffect(() => {
    if (!authenticationFailed) return;
    let checking = false;
    async function checkSession() {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const response = await fetch(`${getServerBaseUrl()}/auth/session`, { credentials: 'include' });
        const session = response.ok ? ((await response.json()) as { authenticated?: boolean }) : null;
        if (session?.authenticated) {
          setAuthenticationFailed(false);
          void client.refetchQueries({ include: 'active' }).catch(() => undefined);
        }
      } catch {
        // Still signed out, or offline: try again on the next return to the tab.
      } finally {
        checking = false;
      }
    }
    window.addEventListener('focus', checkSession);
    document.addEventListener('visibilitychange', checkSession);
    return () => {
      window.removeEventListener('focus', checkSession);
      document.removeEventListener('visibilitychange', checkSession);
    };
  }, [authenticationFailed, client]);

  return (
    <ApolloProvider client={client}>
      <AuthenticationFailureContext.Provider value={authenticationFailed}>
        {children}
      </AuthenticationFailureContext.Provider>
    </ApolloProvider>
  );
}

function resolveRuntimeGraphqlUrlOverride(): {
  url: string;
  source: Extract<GraphqlUrlSource, 'query-param' | 'localStorage'>;
} | null {
  if (!import.meta.env.DEV) {
    return null;
  }

  const queryParamValue = readRuntimeGraphqlUrlQueryParam();

  if (queryParamValue && isAllowedRuntimeGraphqlUrl(queryParamValue)) {

    return {
      url: queryParamValue,
      source: 'query-param',
    };
  }

  for (const storageKey of LOCAL_STORAGE_GRAPHQL_URL_KEYS) {
    const configuredUrl = readLocalStorageValue(storageKey)?.trim();

    if (configuredUrl && isAllowedRuntimeGraphqlUrl(configuredUrl)) {
      return {
        url: configuredUrl,
        source: 'localStorage',
      };
    }
  }

  return null;
}

function readRuntimeGraphqlUrlQueryParam(): string | null {
  const search = window.location.search;

  if (!search) {
    return null;
  }

  const params = new URLSearchParams(search);
  const queryParamValue = params.get(GRAPHQL_URL_OVERRIDE_QUERY_PARAM)?.trim();

  return queryParamValue || null;
}

function isAllowedRuntimeGraphqlUrl(candidate: string): boolean {
  try {
    const url = toAbsoluteUrl(candidate);
    const allowedHosts = new Set([window.location.hostname, ...ALLOWED_RUNTIME_GRAPHQL_HOSTS]);

    return (url.protocol === 'http:' || url.protocol === 'https:') && allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function toAbsoluteUrl(candidate: string): URL {
  if (typeof window !== 'undefined') {
    return new URL(candidate, window.location.origin);
  }

  return new URL(candidate);
}

function getViewerHeaders(): Record<string, string> {
  const viewerAssertion = getConfiguredViewerAssertion();

  return {
    ...(viewerAssertion ? { [VIEWER_ASSERTION_HEADER]: viewerAssertion } : {}),
  };
}

export function getConfiguredViewerAssertion(): string | null {
  const envViewerAssertion = import.meta.env.VITE_INVOLUTE_VIEWER_ASSERTION;

  if (typeof envViewerAssertion === 'string' && envViewerAssertion.length > 0) {
    return envViewerAssertion;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  for (const storageKey of LOCAL_STORAGE_VIEWER_ASSERTION_KEYS) {
    const viewerAssertion = readLocalStorageValue(storageKey)?.trim();

    if (viewerAssertion) {
      return viewerAssertion;
    }
  }

  return null;
}
