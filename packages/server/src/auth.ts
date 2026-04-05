import { timingSafeEqual } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';
import { VIEWER_ASSERTION_HEADER } from '@involute/shared';
import { verifyViewerAssertion } from '@involute/shared/viewer-assertion';
import type { Plugin } from 'graphql-yoga';

import { DEFAULT_ADMIN_EMAIL } from './constants.js';
import { createNotAuthenticatedError, NOT_AUTHENTICATED_MESSAGE } from './errors.js';
import { getSessionRecord, readCookieValue, SESSION_COOKIE_NAME } from './session.js';

export interface GraphQLContext {
  authMode: 'none' | 'session' | 'token';
  isTrustedSystem: boolean;
  prisma: PrismaClient;
  viewer: User | null;
}

export interface GraphQLContextOptions {
  allowAdminFallback?: boolean;
  request: Request;
  prisma: PrismaClient;
  authToken: string;
  viewerAssertionSecret?: string | null;
}

interface RequestAuthentication {
  authMode: GraphQLContext['authMode'];
  authorized: boolean;
  isTrustedSystem: boolean;
  viewer: User | null;
}

const requestAuthenticationCache = new WeakMap<Request, Promise<RequestAuthentication>>();

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
  allowAdminFallback = false,
  request,
  prisma,
  authToken,
  viewerAssertionSecret,
}: GraphQLContextOptions): Promise<GraphQLContext> {
  const authentication = await resolveRequestAuthentication({
    allowAdminFallback,
    authToken,
    prisma,
    request,
    viewerAssertionSecret: viewerAssertionSecret ?? null,
  });

  return {
    authMode: authentication.authMode,
    isTrustedSystem: authentication.isTrustedSystem,
    prisma,
    viewer: authentication.viewer,
  };
}

export function requireAuthentication(context: GraphQLContext): User {
  if (!context.viewer) {
    throw createNotAuthenticatedError();
  }

  return context.viewer;
}

export function createAuthenticationPlugin(
  options: Omit<GraphQLContextOptions, 'request'>,
): Plugin {
  return {
    async onRequest({ endResponse, fetchAPI, request }) {
      const authentication = await resolveRequestAuthentication({
        ...options,
        request,
        viewerAssertionSecret: options.viewerAssertionSecret ?? null,
      });

      if (authentication.authorized) {
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

export async function resolveRequestAuthentication(
  options: GraphQLContextOptions,
): Promise<RequestAuthentication> {
  const cachedAuthentication = requestAuthenticationCache.get(options.request);

  if (cachedAuthentication) {
    return cachedAuthentication;
  }

  const authenticationPromise = computeRequestAuthentication(options);
  requestAuthenticationCache.set(options.request, authenticationPromise);
  return authenticationPromise;
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function computeRequestAuthentication({
  allowAdminFallback = false,
  authToken,
  prisma,
  request,
  viewerAssertionSecret,
}: GraphQLContextOptions): Promise<RequestAuthentication> {
  const sessionToken = readCookieValue(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  const session = await getSessionRecord(prisma, sessionToken);

  if (session) {
    return {
      authMode: 'session',
      authorized: true,
      isTrustedSystem: false,
      viewer: session.user,
    };
  }

  if (!isAuthorizedRequest(request, authToken)) {
    return {
      authMode: 'none',
      authorized: false,
      isTrustedSystem: false,
      viewer: null,
    };
  }

  const viewerLookup = getViewerLookup(request, viewerAssertionSecret, allowAdminFallback);
  const viewer = viewerLookup
    ? await prisma.user.findUnique({
        where: viewerLookup,
      })
    : null;

  return {
    authMode: 'token',
    authorized: true,
    isTrustedSystem: true,
    viewer,
  };
}

function getViewerLookup(
  request: Request,
  viewerAssertionSecret: string | null | undefined,
  allowAdminFallback: boolean,
): { email: string } | { id: string } | null {
  const viewerAssertion = verifyViewerAssertion(
    request.headers.get(VIEWER_ASSERTION_HEADER)?.trim(),
    viewerAssertionSecret,
  );

  if (viewerAssertion) {
    return viewerAssertion.subType === 'id'
      ? { id: viewerAssertion.sub }
      : { email: viewerAssertion.sub };
  }

  if (!allowAdminFallback) {
    return null;
  }

  return { email: DEFAULT_ADMIN_EMAIL };
}
