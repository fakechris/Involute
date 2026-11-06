import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { resolveRequestAuthentication } from './auth.js';
import { assertCanManageTeam } from './access-control.js';
import { completeAppManifest } from './github-app.js';
import { completeInstall } from './github-connections.js';
import type { GraphQLContext } from './auth.js';

/**
 * Browser round trips through GitHub (INV-1677). GitHub sends the person back
 * here after they create the App; the session cookie says who they are, the
 * signed state says they started it. The page they land on reports the result.
 */
export interface GitHubAppRouteOptions {
  prisma: PrismaClient;
  appOrigin: string;
  allowAdminFallback: boolean;
  authToken: string;
  viewerAssertionSecret: string | null;
  onAppCreated?: () => void;
  onConnected?: () => void;
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader('location', location);
  response.end();
}

export async function handleGitHubAppRoute(options: GitHubAppRouteOptions, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', options.appOrigin);
  const created = url.pathname === '/auth/github-app/created';
  const installed = url.pathname === '/auth/github-app/installed';
  if (request.method !== 'GET' || (!created && !installed)) return false;
  const back = (params: Record<string, string>) => `${options.appOrigin.replace(/\/$/, '')}/settings?${new URLSearchParams({ tab: 'github', ...params })}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
  const authentication = await resolveRequestAuthentication({
    allowAdminFallback: options.allowAdminFallback,
    authToken: options.authToken,
    prisma: options.prisma,
    request: new Request(url, { headers }),
    viewerAssertionSecret: options.viewerAssertionSecret,
  });
  const viewer = authentication.viewer;
  if (!viewer) {
    redirect(response, back({ github_error: 'Sign in to Involute first, then create the GitHub App again from Settings → GitHub.' }));
    return true;
  }
  if (installed) {
    try {
      const connection = await completeInstall(options.prisma, {
        installationId: url.searchParams.get('installation_id') ?? '',
        state: url.searchParams.get('state'),
        userId: viewer.id,
        canManageTeam: (teamId) =>
          assertCanManageTeam(options.prisma, { prisma: options.prisma, viewer, authMode: authentication.authMode } as unknown as GraphQLContext, teamId).then(() => true, () => false),
      });
      options.onConnected?.();
      redirect(response, back({ github: 'connected', account: connection.accountLogin }));
    } catch (error) {
      redirect(response, back({ github_error: error instanceof Error ? error.message : 'The installation could not be connected.' }));
    }
    return true;
  }
  try {
    await completeAppManifest(options.prisma, { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '', viewer });
    options.onAppCreated?.();
    redirect(response, back({ github: 'app-created' }));
  } catch (error) {
    redirect(response, back({ github_error: error instanceof Error ? error.message : 'The GitHub App could not be saved.' }));
  }
  return true;
}
