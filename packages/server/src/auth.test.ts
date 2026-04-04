import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ADMIN_EMAIL } from './constants.js';
import { createGraphQLContext, extractTokenFromAuthorizationHeader, isAuthorizedRequest } from './auth.js';

describe('auth', () => {
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

  it('resolves the viewer from the request email header when provided', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' });

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
          'x-involute-user-email': 'person@example.com',
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

  it('falls back to the default admin viewer when no explicit viewer header is present', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'admin-1', email: DEFAULT_ADMIN_EMAIL });

    await createGraphQLContext({
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
        email: DEFAULT_ADMIN_EMAIL,
      },
    });
  });
});
