import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearClient, createLinearClientFromEnv } from './client.js';

// --- Mock fetch ---

function mockFetch(responses: Array<{ data?: unknown; errors?: Array<{ message: string }> } | 'networkError'>): void {
  let callIndex = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    const resp = responses[callIndex++];
    if (resp === 'networkError') {
      throw new Error('Network error');
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => resp,
    };
  }));
}

describe('LinearClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('request', () => {
    it('sends correct headers and body', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { viewer: { id: '1' } } }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      const client = new LinearClient({ apiToken: 'test-token-123' });
      await client.request('{ viewer { id } }');

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe('https://api.linear.app/graphql');
      expect(call[1].method).toBe('POST');
      expect((call[1].headers as Record<string, string>)['Authorization']).toBe('test-token-123');
      expect((call[1].headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(call[1].body as string)).toEqual({
        query: '{ viewer { id } }',
      });
    });

    it('uses custom endpoint when provided', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { ok: true } }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      const client = new LinearClient({
        apiToken: 'tok',
        endpoint: 'https://custom.endpoint/graphql',
      });
      await client.request('{ ok }');

      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe('https://custom.endpoint/graphql');
    });

    it('returns data on success', async () => {
      mockFetch([{ data: { teams: [{ id: '1' }] } }]);

      const client = new LinearClient({ apiToken: 'tok' });
      const result = await client.request<{ teams: Array<{ id: string }> }>('{ teams { id } }');
      expect(result).toEqual({ teams: [{ id: '1' }] });
    });

    it('throws on GraphQL errors', async () => {
      mockFetch([{ errors: [{ message: 'Auth failed' }] }]);

      const client = new LinearClient({ apiToken: 'tok' });
      await expect(client.request('{ x }')).rejects.toThrow('Linear GraphQL error: Auth failed');
    });

    it('throws on HTTP errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      })));

      const client = new LinearClient({ apiToken: 'tok' });
      await expect(client.request('{ x }')).rejects.toThrow('Linear API HTTP error: 500 Internal Server Error');
    });

    it('throws when data is undefined', async () => {
      mockFetch([{}]);

      const client = new LinearClient({ apiToken: 'tok' });
      await expect(client.request('{ x }')).rejects.toThrow('Linear API returned no data');
    });

    it('passes variables correctly', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { issue: { id: 'abc' } } }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      const client = new LinearClient({ apiToken: 'tok' });
      await client.request('query($id: String!) { issue(id: $id) { id } }', { id: 'abc' });

      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { variables: { id: string } };
      expect(body.variables).toEqual({ id: 'abc' });
    });
  });

  describe('paginate', () => {
    it('collects all nodes across multiple pages', async () => {
      mockFetch([
        {
          data: {
            items: {
              nodes: [{ id: '1' }, { id: '2' }],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        },
        {
          data: {
            items: {
              nodes: [{ id: '3' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ]);

      const client = new LinearClient({ apiToken: 'tok' });
      type ItemsResp = { items: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      const result = await client.paginate<ItemsResp, { id: string }>(
        'query($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }',
        (data) => data.items,
      );

      expect(result).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    });

    it('passes after cursor in subsequent requests', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              items: {
                nodes: [{ id: '1' }],
                pageInfo: { hasNextPage: true, endCursor: 'cur-abc' },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              items: {
                nodes: [{ id: '2' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        });
      vi.stubGlobal('fetch', fetchMock);

      const client = new LinearClient({ apiToken: 'tok' });
      type ItemsResp = { items: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      await client.paginate<ItemsResp, { id: string }>(
        'query { items { nodes { id } pageInfo { hasNextPage endCursor } } }',
        (data) => data.items,
        undefined,
        10,
      );

      // First call: after=null
      const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { variables: { after: string | null } };
      expect(firstBody.variables.after).toBeNull();

      // Second call: after=cur-abc
      const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string) as { variables: { after: string | null } };
      expect(secondBody.variables.after).toBe('cur-abc');
    });

    it('returns empty array when first page is empty', async () => {
      mockFetch([
        {
          data: {
            items: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ]);

      const client = new LinearClient({ apiToken: 'tok' });
      type ItemsResp = { items: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      const result = await client.paginate<ItemsResp, { id: string }>(
        'query { items { nodes { id } pageInfo { hasNextPage endCursor } } }',
        (data) => data.items,
      );

      expect(result).toEqual([]);
    });

    it('handles pagination with more than 50 items (3 pages)', async () => {
      const page1Nodes = Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1) }));
      const page2Nodes = Array.from({ length: 50 }, (_, i) => ({ id: String(i + 51) }));
      const page3Nodes = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 101) }));

      mockFetch([
        {
          data: {
            items: {
              nodes: page1Nodes,
              pageInfo: { hasNextPage: true, endCursor: 'cur-50' },
            },
          },
        },
        {
          data: {
            items: {
              nodes: page2Nodes,
              pageInfo: { hasNextPage: true, endCursor: 'cur-100' },
            },
          },
        },
        {
          data: {
            items: {
              nodes: page3Nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ]);

      const client = new LinearClient({ apiToken: 'tok' });
      type ItemsResp = { items: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      const result = await client.paginate<ItemsResp, { id: string }>(
        'query { items { nodes { id } pageInfo { hasNextPage endCursor } } }',
        (data) => data.items,
      );

      expect(result).toHaveLength(110);
      expect(result[0]).toEqual({ id: '1' });
      expect(result[109]).toEqual({ id: '110' });
    });
  });
});

describe('createLinearClientFromEnv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when LINEAR_API_TOKEN is not set', () => {
    // Ensure the env var is not set
    const original = process.env['LINEAR_API_TOKEN'];
    delete process.env['LINEAR_API_TOKEN'];
    try {
      expect(() => createLinearClientFromEnv()).toThrow('LINEAR_API_TOKEN environment variable is required');
    } finally {
      if (original !== undefined) {
        process.env['LINEAR_API_TOKEN'] = original;
      }
    }
  });

  it('creates client when LINEAR_API_TOKEN is set', () => {
    process.env['LINEAR_API_TOKEN'] = 'test-token';
    try {
      const client = createLinearClientFromEnv();
      expect(client).toBeInstanceOf(LinearClient);
    } finally {
      delete process.env['LINEAR_API_TOKEN'];
    }
  });
});
