import type { GitHubConnection, Prisma, PrismaClient } from '@prisma/client';

import { loadInstanceApp, signGitHubState, verifyGitHubState } from './github-app.js';
import { appJwt, type InstallationTokenSource } from './github-credentials.js';
import { openSecret, sealSecret } from './secret-box.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * A team's connections to GitHub (INV-1677). A team Owner (or an Admin)
 * installs the deployment App on an account or organisation from Settings →
 * GitHub; Involute signs a state naming the team, GitHub passes it back on the
 * setup URL, and the installation is bound to that team alone. Teams that may
 * not install Apps paste a read-only token for an owner instead.
 */

export const NO_APP_MESSAGE = 'This deployment has no GitHub App yet. A workspace Admin creates it first (Settings → GitHub, step 1).';
export const INSTALL_TAKEN_MESSAGE = 'That GitHub installation is already connected to another team. One installation belongs to one team; install the App again for this team, or ask the other team to remove it.';
export const INSTALL_WITHOUT_STATE_MESSAGE = 'GitHub installed the App, but Involute does not know which team it is for. Start from Settings → GitHub → Install on GitHub so the installation is bound to your team.';
export const TOKEN_REFUSED_MESSAGE = 'GitHub did not accept that token. Paste a fine-grained token with read access to pull requests, contents and metadata.';
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

type FetchLike = (url: string, init: { method?: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export async function startInstall(prisma: DatabaseClient, input: { teamId: string; userId: string }, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const app = await loadInstanceApp(prisma);
  if (!app) throw new Error(NO_APP_MESSAGE);
  const state = signGitHubState({ purpose: 'install', userId: input.userId, teamId: input.teamId }, Date.now(), env);
  return `https://github.com/apps/${app.slug}/installations/new?state=${encodeURIComponent(state)}`;
}

/** GitHub's setup-URL redirect: bind the installation to the team the signed state names. */
export async function completeInstall(
  prisma: DatabaseClient,
  input: { installationId: string; state: string | null; userId: string; canManageTeam: (teamId: string) => Promise<boolean> },
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<GitHubConnection> {
  const env = options.env ?? process.env;
  if (!input.state) throw new Error(INSTALL_WITHOUT_STATE_MESSAGE);
  const { teamId } = verifyGitHubState(input.state, { purpose: 'install', userId: input.userId }, Date.now(), env);
  if (!teamId || !(await input.canManageTeam(teamId))) throw new Error('Only an Owner of the team (or a workspace Admin) connects it to GitHub.');
  if (!/^\d+$/.test(input.installationId)) throw new Error('GitHub returned an unexpected installation id.');
  const app = await loadInstanceApp(prisma);
  if (!app) throw new Error(NO_APP_MESSAGE);
  const response = await (options.fetch ?? defaultFetch)(`https://api.github.com/app/installations/${input.installationId}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${appJwt(app.appId, openSecret(app.privateKeyEncrypted, env))}`, 'User-Agent': 'Involute' },
  });
  if (!response.ok) throw new Error(`GitHub does not list installation ${input.installationId} for this App (HTTP ${response.status}).`);
  const installation = (await response.json()) as { account?: { login?: string; type?: string }; repository_selection?: string };
  const accountLogin = installation.account?.login;
  if (!accountLogin) throw new Error('GitHub returned the installation without its account.');
  const taken = await prisma.gitHubConnection.findUnique({ where: { installationId: input.installationId } });
  if (taken && taken.teamId !== teamId) throw new Error(INSTALL_TAKEN_MESSAGE);
  const data = {
    kind: 'APP_INSTALLATION',
    installationId: input.installationId,
    accountType: installation.account?.type ?? null,
    repositorySelection: installation.repository_selection ?? null,
    tokenEncrypted: null,
    tokenExpiresAt: null,
    status: 'ACTIVE',
    lastError: null,
    lastCheckedAt: new Date(),
  };
  return prisma.gitHubConnection.upsert({
    where: { teamId_provider_accountLogin: { teamId, provider: 'github', accountLogin } },
    create: { teamId, accountLogin, createdById: input.userId, ...data },
    update: data,
  });
}

/** A read-only token a team pastes for one owner, checked with GitHub before it is sealed. */
export async function connectToken(
  prisma: DatabaseClient,
  input: { teamId: string; accountLogin: string; token: string; userId: string },
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<GitHubConnection> {
  const env = options.env ?? process.env;
  const accountLogin = input.accountLogin.trim();
  const token = input.token.trim();
  if (!LOGIN_PATTERN.test(accountLogin)) throw new Error('The account is not a GitHub login (the owner part of owner/name).');
  if (!token) throw new Error(TOKEN_REFUSED_MESSAGE);
  const response = await (options.fetch ?? defaultFetch)(`https://api.github.com/users/${accountLogin}/repos?per_page=1`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'Involute' },
  });
  if (!response.ok) throw new Error(`${TOKEN_REFUSED_MESSAGE} (HTTP ${response.status})`);
  const existing = await prisma.gitHubConnection.findUnique({ where: { teamId_provider_accountLogin: { teamId: input.teamId, provider: 'github', accountLogin } } });
  if (existing?.kind === 'APP_INSTALLATION' && existing.status === 'ACTIVE') {
    throw new Error(`The team already reads ${accountLogin} through the GitHub App; a token is not needed.`);
  }
  const data = { kind: 'TOKEN', installationId: null, tokenEncrypted: sealSecret(token, env), status: 'ACTIVE', lastError: null, lastCheckedAt: new Date() };
  return prisma.gitHubConnection.upsert({
    where: { teamId_provider_accountLogin: { teamId: input.teamId, provider: 'github', accountLogin } },
    create: { teamId: input.teamId, accountLogin, createdById: input.userId, ...data },
    update: data,
  });
}

/** Whether an App delivery may act on a repository routed to `teamKey`: its installation must be that team's. */
export async function installationMayRoute(prisma: DatabaseClient, installationId: number | string | null | undefined, teamKey: string): Promise<boolean> {
  if (installationId === null || installationId === undefined) return true; // a repository hook or the sync engine
  const connection = await prisma.gitHubConnection.findUnique({ where: { installationId: String(installationId) }, include: { team: { select: { key: true } } } });
  return Boolean(connection && connection.status === 'ACTIVE' && connection.team.key === teamKey);
}

export interface ConnectionRepository {
  fullName: string;
  private: boolean;
}

/** The repositories a connection can read, as GitHub lists them (up to 300). */
export async function listConnectionRepositories(
  connection: GitHubConnection,
  options: { app: InstallationTokenSource | null; fetch?: FetchLike; env?: NodeJS.ProcessEnv },
): Promise<ConnectionRepository[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? defaultFetch;
  const installation = connection.kind === 'APP_INSTALLATION';
  if (installation && !options.app) throw new Error(NO_APP_MESSAGE);
  const token = installation ? await options.app!.tokenFor(connection.installationId!) : openSecret(connection.tokenEncrypted ?? '', env);
  const repositories: ConnectionRepository[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const url = installation
      ? `https://api.github.com/installation/repositories?per_page=100&page=${page}`
      : `https://api.github.com/users/${connection.accountLogin}/repos?per_page=100&page=${page}&type=all`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'Involute' } });
    if (!response.ok) throw new Error(`GitHub refused to list ${connection.accountLogin}'s repositories (HTTP ${response.status}).`);
    const body = (await response.json()) as { repositories?: Array<{ full_name: string; private: boolean }> } | Array<{ full_name: string; private: boolean }>;
    const batch = Array.isArray(body) ? body : body.repositories ?? [];
    repositories.push(...batch.map((repo) => ({ fullName: repo.full_name, private: repo.private })));
    if (batch.length < 100) break;
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

const INSTALLATION_STATUS: Record<string, { status: 'ACTIVE' | 'DISCONNECTED'; lastError: string | null }> = {
  deleted: { status: 'DISCONNECTED', lastError: 'The GitHub App was uninstalled from this account.' },
  suspend: { status: 'DISCONNECTED', lastError: 'The GitHub App installation was suspended.' },
  unsuspend: { status: 'ACTIVE', lastError: null },
};

/** GitHub's `installation` delivery: an uninstall or suspension disconnects the team; unsuspend restores it. */
export async function applyInstallationEvent(prisma: DatabaseClient, payload: unknown): Promise<void> {
  const body = (payload ?? {}) as { action?: unknown; installation?: { id?: unknown } };
  const change = typeof body.action === 'string' ? INSTALLATION_STATUS[body.action] : undefined;
  const id = body.installation?.id;
  if (!change || (typeof id !== 'number' && typeof id !== 'string')) return;
  await prisma.gitHubConnection.updateMany({ where: { installationId: String(id) }, data: { ...change, lastCheckedAt: new Date() } });
}

/** GitHub refused the credential a repository was read with: mark that connection so its Owners are told (INV-1677). */
export async function markConnectionBroken(prisma: DatabaseClient, connectionId: string, message: string): Promise<void> {
  await prisma.gitHubConnection.updateMany({ where: { id: connectionId, status: 'ACTIVE' }, data: { status: 'DISCONNECTED', lastError: message.slice(0, 300), lastCheckedAt: new Date() } });
}
