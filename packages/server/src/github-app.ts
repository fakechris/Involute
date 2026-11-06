import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { GitHubApp, Prisma, PrismaClient } from '@prisma/client';

import { createInstallationTokenSource, type InstallationTokenSource } from './github-credentials.js';
import { hasSecretKey, openSecret, sealSecret, SECRET_KEY_MISSING_MESSAGE } from './secret-box.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * The deployment's GitHub App (INV-1677). A workspace Admin creates it once
 * from Settings → GitHub through GitHub's manifest flow: Involute posts a
 * prefilled manifest, the Admin clicks Create on GitHub, GitHub redirects back
 * with a code that Involute exchanges for the App id, private key and webhook
 * secret. Nothing is copied by hand and nothing lands in an env file. Teams
 * then install the App on their own accounts (GitHubConnection, stage 3).
 *
 * The App is public so teams outside the creating account can install it; an
 * installation does nothing until a team Owner binds it with a signed state.
 */

export const GITHUB_APP_PERMISSIONS = { pull_requests: 'read', contents: 'read', metadata: 'read', checks: 'read', actions: 'read' } as const;
export const GITHUB_APP_EVENTS = ['pull_request', 'create'] as const;

export const APP_ADMIN_ONLY_MESSAGE = 'Only a workspace Admin creates the GitHub App for this deployment (Settings → GitHub).';
export const APP_EXISTS_MESSAGE = 'This deployment already has a GitHub App. Teams install it from Settings → GitHub.';
export const STATE_INVALID_MESSAGE = 'The GitHub hand-off is not valid for you or has expired (it lasts one hour). Start again from Settings → GitHub.';
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const STATE_TTL_MS = 60 * 60_000;

type StatePurpose = 'app' | 'install';

function stateKey(env: NodeJS.ProcessEnv): Buffer {
  if (!hasSecretKey(env)) throw new Error(SECRET_KEY_MISSING_MESSAGE);
  return createHash('sha256').update(`github-state:${env.INVOLUTE_SECRET_KEY!.trim()}`).digest();
}

/** A signed, expiring hand-off for a round trip through GitHub; it names who started it and why. */
export function signGitHubState(payload: { purpose: StatePurpose; userId: string; teamId?: string }, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const body = Buffer.from(JSON.stringify({ p: payload.purpose, u: payload.userId, t: payload.teamId ?? null, e: now + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey(env)).update(body).digest('base64url')}`;
}

export function verifyGitHubState(state: string | null | undefined, expected: { purpose: StatePurpose; userId: string }, now = Date.now(), env: NodeJS.ProcessEnv = process.env): { teamId: string | null } {
  const [body, signature] = (state ?? '').split('.');
  if (!body || !signature) throw new Error(STATE_INVALID_MESSAGE);
  const wanted = createHmac('sha256', stateKey(env)).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new Error(STATE_INVALID_MESSAGE);
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p?: string; u?: string; t?: string | null; e?: number };
  if (parsed.p !== expected.purpose || parsed.u !== expected.userId || typeof parsed.e !== 'number' || parsed.e < now) throw new Error(STATE_INVALID_MESSAGE);
  return { teamId: parsed.t ?? null };
}

export function githubWebhookUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/$/, '')}/api/webhooks/github`;
}

export function buildAppManifest(appOrigin: string, name: string) {
  const origin = appOrigin.replace(/\/$/, '');
  return {
    name,
    url: origin,
    hook_attributes: { url: githubWebhookUrl(origin), active: true },
    redirect_url: `${origin}/auth/github-app/created`,
    setup_url: `${origin}/auth/github-app/installed`,
    setup_on_update: true,
    public: true,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: [...GITHUB_APP_EVENTS],
  };
}

/** GitHub limits App names to 34 characters and wants them unique; the host keeps two deployments apart. */
export function defaultAppName(appOrigin: string): string {
  let host = 'involute';
  try {
    host = new URL(appOrigin).hostname;
  } catch {
    /* keep the default */
  }
  return `Involute ${host}`.slice(0, 34).trim();
}

export async function loadInstanceApp(prisma: DatabaseClient): Promise<GitHubApp | null> {
  return prisma.gitHubApp.findUnique({ where: { provider: 'github' } });
}

export interface ManifestStart {
  postUrl: string;
  manifest: string;
  state: string;
}

export async function startAppManifest(
  prisma: DatabaseClient,
  viewer: { id: string; globalRole: string; actorKind?: string | null },
  input: { appOrigin: string; owner?: string | null; name?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManifestStart> {
  if (viewer.globalRole !== 'ADMIN' || viewer.actorKind === 'AGENT') throw new Error(APP_ADMIN_ONLY_MESSAGE);
  if (!hasSecretKey(env)) throw new Error(SECRET_KEY_MISSING_MESSAGE);
  if (await loadInstanceApp(prisma)) throw new Error(APP_EXISTS_MESSAGE);
  const owner = input.owner?.trim() || null;
  if (owner && !OWNER_PATTERN.test(owner)) throw new Error('The organisation name is not a GitHub login. Leave it empty to create the App on your own account.');
  const name = (input.name?.trim() || defaultAppName(input.appOrigin)).slice(0, 34);
  const state = signGitHubState({ purpose: 'app', userId: viewer.id }, Date.now(), env);
  const base = owner ? `https://github.com/organizations/${owner}/settings/apps/new` : 'https://github.com/settings/apps/new';
  return { postUrl: `${base}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(buildAppManifest(input.appOrigin, name)), state };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** GitHub's redirect after Create: exchange the code for the App's credentials and seal them. */
export async function completeAppManifest(
  prisma: DatabaseClient,
  input: { code: string; state: string; viewer: { id: string; globalRole: string } },
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<GitHubApp> {
  const env = options.env ?? process.env;
  if (input.viewer.globalRole !== 'ADMIN') throw new Error(APP_ADMIN_ONLY_MESSAGE);
  verifyGitHubState(input.state, { purpose: 'app', userId: input.viewer.id }, Date.now(), env);
  if (await loadInstanceApp(prisma)) throw new Error(APP_EXISTS_MESSAGE);
  if (!/^[A-Za-z0-9_-]+$/.test(input.code)) throw new Error('GitHub returned an unexpected code. Start again from Settings → GitHub.');
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const response = await fetchImpl(`https://api.github.com/app-manifests/${input.code}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Involute' },
  });
  if (!response.ok) throw new Error(`GitHub did not hand over the new App (HTTP ${response.status}). The code lasts one hour and works once; start again from Settings → GitHub.`);
  const app = (await response.json()) as {
    id?: number; slug?: string; name?: string; html_url?: string; owner?: { login?: string };
    client_id?: string; client_secret?: string; webhook_secret?: string; pem?: string;
  };
  if (!app.id || !app.slug || !app.pem || !app.webhook_secret) throw new Error('GitHub returned the App without its key or webhook secret. Delete it on GitHub and start again.');
  return prisma.gitHubApp.create({
    data: {
      appId: String(app.id),
      slug: app.slug,
      name: app.name ?? app.slug,
      htmlUrl: app.html_url ?? `https://github.com/apps/${app.slug}`,
      ownerLogin: app.owner?.login ?? '',
      clientId: app.client_id ?? null,
      clientSecretEncrypted: app.client_secret ? sealSecret(app.client_secret, env) : null,
      privateKeyEncrypted: sealSecret(app.pem, env),
      webhookSecretEncrypted: sealSecret(app.webhook_secret, env),
      createdById: input.viewer.id,
    },
  });
}

/** The secret GitHub signs deliveries with: GITHUB_WEBHOOK_SECRET when an operator set one, else the App's. */
export async function githubWebhookSecret(prisma: DatabaseClient, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const app = await loadInstanceApp(prisma);
  return app && hasSecretKey(env) ? openSecret(app.webhookSecretEncrypted, env) : null;
}

const configuredListeners = new Set<() => void>();

/** The server starts its GitHub workers when told GitHub was just configured (INV-1677). */
export function onGitHubConfigured(listener: () => void): () => void {
  configuredListeners.add(listener);
  return () => configuredListeners.delete(listener);
}

export function githubConfigured(): void {
  for (const listener of configuredListeners) listener();
}

let cachedSource: { key: string; source: InstallationTokenSource } | null = null;

/** Installation tokens from the instance App, or null before it exists. One source per App version keeps the token cache. */
export async function instanceAppTokenSource(prisma: DatabaseClient, env: NodeJS.ProcessEnv = process.env): Promise<InstallationTokenSource | null> {
  const app = await loadInstanceApp(prisma);
  if (!app || !hasSecretKey(env)) return null;
  const key = `${app.id}:${app.updatedAt.getTime()}`;
  if (cachedSource?.key !== key) {
    cachedSource = { key, source: createInstallationTokenSource({ appId: app.appId, privateKeyPem: openSecret(app.privateKeyEncrypted, env) }) };
  }
  return cachedSource.source;
}
