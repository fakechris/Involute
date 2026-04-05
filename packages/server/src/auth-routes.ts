import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { ServerResponse, IncomingMessage } from 'node:http';

import { resolveRequestAuthentication, type GraphQLContextOptions } from './auth.js';
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCodeForUserProfile,
  isGoogleOAuthConfigured,
  type GoogleOAuthConfiguration,
  upsertGoogleOAuthUser,
} from './google-oauth.js';
import {
  createSession,
  deleteSession,
  OAUTH_STATE_COOKIE_NAME,
  readCookieValue,
  serializeExpiredOAuthStateCookie,
  serializeExpiredSessionCookie,
  serializeOAuthStateCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from './session.js';

export interface AuthRouteOptions extends Omit<GraphQLContextOptions, 'request'> {
  appOrigin: string;
  googleOAuth: GoogleOAuthConfiguration;
  request: IncomingMessage;
  response: ServerResponse;
  sessionTtlSeconds: number;
}

export async function handleAuthRoutes(options: AuthRouteOptions): Promise<boolean> {
  const pathname = getPathname(options.request.url);

  if (pathname === '/auth/google/start') {
    await handleGoogleStart(options);
    return true;
  }

  if (pathname === '/auth/google/callback') {
    await handleGoogleCallback(options);
    return true;
  }

  if (pathname === '/auth/session') {
    await handleSessionRequest(options);
    return true;
  }

  if (pathname === '/auth/logout') {
    await handleLogoutRequest(options);
    return true;
  }

  return false;
}

export function getAllowedBrowserOrigins(appOrigin: string): string[] {
  const allowedOrigins = new Set<string>([appOrigin]);

  try {
    const origin = new URL(appOrigin);
    const localHostnames = new Set(['127.0.0.1', 'localhost']);

    if (localHostnames.has(origin.hostname)) {
      for (const hostname of localHostnames) {
        const localOrigin = new URL(origin.toString());
        localOrigin.hostname = hostname;
        allowedOrigins.add(localOrigin.origin);
      }
    }
  } catch {
    return [appOrigin];
  }

  return [...allowedOrigins];
}

function getPathname(url: string | undefined): string {
  if (!url) {
    return '/';
  }

  const questionMarkIndex = url.indexOf('?');
  return questionMarkIndex === -1 ? url : url.slice(0, questionMarkIndex);
}

async function handleGoogleStart({
  appOrigin,
  googleOAuth,
  request,
  response,
}: AuthRouteOptions): Promise<void> {
  if (!isGoogleOAuthConfigured(googleOAuth)) {
    respondJson(response, 503, {
      error: 'Google OAuth is not configured.',
    });
    return;
  }

  const state = randomBytes(24).toString('base64url');
  const redirectUrl = buildGoogleAuthorizationUrl(googleOAuth, state);
  const secure = isSecureOrigin(appOrigin);

  response.statusCode = 302;
  response.setHeader('Location', redirectUrl);
  response.setHeader('Set-Cookie', serializeOAuthStateCookie(state, { secure }));
  response.end();
}

async function handleGoogleCallback({
  appOrigin,
  googleOAuth,
  prisma,
  request,
  response,
  sessionTtlSeconds,
}: AuthRouteOptions): Promise<void> {
  const secure = isSecureOrigin(appOrigin);
  const callbackUrl = new URL(request.url ?? '/auth/google/callback', googleOAuth.redirectUri ?? appOrigin);
  const code = callbackUrl.searchParams.get('code');
  const returnedState = callbackUrl.searchParams.get('state');
  const storedState = readCookieValue(request.headers.cookie ?? null, OAUTH_STATE_COOKIE_NAME);

  response.setHeader('Set-Cookie', serializeExpiredOAuthStateCookie(secure));

  if (!code || !returnedState || !storedState || storedState !== returnedState) {
    redirectToApp(response, appOrigin, 'oauth_state_invalid');
    return;
  }

  try {
    const profile = await exchangeGoogleCodeForUserProfile(code, googleOAuth);
    const user = await upsertGoogleOAuthUser(prisma, profile, googleOAuth);
    const session = await createSession(prisma, user.id, sessionTtlSeconds);

    response.statusCode = 302;
    response.setHeader('Location', appOrigin);
    response.setHeader('Set-Cookie', [
      serializeExpiredOAuthStateCookie(secure),
      serializeSessionCookie({
        maxAgeSeconds: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
        secure,
        value: session.token,
      }),
    ]);
    response.end();
  } catch {
    redirectToApp(response, appOrigin, 'oauth_callback_failed');
  }
}

async function handleSessionRequest({
  allowAdminFallback,
  appOrigin,
  authToken,
  googleOAuth,
  prisma,
  request,
  response,
  viewerAssertionSecret,
}: AuthRouteOptions): Promise<void> {
  if (request.method === 'OPTIONS') {
    respondCorsPreflight(response, appOrigin, request.headers.origin);
    return;
  }

  const requestUrl = toFetchRequest(request, appOrigin);
  const authentication = await resolveRequestAuthentication({
    allowAdminFallback: allowAdminFallback ?? false,
    authToken,
    prisma,
    request: requestUrl,
    viewerAssertionSecret: viewerAssertionSecret ?? null,
  });

  respondJson(
    response,
    authentication.authorized ? 200 : 401,
    {
      authMode: authentication.authMode,
      authenticated: authentication.authorized,
      googleOAuthConfigured: isGoogleOAuthConfigured(googleOAuth),
      viewer: authentication.viewer
        ? {
            email: authentication.viewer.email,
            globalRole: authentication.viewer.globalRole,
            id: authentication.viewer.id,
            name: authentication.viewer.name,
          }
        : null,
    },
    buildResponseOptions(appOrigin, request.headers.origin),
  );
}

async function handleLogoutRequest({
  appOrigin,
  prisma,
  request,
  response,
}: AuthRouteOptions): Promise<void> {
  if (request.method === 'OPTIONS') {
    respondCorsPreflight(response, appOrigin, request.headers.origin);
    return;
  }

  if (request.method !== 'POST') {
    respondJson(response, 405, { error: 'Method not allowed.' }, {
      ...buildResponseOptions(appOrigin, request.headers.origin),
    });
    return;
  }

  await deleteSession(prisma, readCookieValue(request.headers.cookie ?? null, SESSION_COOKIE_NAME));

  respondJson(response, 200, { success: true }, {
    ...buildResponseOptions(appOrigin, request.headers.origin),
    setCookie: serializeExpiredSessionCookie(isSecureOrigin(appOrigin)),
  });
}

function redirectToApp(response: ServerResponse, appOrigin: string, reason: string): void {
  const redirectUrl = new URL(appOrigin);
  redirectUrl.searchParams.set('authError', reason);
  response.statusCode = 302;
  response.setHeader('Location', redirectUrl.toString());
  response.end();
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  options: {
    appOrigin?: string;
    requestOrigin?: string;
    setCookie?: string | string[];
  } = {},
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');

  applyCorsHeaders(response, options.appOrigin, options.requestOrigin);

  if (options.setCookie) {
    response.setHeader('Set-Cookie', options.setCookie);
  }

  response.end(JSON.stringify(payload));
}

function respondCorsPreflight(
  response: ServerResponse,
  appOrigin: string,
  requestOrigin: string | undefined,
): void {
  response.statusCode = 204;
  applyCorsHeaders(response, appOrigin, requestOrigin);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  response.end();
}

function applyCorsHeaders(
  response: ServerResponse,
  appOrigin: string | undefined,
  requestOrigin: string | undefined,
): void {
  if (!appOrigin || !requestOrigin) {
    return;
  }

  const allowedOrigins = getAllowedBrowserOrigins(appOrigin);

  if (!allowedOrigins.includes(requestOrigin)) {
    return;
  }

  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Origin', requestOrigin);
  response.setHeader('Vary', 'Origin');
}

function isSecureOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

function toFetchRequest(request: IncomingMessage, appOrigin: string): Request {
  const requestUrl = new URL(request.url ?? '/', appOrigin);
  const headerEntries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'undefined') {
      continue;
    }

    if (Array.isArray(value)) {
      headerEntries.push([key, value.join(', ')]);
      continue;
    }

    headerEntries.push([key, value]);
  }

  return new Request(requestUrl, {
    headers: new Headers(headerEntries),
    method: request.method ?? 'GET',
  });
}

function buildResponseOptions(appOrigin: string, requestOrigin: string | undefined): {
  appOrigin?: string;
  requestOrigin?: string;
} {
  return requestOrigin
    ? {
        appOrigin,
        requestOrigin,
      }
    : {};
}
