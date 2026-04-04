import { timingSafeEqual } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';
import { VIEWER_ASSERTION_HEADER } from '@involute/shared';
import { verifyViewerAssertion } from '@involute/shared/viewer-assertion';
import type { Plugin } from 'graphql-yoga';

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
  viewerAssertionSecret?: string | null;
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
  viewerAssertionSecret,
}: GraphQLContextOptions): Promise<GraphQLContext> {
  if (!isAuthorizedRequest(request, authToken)) {
    return {
      prisma,
      viewer: null,
    };
  }

  const viewerLookup = getViewerLookup(request, viewerAssertionSecret);
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

function getViewerLookup(
  request: Request,
  viewerAssertionSecret: string | null | undefined,
): { email: string } | { id: string } {
  const viewerAssertion = verifyViewerAssertion(
    request.headers.get(VIEWER_ASSERTION_HEADER)?.trim(),
    viewerAssertionSecret,
  );

  if (viewerAssertion) {
    return viewerAssertion.subType === 'id'
      ? { id: viewerAssertion.sub }
      : { email: viewerAssertion.sub };
  }

  return { email: DEFAULT_ADMIN_EMAIL };
}
