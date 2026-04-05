import { describe, expect, it, vi } from 'vitest';
import { createViewerAssertion } from '@involute/shared/viewer-assertion';

import { createGraphQLContext, extractTokenFromAuthorizationHeader, isAuthorizedRequest } from './auth.js';

describe('auth', () => {
  const futureExpiry = () => Math.floor((Date.now() + 60_000) / 1000);

  it('extracts bearer tokens from the authorization header', () => {
    expect(extractTokenFromAuthorizationHeader('Bearer test-token')).toBe('test-token');
    expect(extractTokenFromAuthorizationHeader('  bearer   test-token  ')).toBe('test-token');
  });

  it('uses constant-time comparison semantics for token equality checks', () => {
    const request = new Request('http://localhost/graphql', {
      headers: {
        authorization: 'Bearer shared-secret',
      },
    });

    expect(isAuthorizedRequest(request, 'shared-secret')).toBe(true);
    expect(isAuthorizedRequest(request, 'shared-secret-with-extra')).toBe(false);
    expect(isAuthorizedRequest(request, 'shared-secreu')).toBe(false);
  });

  it('resolves the viewer from a signed email assertion when provided', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' });
    const viewerAssertion = createViewerAssertion(
      {
        exp: futureExpiry(),
        sub: 'person@example.com',
        subType: 'email',
      },
      'viewer-secret',
    );

    const context = await createGraphQLContext({
      authToken: 'shared-secret',
      prisma: {
        user: {
          findUnique,
        },
      } as never,
      viewerAssertionSecret: 'viewer-secret',
      request: new Request('http://localhost/graphql', {
        headers: {
          authorization: 'Bearer shared-secret',
          'x-involute-viewer-assertion': viewerAssertion,
        },
      }),
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        email: 'person@example.com',
      },
    });
    expect(context.viewer).toEqual({ id: 'user-1', email: 'person@example.com' });
  });

  it('resolves the viewer from a signed user ID assertion when provided', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' });
    const viewerAssertion = createViewerAssertion(
      {
        exp: futureExpiry(),
        sub: 'user-1',
        subType: 'id',
      },
      'viewer-secret',
    );

    const context = await createGraphQLContext({
      authToken: 'shared-secret',
      prisma: {
        user: {
          findUnique,
        },
      } as never,
      viewerAssertionSecret: 'viewer-secret',
      request: new Request('http://localhost/graphql', {
        headers: {
          authorization: 'Bearer shared-secret',
          'x-involute-viewer-assertion': viewerAssertion,
        },
      }),
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        id: 'user-1',
      },
    });
    expect(context.viewer).toEqual({ id: 'user-1', email: 'person@example.com' });
  });

  it('returns a null viewer when no trusted viewer assertion is present', async () => {
    const findUnique = vi.fn();

    const context = await createGraphQLContext({
      authToken: 'shared-secret',
      prisma: {
        user: {
          findUnique,
        },
      } as never,
      request: new Request('http://localhost/graphql', {
        headers: {
          authorization: 'Bearer shared-secret',
        },
      }),
    });

    expect(findUnique).not.toHaveBeenCalled();
    expect(context.viewer).toBeNull();
  });

  it('ignores invalid viewer assertions instead of silently falling back to admin', async () => {
    const findUnique = vi.fn();

    const context = await createGraphQLContext({
      authToken: 'shared-secret',
      prisma: {
        user: {
          findUnique,
        },
      } as never,
      viewerAssertionSecret: 'viewer-secret',
      request: new Request('http://localhost/graphql', {
        headers: {
          authorization: 'Bearer shared-secret',
          'x-involute-viewer-assertion': 'definitely.invalid',
        },
      }),
    });

    expect(findUnique).not.toHaveBeenCalled();
    expect(context.viewer).toBeNull();
  });

  it('only falls back to the default admin viewer when explicitly allowed', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'admin-1', email: 'admin@involute.local' });

    await createGraphQLContext({
      allowAdminFallback: true,
      authToken: 'shared-secret',
      prisma: {
        user: {
          findUnique,
        },
      } as never,
      request: new Request('http://localhost/graphql', {
        headers: {
          authorization: 'Bearer shared-secret',
        },
      }),
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        email: 'admin@involute.local',
      },
    });
  });
});
