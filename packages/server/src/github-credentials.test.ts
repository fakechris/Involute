import { generateKeyPairSync, createVerify } from 'node:crypto';

import type { Team } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { appJwt, createInstallationTokenSource, resolveGitHubToken } from './github-credentials.ts';
import { createIssue } from './issue-service.ts';
import { SECRET_KEY_MISSING_MESSAGE, SECRET_UNREADABLE_MESSAGE, openSecret, sealSecret } from './secret-box.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const env = { INVOLUTE_SECRET_KEY: 'test-key-for-github-credentials' } as NodeJS.ProcessEnv;

describe('secret box (INV-1677)', () => {
  it('round-trips, never stores the plain value, and refuses a wrong or missing key', () => {
    const sealed = sealSecret('ghp_example', env);
    expect(sealed).not.toContain('ghp_example');
    expect(sealSecret('ghp_example', env)).not.toBe(sealed);
    expect(openSecret(sealed, env)).toBe('ghp_example');
    expect(() => openSecret(sealed, { INVOLUTE_SECRET_KEY: 'another' } as NodeJS.ProcessEnv)).toThrow(SECRET_UNREADABLE_MESSAGE);
    expect(() => sealSecret('x', {} as NodeJS.ProcessEnv)).toThrow(SECRET_KEY_MISSING_MESSAGE);
  });
});

describe('GitHub credentials per team (INV-1677)', () => {
  let team: Team;
  let other: Team;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    other = await prisma.team.create({ data: { key: 'OTH', name: 'Other' } });
    await createIssue(prisma, { teamId: team.id, title: 'acme/app', kind: 'PROJECT', repository: 'acme/app' });
    await prisma.issue.updateMany({ where: { repository: 'acme/app' }, data: { commitmentStatus: 'COMMITTED' } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads a repository with its team's pasted token, falls back to GITHUB_TOKEN, and never uses another team's token", async () => {
    expect(await resolveGitHubToken(prisma, 'acme/app', { env: { ...env, GITHUB_TOKEN: 'env-token' } })).toEqual({ token: 'env-token', source: 'env', connectionId: null });
    expect(await resolveGitHubToken(prisma, 'acme/app', { env })).toBeNull();

    // Another team's token for the same owner is not used.
    await prisma.gitHubConnection.create({ data: { teamId: other.id, kind: 'TOKEN', accountLogin: 'acme', tokenEncrypted: sealSecret('other-team', env) } });
    expect(await resolveGitHubToken(prisma, 'acme/app', { env })).toBeNull();

    const mine = await prisma.gitHubConnection.create({ data: { teamId: team.id, kind: 'TOKEN', accountLogin: 'ACME', tokenEncrypted: sealSecret('team-token', env) } });
    expect(await resolveGitHubToken(prisma, 'acme/app', { env: { ...env, GITHUB_TOKEN: 'env-token' } })).toEqual({ token: 'team-token', source: 'team-token', connectionId: mine.id });

    await prisma.gitHubConnection.update({ where: { id: mine.id }, data: { status: 'DISCONNECTED' } });
    expect((await resolveGitHubToken(prisma, 'acme/app', { env: { ...env, GITHUB_TOKEN: 'env-token' } }))?.source).toBe('env');
  });

  it('prefers the App installation when the instance App can mint tokens', async () => {
    const install = await prisma.gitHubConnection.create({ data: { teamId: team.id, kind: 'APP_INSTALLATION', accountLogin: 'acme', installationId: '42' } });
    const app = { tokenFor: async (id: string) => `installation-${id}` };
    expect(await resolveGitHubToken(prisma, 'acme/app', { env, app })).toEqual({ token: 'installation-42', source: 'app', connectionId: install.id });
    // An installation GitHub no longer mints for is marked for its Owners, and the read falls back.
    const failing = { tokenFor: async () => { throw new Error('GitHub refused an installation token for installation 42: HTTP 404'); } };
    expect((await resolveGitHubToken(prisma, 'acme/app', { env: { ...env, GITHUB_TOKEN: 'env-token' }, app: failing }))?.source).toBe('env');
    expect(await prisma.gitHubConnection.findUniqueOrThrow({ where: { id: install.id } })).toMatchObject({ status: 'DISCONNECTED', lastError: expect.stringContaining('HTTP 404') });
    await prisma.gitHubConnection.update({ where: { id: install.id }, data: { status: 'ACTIVE', lastError: null } });
    // Before the instance App exists nothing can mint for the installation; GITHUB_TOKEN still applies.
    expect((await resolveGitHubToken(prisma, 'acme/app', { env: { ...env, GITHUB_TOKEN: 'env-token' }, app: null }))?.source).toBe('env');
  });
});

describe('installation tokens (INV-1677)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

  it('signs the App JWT with the private key', () => {
    const jwt = appJwt('123', pem, 1_000_000);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: '123' });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${payload}`);
    expect(verify.verify(publicKey, signature!, 'base64url')).toBe(true);
  });

  it('caches a token until five minutes before it expires', async () => {
    let clock = Date.parse('2026-11-06T12:00:00Z');
    const calls: string[] = [];
    const source = createInstallationTokenSource({
      appId: '123',
      privateKeyPem: pem,
      now: () => clock,
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 201, json: async () => ({ token: `t${calls.length}`, expires_at: new Date(clock + 60 * 60_000).toISOString() }), text: async () => '' };
      },
    });
    expect(await source.tokenFor('42')).toBe('t1');
    clock += 50 * 60_000;
    expect(await source.tokenFor('42')).toBe('t1');
    clock += 6 * 60_000;
    expect(await source.tokenFor('42')).toBe('t2');
    expect(calls[0]).toBe('https://api.github.com/app/installations/42/access_tokens');
  });

  it('says which installation GitHub refused', async () => {
    const source = createInstallationTokenSource({ appId: '1', privateKeyPem: pem, fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' }) });
    await expect(source.tokenFor('9')).rejects.toThrow(/installation 9: HTTP 404/);
  });
});

describe('sync client reads each repository with its own credential (INV-1677)', () => {
  it('asks the resolver per repository', async () => {
    const { DefaultGitHubApiClient } = await import('./github-sync.ts');
    const seen: Array<string | undefined> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const client = new DefaultGitHubApiClient(async (repository) => (repository === 'acme/app' ? 'tok-acme' : undefined));
      await client.fetchPullRequestsSince('acme/app', new Date(0));
      await client.fetchPullRequestsSince('other/repo', new Date(0));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual(['Bearer tok-acme', undefined]);
  });
});
