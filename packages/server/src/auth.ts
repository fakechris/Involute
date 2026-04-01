import type { PrismaClient, User } from '@prisma/client';

import { DEFAULT_ADMIN_EMAIL } from './constants.js';
import { createNotAuthenticatedError, NOT_AUTHENTICATED_MESSAGE } from './errors.js';

export interface GraphQLContext {
  prisma: PrismaClient;
  viewer: User | null;
}

export interface GraphQLContextOptions {
  request: Request;
  prisma: PrismaClient;
  authToken: string;
}

export function extractTokenFromAuthorizationHeader(
  authorizationHeader: string | null,
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmedHeader = authorizationHeader.trim();

  if (!trimmedHeader) {
    return null;
  }

  const parts = trimmedHeader.split(/\s+/);
  const [scheme, ...tokenParts] = parts;

  if (scheme?.toLowerCase() === 'bearer') {
    const bearerToken = tokenParts.join(' ').trim();
    return bearerToken || null;
  }

  return trimmedHeader;
}

export function isAuthorizedRequest(
  request: Request,
  authToken: string,
): boolean {
  const token = extractTokenFromAuthorizationHeader(request.headers.get('authorization'));

  return Boolean(token && authToken && token === authToken);
}

export async function createGraphQLContext({
  request,
  prisma,
  authToken,
}: GraphQLContextOptions): Promise<GraphQLContext> {
  if (!isAuthorizedRequest(request, authToken)) {
    return {
      prisma,
      viewer: null,
    };
  }

  const viewer = await prisma.user.findUnique({
    where: {
      email: DEFAULT_ADMIN_EMAIL,
    },
  });

  return {
    prisma,
    viewer,
  };
}

export function requireAuthentication(context: GraphQLContext): User {
  if (!context.viewer) {
    throw createNotAuthenticatedError();
  }

  return context.viewer;
}

export function createAuthenticationPlugin(authToken: string) {
  return {
    onRequest({ endResponse, fetchAPI, request }: any) {
      if (isAuthorizedRequest(request, authToken)) {
        return;
      }

      endResponse(
        new fetchAPI.Response(
          JSON.stringify({
            errors: [
              {
                message: NOT_AUTHENTICATED_MESSAGE,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
      );
    },
  };
}
