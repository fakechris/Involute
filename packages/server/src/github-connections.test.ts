import { generateKeyPairSync } from 'node:crypto';

import type { Team } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { signGitHubState, STATE_INVALID_MESSAGE } from './github-app.ts';
import {
  INSTALL_TAKEN_MESSAGE,
  INSTALL_WITHOUT_STATE_MESSAGE,
  NO_APP_MESSAGE,
  TOKEN_REFUSED_MESSAGE,
  applyInstallationEvent,
  completeInstall,
  connectToken,
  installationMayRoute,
  listConnectionRepositories,
  startInstall,
} from './github-connections.ts';
import { openSecret, sealSecret } from './secret-box.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const env = { INVOLUTE_SECRET_KEY: 'test-key-for-connections' } as NodeJS.ProcessEnv;
const user = '00000000-0000-4000-8000-000000000002';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const refused = (status: number) => async () => ({ ok: false, status, json: async () => ({}), text: async () => 'no' });

describe('team GitHub connections (INV-1677)', () => {
  let team: Team;
  let other: Team;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.gitHubApp.deleteMany();
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    other = await prisma.team.create({ data: { key: 'OTH', name: 'Other' } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const withApp = () =>
    prisma.gitHubApp.create({
      data: { appId: '77', slug: 'involute-x', name: 'Involute x', htmlUrl: 'https://github.com/apps/involute-x', ownerLogin: 'fakechris', privateKeyEncrypted: sealSecret(pem, env), webhookSecretEncrypted: sealSecret('whs', env) },
    });

  it('installs only after the App exists, with a state naming the team', async () => {
    await expect(startInstall(prisma, { teamId: team.id, userId: user }, env)).rejects.toThrow(NO_APP_MESSAGE);
    await withApp();
    const url = new URL(await startInstall(prisma, { teamId: team.id, userId: user }, env));
    expect(url.origin + url.pathname).toBe('https://github.com/apps/involute-x/installations/new');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('binds an installation to the team in the state, once, and refuses the rest', async () => {
    await withApp();
    const state = signGitHubState({ purpose: 'install', userId: user, teamId: team.id }, Date.now(), env);
    const installation = ok({ account: { login: 'acme', type: 'Organization' }, repository_selection: 'all' });
    const canManage = async () => true;

    await expect(completeInstall(prisma, { installationId: '42', state: null, userId: user, canManageTeam: canManage }, { env, fetch: installation })).rejects.toThrow(INSTALL_WITHOUT_STATE_MESSAGE);
    await expect(completeInstall(prisma, { installationId: '42', state, userId: 'someone-else', canManageTeam: canManage }, { env, fetch: installation })).rejects.toThrow(STATE_INVALID_MESSAGE);
    await expect(completeInstall(prisma, { installationId: '42', state, userId: user, canManageTeam: async () => false }, { env, fetch: installation })).rejects.toThrow(/Only an Owner/);

    const connection = await completeInstall(prisma, { installationId: '42', state, userId: user, canManageTeam: canManage }, { env, fetch: installation });
    expect(connection).toMatchObject({ teamId: team.id, kind: 'APP_INSTALLATION', installationId: '42', accountLogin: 'acme', accountType: 'Organization', status: 'ACTIVE' });

    const otherState = signGitHubState({ purpose: 'install', userId: user, teamId: other.id }, Date.now(), env);
    await expect(completeInstall(prisma, { installationId: '42', state: otherState, userId: user, canManageTeam: canManage }, { env, fetch: installation })).rejects.toThrow(INSTALL_TAKEN_MESSAGE);

    expect(await installationMayRoute(prisma, 42, DEFAULT_TEAM_KEY)).toBe(true);
    expect(await installationMayRoute(prisma, 42, 'OTH')).toBe(false);
    expect(await installationMayRoute(prisma, 99, DEFAULT_TEAM_KEY)).toBe(false);
    expect(await installationMayRoute(prisma, undefined, 'OTH')).toBe(true);
  });

  it('an uninstall or suspension from GitHub disconnects the team; unsuspend restores it', async () => {
    await prisma.gitHubConnection.create({ data: { teamId: team.id, kind: 'APP_INSTALLATION', accountLogin: 'acme', installationId: '42' } });
    await applyInstallationEvent(prisma, { action: 'suspend', installation: { id: 42 } });
    expect(await prisma.gitHubConnection.findUniqueOrThrow({ where: { installationId: '42' } })).toMatchObject({ status: 'DISCONNECTED', lastError: 'The GitHub App installation was suspended.' });
    await applyInstallationEvent(prisma, { action: 'unsuspend', installation: { id: 42 } });
    expect((await prisma.gitHubConnection.findUniqueOrThrow({ where: { installationId: '42' } })).status).toBe('ACTIVE');
    await applyInstallationEvent(prisma, { action: 'deleted', installation: { id: 42 } });
    expect((await prisma.gitHubConnection.findUniqueOrThrow({ where: { installationId: '42' } })).lastError).toMatch(/uninstalled/);
    await applyInstallationEvent(prisma, { action: 'created', installation: { id: 42 } });
    expect((await prisma.gitHubConnection.findUniqueOrThrow({ where: { installationId: '42' } })).status).toBe('DISCONNECTED');
  });

  it('checks a pasted token with GitHub before sealing it', async () => {
    await expect(connectToken(prisma, { teamId: team.id, accountLogin: 'acme', token: 'bad', userId: user }, { env, fetch: refused(401) })).rejects.toThrow(TOKEN_REFUSED_MESSAGE);
    await expect(connectToken(prisma, { teamId: team.id, accountLogin: 'not/login', token: 't', userId: user }, { env, fetch: ok([]) })).rejects.toThrow(/not a GitHub login/);
    const connection = await connectToken(prisma, { teamId: team.id, accountLogin: 'acme', token: ' github_pat_x ', userId: user }, { env, fetch: ok([]) });
    expect(connection.kind).toBe('TOKEN');
    expect(connection.tokenEncrypted).not.toContain('github_pat_x');
    expect(openSecret(connection.tokenEncrypted!, env)).toBe('github_pat_x');
  });

  it('lists what a connection can read', async () => {
    const connection = await prisma.gitHubConnection.create({ data: { teamId: team.id, kind: 'APP_INSTALLATION', accountLogin: 'acme', installationId: '42' } });
    const seen: string[] = [];
    const repositories = await listConnectionRepositories(connection, {
      env,
      app: { tokenFor: async () => 'inst-token' },
      fetch: async (url, init) => {
        seen.push(`${url} ${init.headers.Authorization}`);
        return { ok: true, status: 200, json: async () => ({ repositories: [{ full_name: 'acme/b', private: true }, { full_name: 'acme/a', private: false }] }), text: async () => '' };
      },
    });
    expect(repositories).toEqual([{ fullName: 'acme/a', private: false }, { fullName: 'acme/b', private: true }]);
    expect(seen).toEqual(['https://api.github.com/installation/repositories?per_page=100&page=1 Bearer inst-token']);
    await expect(listConnectionRepositories(connection, { env, app: null })).rejects.toThrow(NO_APP_MESSAGE);
  });
});
