import { generateKeyPairSync } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  APP_ADMIN_ONLY_MESSAGE,
  APP_EXISTS_MESSAGE,
  STATE_INVALID_MESSAGE,
  buildAppManifest,
  completeAppManifest,
  githubWebhookSecret,
  loadInstanceApp,
  signGitHubState,
  startAppManifest,
  verifyGitHubState,
} from './github-app.ts';
import { openSecret, SECRET_KEY_MISSING_MESSAGE } from './secret-box.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const env = { INVOLUTE_SECRET_KEY: 'test-key-for-github-app' } as NodeJS.ProcessEnv;
const origin = 'https://involute.example.com';
const admin = { id: '00000000-0000-4000-8000-000000000001', globalRole: 'ADMIN', actorKind: 'HUMAN' };
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const conversion = (body: Record<string, unknown>) => async () => ({ ok: true, status: 201, json: async () => body, text: async () => '' });

describe('the deployment GitHub App (INV-1677)', () => {
  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.gitHubApp.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('prefills a read-only manifest that points GitHub back at this deployment', () => {
    const manifest = buildAppManifest(`${origin}/`, 'Involute example');
    expect(manifest.hook_attributes.url).toBe(`${origin}/api/webhooks/github`);
    expect(manifest.redirect_url).toBe(`${origin}/auth/github-app/created`);
    expect(manifest.setup_url).toBe(`${origin}/auth/github-app/installed`);
    expect(Object.values(manifest.default_permissions).every((level) => level === 'read')).toBe(true);
    expect(manifest.default_events).toEqual(['pull_request', 'create']);
  });

  it('lets only a human Admin with a secret key start, once', async () => {
    await expect(startAppManifest(prisma, { ...admin, globalRole: 'USER' }, { appOrigin: origin }, env)).rejects.toThrow(APP_ADMIN_ONLY_MESSAGE);
    await expect(startAppManifest(prisma, { ...admin, actorKind: 'AGENT' }, { appOrigin: origin }, env)).rejects.toThrow(APP_ADMIN_ONLY_MESSAGE);
    await expect(startAppManifest(prisma, admin, { appOrigin: origin }, {} as NodeJS.ProcessEnv)).rejects.toThrow(SECRET_KEY_MISSING_MESSAGE);
    const personal = await startAppManifest(prisma, admin, { appOrigin: origin }, env);
    expect(personal.postUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    const org = await startAppManifest(prisma, admin, { appOrigin: origin, owner: 'acme-org' }, env);
    expect(org.postUrl).toMatch(/^https:\/\/github\.com\/organizations\/acme-org\/settings\/apps\/new\?state=/);
    await expect(startAppManifest(prisma, admin, { appOrigin: origin, owner: 'bad/owner' }, env)).rejects.toThrow(/not a GitHub login/);
  });

  it('accepts only its own unexpired state, for the person who started it', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const state = signGitHubState({ purpose: 'app', userId: admin.id }, now, env);
    expect(verifyGitHubState(state, { purpose: 'app', userId: admin.id }, now + 1000, env)).toEqual({ teamId: null });
    expect(() => verifyGitHubState(state, { purpose: 'app', userId: 'someone-else' }, now, env)).toThrow(STATE_INVALID_MESSAGE);
    expect(() => verifyGitHubState(state, { purpose: 'install', userId: admin.id }, now, env)).toThrow(STATE_INVALID_MESSAGE);
    expect(() => verifyGitHubState(state, { purpose: 'app', userId: admin.id }, now + 2 * 60 * 60_000, env)).toThrow(STATE_INVALID_MESSAGE);
    expect(() => verifyGitHubState(`${state.split('.')[0]}.forged`, { purpose: 'app', userId: admin.id }, now, env)).toThrow(STATE_INVALID_MESSAGE);
  });

  it('exchanges the code, seals the credentials, and serves the webhook secret from them', async () => {
    const { postUrl } = await startAppManifest(prisma, admin, { appOrigin: origin }, env);
    const state = new URL(postUrl).searchParams.get('state')!;
    const urls: string[] = [];
    const app = await completeAppManifest(
      prisma,
      { code: 'abc123', state, viewer: admin },
      {
        env,
        fetch: async (url) => {
          urls.push(url);
          return conversion({ id: 77, slug: 'involute-example', name: 'Involute example', html_url: 'https://github.com/apps/involute-example', owner: { login: 'fakechris' }, client_id: 'Iv1', client_secret: 'cs', webhook_secret: 'whs', pem })();
        },
      },
    );
    expect(urls).toEqual(['https://api.github.com/app-manifests/abc123/conversions']);
    expect(app.appId).toBe('77');
    expect(app.privateKeyEncrypted).not.toContain('PRIVATE KEY');
    expect(openSecret(app.privateKeyEncrypted, env)).toBe(pem);
    expect(await githubWebhookSecret(prisma, env)).toBe('whs');
    expect(await githubWebhookSecret(prisma, { ...env, GITHUB_WEBHOOK_SECRET: 'from-env' })).toBe('from-env');
    expect((await loadInstanceApp(prisma))?.slug).toBe('involute-example');

    await expect(startAppManifest(prisma, admin, { appOrigin: origin }, env)).rejects.toThrow(APP_EXISTS_MESSAGE);
    await expect(completeAppManifest(prisma, { code: 'again', state, viewer: admin }, { env, fetch: conversion({}) })).rejects.toThrow(APP_EXISTS_MESSAGE);
  });

  it('refuses a callback whose state is not the viewer’s', async () => {
    const state = signGitHubState({ purpose: 'app', userId: 'another-admin' }, Date.now(), env);
    await expect(completeAppManifest(prisma, { code: 'abc', state, viewer: admin }, { env, fetch: conversion({}) })).rejects.toThrow(STATE_INVALID_MESSAGE);
    expect(await loadInstanceApp(prisma)).toBeNull();
  });
});
