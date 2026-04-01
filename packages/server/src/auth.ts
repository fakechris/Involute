import type { PrismaClient, User } from '@prisma/client';

import { GraphQLError } from 'graphql';

import { DEFAULT_ADMIN_EMAIL } from './constants.js';

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

export async function createGraphQLContext({
  request,
  prisma,
  authToken,
}: GraphQLContextOptions): Promise<GraphQLContext> {
  const token = extractTokenFromAuthorizationHeader(request.headers.get('authorization'));

  if (!token || !authToken || token !== authToken) {
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
    throw new GraphQLError('Not authenticated');
  }

  return context.viewer;
}
