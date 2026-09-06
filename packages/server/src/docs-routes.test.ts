import { describe, expect, it } from 'vitest';

import { handleDocsRoutes } from './docs-routes.js';

function createMockResponse() {
  const response = {
    statusCode: 200,
    headers: new Map<string, string>(),
    body: '',
    ended: false,
    setHeader(key: string, value: string) {
      response.headers.set(key.toLowerCase(), value);
    },
    end(input?: string) {
      if (typeof input === 'string') {
        response.body += input;
      }
      response.ended = true;
    },
  };
  return response;
}

function createMockRequest(method: string, url: string) {
  return { method, url } as import('node:http').IncomingMessage;
}

function docRoutesTarget(url: string, method = 'GET') {
  return {
    request: createMockRequest(method, url),
    response: createMockResponse(),
  } as unknown as Parameters<typeof handleDocsRoutes>[0];
}

describe('docs routes', () => {
  it('serves a generated llms.txt index', async () => {
    const options = docRoutesTarget('/llms.txt');
    const handled = await handleDocsRoutes(options);

    expect(handled).toBe(true);
    const response = options.response as unknown as ReturnType<typeof createMockResponse>;
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.body).toContain('# Involute');
    expect(response.body).toContain('/llms-full.txt');
    expect(response.body).toContain('protocol_get_guide');
  });

  it('serves llms-full.txt including the protocol guide and whitelisted docs', async () => {
    const options = docRoutesTarget('/llms-full.txt');
    const handled = await handleDocsRoutes(options);

    expect(handled).toBe(true);
    const response = options.response as unknown as ReturnType<typeof createMockResponse>;
    expect(response.body).toContain('# Involute work protocol');
    expect(response.body).toContain('involute-signature');
  });

  it('serves whitelisted docs from the repository docs directory', async () => {
    const options = docRoutesTarget('/docs/api.md');
    const handled = await handleDocsRoutes(options);

    expect(handled).toBe(true);
    const response = options.response as unknown as ReturnType<typeof createMockResponse>;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('API Reference');
  });

  it('rejects non-whitelisted doc names and traversal attempts', async () => {
    for (const url of ['/docs/secret.md', '/docs/../.env', '/docs/..%2F.env', '/docs/']) {
      const options = docRoutesTarget(url);
      const handled = await handleDocsRoutes(options);

      expect(handled).toBe(true);
      const response = options.response as unknown as ReturnType<typeof createMockResponse>;
      expect(response.statusCode).toBe(404);
    }
  });

  it('ignores non-GET requests and unrelated paths', async () => {
    expect(await handleDocsRoutes(docRoutesTarget('/llms.txt', 'POST'))).toBe(false);
    expect(await handleDocsRoutes(docRoutesTarget('/graphql'))).toBe(false);
  });
});
