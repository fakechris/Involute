import { timingSafeEqual } from 'node:crypto';
import type { SemanticIndex } from './embeddings/semantic-index.js';

import type { PrismaClient, User } from '@prisma/client';
import { VIEWER_ASSERTION_HEADER } from '@turnkeyai/involute-shared';
import { verifyViewerAssertion } from '@turnkeyai/involute-shared/viewer-assertion';
import type { Plugin } from 'graphql-yoga';

import { DEFAULT_ADMIN_EMAIL } from './constants.js';
import { createNotAuthenticatedError, NOT_AUTHENTICATED_MESSAGE } from './errors.js';
import { getSessionRecord, readCookieValue, SESSION_COOKIE_NAME } from './session.js';
import { resolveAgentPrincipal, touchLastSeen } from './agent-credentials.js';
import { EMPTY_SHARE_SCOPE, resolveShareScope, type ShareScope } from './project-sharing.js';
import { GraphQLError } from 'graphql';
import { EXTENSION_TOKEN_PREFIX, EXTENSION_TOKEN_REFUSED_MESSAGE, extensionOperationAllowed, resolveExtensionPrincipal } from './extension-tokens.js';

export interface GraphQLContext {
  /** extension-token: the Involute Capture extension acting for a person, limited to filing bugs (INV-1145). */
  authMode: 'agent-token' | 'extension-token' | 'none' | 'session' | 'token';
  agentCredentialId?: string | null;
  agentScopes?: string[] | null;
  /** The team the acting credential is bound to (INV-592). An agent's access is this, not a membership. */
  agentTeamId?: string | null;
  isTrustedSystem: boolean;
  prisma: PrismaClient;
  /** Semantic search (INV-927); absent when embeddings are off. */
  semanticIndex?: SemanticIndex | null;
  /** What the viewer may reach through project shares (INV-832); resolved once per request. */
  shareScope?: ShareScope;
  viewer: User | null;
}

export interface GraphQLContextOptions {
  allowAdminFallback?: boolean;
  request: Request;
  prisma: PrismaClient;
  authToken: string;
  semanticIndex?: SemanticIndex | null;
  viewerAssertionSecret?: string | null;
}

interface RequestAuthentication {
  agentCredentialId?: string | null;
  agentScopes?: string[] | null;
  agentTeamId?: string | null;
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
  semanticIndex,
  viewerAssertionSecret,
}: GraphQLContextOptions): Promise<GraphQLContext> {
  const authentication = await resolveRequestAuthentication({
    allowAdminFallback,
    authToken,
    prisma,
    request,
    viewerAssertionSecret: viewerAssertionSecret ?? null,
  });

  // ADMIN and trusted-system callers read everything anyway; only a real,
  // bounded viewer needs its shares resolved.
  const shareScope =
    authentication.viewer && !authentication.isTrustedSystem && authentication.viewer.globalRole !== 'ADMIN'
      ? await resolveShareScope(prisma, authentication.viewer.id)
      : EMPTY_SHARE_SCOPE;

  return {
    authMode: authentication.authMode,
    agentCredentialId: authentication.agentCredentialId ?? null,
    agentScopes: authentication.authMode === 'agent-token' ? authentication.agentScopes ?? null : null,
    agentTeamId: authentication.authMode === 'agent-token' ? authentication.agentTeamId ?? null : null,
    isTrustedSystem: authentication.isTrustedSystem,
    prisma,
    semanticIndex: semanticIndex ?? null,
    shareScope,
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
    // An extension token runs only the operations filing a bug needs (INV-1145).
    onExecute({ args, setResultAndStopExecution }) {
      const context = args.contextValue as Partial<GraphQLContext> | undefined;
      if (context?.authMode !== 'extension-token') return;
      if (extensionOperationAllowed(args.document, args.operationName, args.variableValues as Record<string, unknown> | undefined)) return;
      setResultAndStopExecution({ errors: [new GraphQLError(EXTENSION_TOKEN_REFUSED_MESSAGE)] });
    },
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
  // An extension token is checked before the session cookie: a request that
  // carries both is the extension's, with its narrower rights, never the session's.
  const bearer = extractTokenFromAuthorizationHeader(request.headers.get('authorization'));
  if (bearer?.startsWith(EXTENSION_TOKEN_PREFIX)) {
    // Good for /graphql only, as its person; anywhere else, or once revoked or
    // expired, it authenticates nothing (INV-1145).
    const principal = new URL(request.url).pathname === '/graphql' ? await resolveExtensionPrincipal(prisma, bearer) : null;
    return principal
      ? { authMode: 'extension-token', authorized: true, isTrustedSystem: false, viewer: principal.user }
      : { authMode: 'none', authorized: false, isTrustedSystem: false, viewer: null };
  }

  const sessionToken = readCookieValue(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  const session = await getSessionRecord(prisma, sessionToken);

  if (session) {
    // People show "last seen" in Administration → Members like agents do (INV-853).
    await touchLastSeen(prisma, session.user, new Date());
    return {
      authMode: 'session',
      authorized: true,
      isTrustedSystem: false,
      viewer: session.user,
    };
  }

  const requestToken = extractTokenFromAuthorizationHeader(request.headers.get('authorization'));
  const pathname = new URL(request.url).pathname;

  const agent = (pathname === '/mcp' || pathname.startsWith('/mcp/'))
    ? await resolveAgentPrincipal(prisma, requestToken)
    : null;

  if (agent) {
    return {
      authMode: 'agent-token',
      agentCredentialId: agent.credentialId,
      agentScopes: agent.scopes,
      agentTeamId: agent.teamId,
      authorized: true,
      isTrustedSystem: false,
      viewer: agent.user,
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
