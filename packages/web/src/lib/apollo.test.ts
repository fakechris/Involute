import { gql } from '@apollo/client';
import { ServerError } from '@apollo/client/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApolloClient, isRetryableReadFailure, retryDelayMs } from './apollo';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function gatewayError(status: number): Response {
  return new Response('<html>Bad gateway</html>', { status, headers: { 'content-type': 'text/html' } });
}

describe('createApolloClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refetches on every page visit instead of serving only the cache (g c to Candidates showed stale work)', () => {
    const client = createApolloClient();
    expect(client.defaultOptions.watchQuery).toMatchObject({
      fetchPolicy: 'cache-and-network',
      nextFetchPolicy: 'cache-first',
    });
  });

  it('sends a read again after a 502 from the proxy, so a refresh shows the board (INV-2210)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(gatewayError(502))
      .mockResolvedValueOnce(jsonResponse({ data: { __typename: 'Query' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApolloClient();
    const result = await client.query({ query: gql`query Probe { __typename }`, fetchPolicy: 'network-only' });

    expect(result.data).toEqual({ __typename: 'Query' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends a read again after the connection dropped (INV-2210)', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ data: { __typename: 'Query' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApolloClient();
    const result = await client.query({ query: gql`query Probe { __typename }`, fetchPolicy: 'network-only' });

    expect(result.data).toEqual({ __typename: 'Query' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends a read again after the session was rate limited (429) (INV-2312)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Rate limit exceeded. Retry later.' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { __typename: 'Query' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApolloClient();
    const result = await client.query({ query: gql`query Probe { __typename }`, fetchPolicy: 'network-only' });

    expect(result.data).toEqual({ __typename: 'Query' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never sends a write twice, even after a 502 (INV-2210)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(gatewayError(502));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApolloClient();
    await expect(client.mutate({ mutation: gql`mutation Touch { __typename }` })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the error after three failed reads instead of retrying forever (INV-2210)', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => gatewayError(503));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApolloClient();
    await expect(client.query({ query: gql`query Probe { __typename }`, fetchPolicy: 'network-only' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not resend a GraphQL refusal or a sign-in answer (INV-2210)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Not authenticated' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApolloClient();
    await expect(client.query({ query: gql`query Probe { __typename }`, fetchPolicy: 'network-only' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableReadFailure', () => {
  it('retries reads only, and not a cancelled request', () => {
    expect(isRetryableReadFailure(new TypeError('Failed to fetch'), 'query')).toBe(true);
    expect(isRetryableReadFailure(new TypeError('Failed to fetch'), 'mutation')).toBe(false);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isRetryableReadFailure(abort, 'query')).toBe(false);
  });
});

describe('retryDelayMs', () => {
  function rateLimited(retryAfter: string | null) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (retryAfter !== null) headers['retry-after'] = retryAfter;
    return new ServerError('Response not successful: Received status code 429', {
      response: new Response('{}', { status: 429, headers }),
      bodyText: '{}',
    });
  }

  it('waits what a 429 asks for, at most five seconds (INV-2312)', () => {
    expect(retryDelayMs(0, rateLimited('2'))).toBe(2_000);
    expect(retryDelayMs(0, rateLimited('30'))).toBe(5_000);
    expect(retryDelayMs(0, rateLimited(null))).toBe(1_000);
  });

  it('backs off briefly for a dropped connection', () => {
    const delay = retryDelayMs(1, new TypeError('Failed to fetch'));
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(2_000);
  });
});
