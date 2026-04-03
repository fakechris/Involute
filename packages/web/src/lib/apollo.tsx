import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
} from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { setContext } from '@apollo/client/link/context';
import type { PropsWithChildren } from 'react';
import { useMemo } from 'react';

const DEFAULT_GRAPHQL_URL = 'http://localhost:4200/graphql';
const LOCAL_STORAGE_AUTH_KEYS = ['involute.authToken', 'involuteAuthToken'] as const;
const LOCAL_STORAGE_GRAPHQL_URL_KEYS = ['involute.graphqlUrl', 'involuteGraphqlUrl'] as const;
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
      const configuredToken = window.localStorage.getItem(storageKey);

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

export function createApolloClient() {
  const httpLink = new HttpLink({
    uri: getGraphqlUrl(),
  });

  const authLink = setContext((_, { headers }) => {
    const token = getAuthToken();

    return {
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  });

  return new ApolloClient({
    cache: new InMemoryCache(),
    link: authLink.concat(httpLink),
  });
}

export function getBoardBootstrapErrorMessage(error: Error): {
  title: string;
  description: string;
} {
  const message = error.message.toLowerCase();
  const { source } = getAuthTokenDetails();

  if (message.includes('not authenticated') || message.includes('unauthenticated')) {
    if (source === 'missing') {
      return {
        title: 'Runtime auth token missing',
        description:
          'The board could not find a runtime auth token. Set `VITE_INVOLUTE_AUTH_TOKEN` or store the token in localStorage under `involute.authToken`, then reload.',
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

export function AppApolloProvider({ children }: PropsWithChildren) {
  const client = useMemo(() => createApolloClient(), []);

  return <ApolloProvider client={client}>{children}</ApolloProvider>;
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
    const configuredUrl = window.localStorage.getItem(storageKey)?.trim();

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
    const url = new URL(candidate);
    const allowedHosts = new Set([window.location.hostname, ...ALLOWED_RUNTIME_GRAPHQL_HOSTS]);

    return (url.protocol === 'http:' || url.protocol === 'https:') && allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}
