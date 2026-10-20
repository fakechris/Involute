import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { resetAndSeed } from '../prisma/seed-helpers.ts';
import { createDingTalkAuthProvider, DINGTALK_EMAIL_REQUIRED_MESSAGE } from './auth-providers/dingtalk.ts';
import { upsertProviderUser } from './auth-providers/identity.ts';
import { describeAuthProviders, parseAuthProviderIds, resolveAuthProviders } from './auth-providers/registry.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const googleConfiguration = {
  appOrigin: 'http://localhost:4201',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:4201/auth/google/callback',
  scopes: ['openid', 'email', 'profile'],
};

const dingTalkConfiguration = {
  appKey: 'ding-app-key',
  appSecret: 'ding-app-secret',
  redirectUri: 'http://localhost:4201/auth/dingtalk/callback',
  scopes: ['corpid'],
};

describe('auth provider registry (INV-1288)', () => {
  it('defaults to Google alone, so an unchanged deployment behaves as before', () => {
    expect(parseAuthProviderIds(undefined)).toEqual(['google']);
    expect(parseAuthProviderIds('')).toEqual(['google']);
  });

  it('reads an explicit provider list and refuses an unknown one', () => {
    expect(parseAuthProviderIds('dingtalk')).toEqual(['dingtalk']);
    expect(parseAuthProviderIds('dingtalk, google')).toEqual(['dingtalk', 'google']);
    expect(() => parseAuthProviderIds('wechat')).toThrow(/Unknown auth provider/);
  });

  it('offers only the providers that are configured', () => {
    const providers = resolveAuthProviders({
      appOrigin: 'http://localhost:4201',
      dingTalk: { ...dingTalkConfiguration, appKey: null },
      enabledProviderIds: ['google', 'dingtalk'],
      googleOAuth: googleConfiguration,
    });

    expect(describeAuthProviders(providers)).toEqual([
      { id: 'google', label: 'Sign in with Google', startUrl: '/auth/google/start' },
    ]);
  });

  it('gives the private deployment its own sign-in line', () => {
    const providers = resolveAuthProviders({
      appOrigin: 'http://localhost:4201',
      dingTalk: dingTalkConfiguration,
      enabledProviderIds: ['dingtalk'],
      googleOAuth: { ...googleConfiguration, clientId: null },
    });

    expect(describeAuthProviders(providers)).toEqual([
      { id: 'dingtalk', label: '钉钉登录', startUrl: '/auth/dingtalk/start' },
    ]);
  });
});

describe('the DingTalk sign-in line (INV-1288)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the person to DingTalk with the state it was given', () => {
    const provider = createDingTalkAuthProvider(dingTalkConfiguration);
    const url = new URL(provider.buildAuthorizationUrl('state-123'));

    expect(url.origin + url.pathname).toBe('https://login.dingtalk.com/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('ding-app-key');
    expect(url.searchParams.get('redirect_uri')).toBe(dingTalkConfiguration.redirectUri);
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges the code for the person, keyed on unionId', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('userAccessToken')) {
        return new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 });
      }

      return new Response(
        JSON.stringify({
          avatarUrl: 'https://dingtalk.example/avatar.png',
          code: '0',
          email: 'Someone@Example.com',
          nick: '某人',
          unionId: 'union-1',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createDingTalkAuthProvider(dingTalkConfiguration);
    const profile = await provider.completeSignIn('the-code');

    expect(profile).toEqual({
      email: 'someone@example.com',
      name: '某人',
      picture: 'https://dingtalk.example/avatar.png',
      subject: 'union-1',
    });
  });

  it('refuses an account with no email, because the workspace keys people by email', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('userAccessToken')) {
        return new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 });
      }

      return new Response(JSON.stringify({ code: '0', nick: '某人', unionId: 'union-2' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createDingTalkAuthProvider(dingTalkConfiguration);

    await expect(provider.completeSignIn('the-code')).rejects.toThrow(DINGTALK_EMAIL_REQUIRED_MESSAGE);
  });
});

describe('admitting a person from any provider (INV-1288)', () => {
  let admin: User;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
    await prisma.workspaceSettings.upsert({
      where: { id: 'workspace' },
      create: { id: 'workspace', approvedDomains: ['example.com'], defaultTeamIds: [], membersCanCreateTeams: false, membersCanInvite: false },
      update: { approvedDomains: ['example.com'] },
    });
  });

  it('gives a DingTalk sign-in its own identity, and leaves the Google column alone', async () => {
    const user = await upsertProviderUser(
      prisma,
      { email: 'ding@example.com', name: '钉钉用户', picture: null, subject: 'union-9' },
      { id: 'dingtalk', subject: 'union-9' },
      [],
    );

    expect(user.email).toBe('ding@example.com');
    const identity = await prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: 'dingtalk', subject: 'union-9' } },
    });
    expect(identity?.userId).toBe(user.id);
    // The Google column belongs to the Google line; another line must not
    // write into it.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).googleSubject).toBeNull();
  });

  it('keeps the Google link on the column it has always used', async () => {
    const user = await upsertProviderUser(
      prisma,
      { email: 'g@example.com', name: 'Google User', picture: null, subject: 'google-sub-1' },
      { id: 'google', subject: 'google-sub-1' },
      [],
    );

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).googleSubject).toBe('google-sub-1');
    const identity = await prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: 'google', subject: 'google-sub-1' } },
    });
    expect(identity?.userId).toBe(user.id);
  });

  it('claims an invited row on the first sign-in', async () => {
    const invited = await prisma.user.create({
      data: { email: 'invited@example.com', globalRole: 'USER', name: 'invited', invitedAt: new Date() },
    });

    const user = await upsertProviderUser(
      prisma,
      { email: 'invited@example.com', name: 'Invited Person', picture: null, subject: 'union-3' },
      { id: 'dingtalk', subject: 'union-3' },
      [],
    );

    expect(user.id).toBe(invited.id);
    expect(user.name).toBe('Invited Person');
  });

  it('refuses a person outside the approved domains', async () => {
    await expect(
      upsertProviderUser(
        prisma,
        { email: 'stranger@elsewhere.com', name: 'Stranger', picture: null, subject: 'union-4' },
        { id: 'dingtalk', subject: 'union-4' },
        [],
      ),
    ).rejects.toThrow(/invite-only/);
  });

  it('refuses the same address under two identities at one provider', async () => {
    await upsertProviderUser(
      prisma,
      { email: 'twice@example.com', name: 'Twice', picture: null, subject: 'union-a' },
      { id: 'dingtalk', subject: 'union-a' },
      [],
    );

    await expect(
      upsertProviderUser(
        prisma,
        { email: 'twice@example.com', name: 'Twice', picture: null, subject: 'union-b' },
        { id: 'dingtalk', subject: 'union-b' },
        [],
      ),
    ).rejects.toThrow(/conflicts/);
  });
});

describe('one policy, every sign-in line (INV-1288)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.userIdentity.deleteMany();
    await prisma.workspaceSettings.upsert({
      where: { id: 'workspace' },
      create: { id: 'workspace', approvedDomains: ['example.com'], defaultTeamIds: [], membersCanCreateTeams: false, membersCanInvite: false },
      update: { approvedDomains: ['example.com'] },
    });
  });

  const LINES = [
    { id: 'google', subject: 'sub-google-1' },
    { id: 'dingtalk', subject: 'union-dingtalk-1' },
  ] as const;

  it('admits the same person the same way, whichever line vouched for them', async () => {
    const results = [];

    for (const line of LINES) {
      const user = await upsertProviderUser(
        prisma,
        { email: 'ann@example.com', name: 'Ann Li', picture: null, subject: line.subject },
        { id: line.id, subject: line.subject },
        [],
      );

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      results.push({ globalRole: row.globalRole, id: row.id, name: row.name });
    }

    // Same role, same name, and — because they are the same person — the
    // same account. The only thing that differs is where the identity lives.
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.globalRole).toBe('USER');

    const identities = await prisma.userIdentity.findMany({ orderBy: { provider: 'asc' } });
    expect(identities.map((identity) => identity.provider)).toEqual(['dingtalk', 'google']);
  });

  it('refuses the same stranger the same way, whichever line vouched for them', async () => {
    for (const line of LINES) {
      await expect(
        upsertProviderUser(
          prisma,
          { email: 'stranger@elsewhere.com', name: 'Stranger', picture: null, subject: line.subject },
          { id: line.id, subject: line.subject },
          [],
        ),
      ).rejects.toThrow(/invite-only/);
    }

    expect(await prisma.user.count({ where: { email: 'stranger@elsewhere.com' } })).toBe(0);
  });

  it('gives the same role and the same default teams to every line', async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { key: 'INV' } });
    await prisma.workspaceSettings.update({
      where: { id: 'workspace' },
      data: { defaultTeamIds: [team.id] },
    });

    for (const line of LINES) {
      const user = await upsertProviderUser(
        prisma,
        { email: `${line.id}@example.com`, name: 'Person', picture: null, subject: line.subject },
        { id: line.id, subject: line.subject },
        [],
      );

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { memberships: true },
      });

      expect(row.globalRole).toBe('USER');
      expect(row.memberships).toEqual([expect.objectContaining({ role: 'EDITOR', teamId: team.id })]);
    }
  });
});
