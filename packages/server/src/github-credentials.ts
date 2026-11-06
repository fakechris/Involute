import { createSign } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { resolveRepoRoute } from './github-repo-routes.js';
import { openSecret } from './secret-box.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Which GitHub credential reads a repository (INV-1677). A repository belongs
 * to the team whose PROJECT names it (github-repo-routes.ts); that team's
 * connection to the repository's owner supplies the token — an App
 * installation first, then a token the team pasted. Only when the team has
 * neither does the server-wide GITHUB_TOKEN apply, so one team's credential
 * never reads another team's repositories.
 */

export type GitHubTokenSource = 'app' | 'team-token' | 'env';

export interface ResolvedGitHubToken {
  token: string;
  source: GitHubTokenSource;
  connectionId: string | null;
}

/** Mints installation tokens for the instance's GitHub App; null until the App exists (stage 2). */
export interface InstallationTokenSource {
  tokenFor(installationId: string): Promise<string>;
}

export interface ResolveOptions {
  app?: InstallationTokenSource | null;
  env?: NodeJS.ProcessEnv;
}

function ownerOf(repository: string): string | null {
  const [owner, name] = repository.trim().split('/');
  return owner && name ? owner : null;
}

export async function resolveGitHubToken(prisma: DatabaseClient, repository: string, options: ResolveOptions = {}): Promise<ResolvedGitHubToken | null> {
  const env = options.env ?? process.env;
  const owner = ownerOf(repository);
  const route = owner ? await resolveRepoRoute(prisma, repository) : null;
  const team = route ? await prisma.team.findUnique({ where: { key: route.teamKey }, select: { id: true } }) : null;
  if (team && owner) {
    const connections = await prisma.gitHubConnection.findMany({
      where: { teamId: team.id, provider: 'github', status: 'ACTIVE', accountLogin: { equals: owner, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
    });
    const installation = connections.find((connection) => connection.kind === 'APP_INSTALLATION' && connection.installationId);
    if (installation && options.app) {
      try {
        return { token: await options.app.tokenFor(installation.installationId!), source: 'app', connectionId: installation.id };
      } catch (error) {
        // The installation is gone or the App lost access: tell the team, then read with what is left.
        await prisma.gitHubConnection.updateMany({
          where: { id: installation.id, status: 'ACTIVE' },
          data: { status: 'DISCONNECTED', lastError: (error instanceof Error ? error.message : 'GitHub refused an installation token.').slice(0, 300), lastCheckedAt: new Date() },
        });
      }
    }
    const pasted = connections.find((connection) => connection.kind === 'TOKEN' && connection.tokenEncrypted);
    if (pasted) return { token: openSecret(pasted.tokenEncrypted!, env), source: 'team-token', connectionId: pasted.id };
  }
  const fallback = env.GITHUB_TOKEN?.trim();
  return fallback ? { token: fallback, source: 'env', connectionId: null } : null;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** The App JWT GitHub accepts for /app endpoints: RS256, issued by the App id, valid under ten minutes. */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKeyPem, 'base64url')}`;
}

/**
 * Installation tokens last an hour; each is cached and replaced five minutes
 * before it expires, so a sync cycle mints at most one per installation.
 */
export function createInstallationTokenSource(input: {
  appId: string;
  privateKeyPem: string;
  fetch?: FetchLike;
  now?: () => number;
}): InstallationTokenSource {
  const fetchImpl: FetchLike = input.fetch ?? ((url, init) => fetch(url, init));
  const now = input.now ?? Date.now;
  const cache = new Map<string, { token: string; refreshAt: number }>();
  return {
    async tokenFor(installationId) {
      const cached = cache.get(installationId);
      if (cached && cached.refreshAt > now()) return cached.token;
      const response = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${appJwt(input.appId, input.privateKeyPem, Math.floor(now() / 1000))}`,
          'User-Agent': 'Involute',
        },
      });
      if (!response.ok) throw new Error(`GitHub refused an installation token for installation ${installationId}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
      if (typeof body.token !== 'string' || !body.token) throw new Error(`GitHub returned no installation token for installation ${installationId}.`);
      const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : now() + 60 * 60_000;
      cache.set(installationId, { token: body.token, refreshAt: expiresAt - 5 * 60_000 });
      return body.token;
    },
  };
}
