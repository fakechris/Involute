import { timingSafeEqual } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';
import type { Plugin } from 'graphql-yoga';

import { DEFAULT_ADMIN_EMAIL } from './constants.js';
import { createNotAuthenticatedError, NOT_AUTHENTICATED_MESSAGE } from './errors.js';

const VIEWER_ID_HEADER = 'x-involute-user-id';
const VIEWER_EMAIL_HEADER = 'x-involute-user-email';

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

  return Boolean(token && authToken && tokensMatch(token, authToken));
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

  const viewerLookup = getViewerLookup(request);
  const viewer = await prisma.user.findUnique({
    where: viewerLookup,
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

export function createAuthenticationPlugin(authToken: string): Plugin {
  return {
    onRequest({ endResponse, fetchAPI, request }) {
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

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getViewerLookup(request: Request): { email: string } | { id: string } {
  const viewerId = request.headers.get(VIEWER_ID_HEADER)?.trim();

  if (viewerId) {
    return { id: viewerId };
  }

  const viewerEmail = request.headers.get(VIEWER_EMAIL_HEADER)?.trim();

  if (viewerEmail) {
    return { email: viewerEmail };
  }

  return { email: DEFAULT_ADMIN_EMAIL };
}
