import { describe, expect, it } from 'vitest';

import { createApolloClient } from './apollo';

describe('createApolloClient', () => {
  it('refetches on every page visit instead of serving only the cache (g c to Candidates showed stale work)', () => {
    const client = createApolloClient();
    expect(client.defaultOptions.watchQuery).toMatchObject({
      fetchPolicy: 'cache-and-network',
      nextFetchPolicy: 'cache-first',
    });
  });
});
