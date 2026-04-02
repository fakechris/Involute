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

function getAuthToken(): string {
  const envToken = import.meta.env.VITE_INVOLUTE_AUTH_TOKEN;

  if (typeof envToken === 'string' && envToken.length > 0) {
    return envToken;
  }

  if (typeof window !== 'undefined') {
    const configuredToken = window.localStorage.getItem('involute.authToken');

    if (configuredToken) {
      return configuredToken;
    }
  }

  return '';
}

function getGraphqlUrl(): string {
  const envUrl = import.meta.env.VITE_INVOLUTE_GRAPHQL_URL;

  if (typeof envUrl === 'string' && envUrl.length > 0) {
    return envUrl;
  }

  return DEFAULT_GRAPHQL_URL;
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

export function AppApolloProvider({ children }: PropsWithChildren) {
  const client = useMemo(() => createApolloClient(), []);

  return <ApolloProvider client={client}>{children}</ApolloProvider>;
}
