import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { buildReadableTeamWhere } from './access-control.ts';
import { setGlobalRole } from './admin-settings.ts';
import type { GraphQLContext } from './auth.ts';
import {
  GLOBAL_ROLE_LAST_ADMIN_MESSAGE,
  GUEST_HAS_TEAM_OWNERSHIP_MESSAGE,
  INVITE_ADMIN_FORBIDDEN_MESSAGE,
  INVITE_FORBIDDEN_MESSAGE,
  USER_SUSPEND_SELF_MESSAGE,
} from './errors.ts';
import { upsertGoogleOAuthUser } from './google-oauth.ts';
import { startServer, type StartedServer } from './index.ts';
import { SESSION_COOKIE_NAME, createSession } from './session.ts';
import {
  SignInRefusedError,
  inviteUser,
  reactivateUser,
  revokeInvite,
  suspendUser,
  updateWorkspaceSettings,
  userAccessStatus,
} from './workspace-access.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

function signIn(email: string, adminEmails: string[] = []) {
  return upsertGoogleOAuthUser(
    prisma,
    { email, emailVerified: true, name: email.split('@')[0]!, picture: null, subject: `google-${email}` },
    { adminEmails } as never,
  );
}

describe('workspace access (INV-847, docs/permissions.md)', () => {
  let admin: User;
  let team: Team;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.workspaceSettings.deleteMany();
    admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  });

  const asAdmin = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, globalRole: 'ADMIN' as const });

  describe('sign-in', () => {
    it('refuses an account nobody invited, and creates no row for it', async () => {
      await expect(signIn('stranger@gmail.com')).rejects.toBeInstanceOf(SignInRefusedError);
      expect(await prisma.user.count({ where: { email: 'stranger@gmail.com' } })).toBe(0);
    });

    it('admits an approved domain as a Member in the default teams', async () => {
      await updateWorkspaceSettings(prisma, { approvedDomains: ['@Example.com'], byActorId: admin.id, defaultTeamIds: [team.id] });
      const joined = await signIn('ann@example.com');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: joined.id }, include: { memberships: true } });
      expect(row.globalRole).toBe('USER');
      expect(row.memberships).toEqual([expect.objectContaining({ role: 'EDITOR', teamId: team.id })]);
    });

    it('lets an invited person in, keeps the invited role and teams, and links their Google account', async () => {
      const invited = await inviteUser(prisma, {
        by: asAdmin(),
        email: 'Guest@Partner.io',
        role: 'GUEST',
        teams: [{ role: 'VIEWER', teamId: team.id }],
      });
      expect(userAccessStatus(invited)).toBe('PENDING');

      const signedIn = await signIn('guest@partner.io');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: signedIn.id }, include: { memberships: true } });
      expect(row.id).toBe(invited.id);
      expect(row.globalRole).toBe('GUEST');
      expect(row.googleSubject).toBe('google-guest@partner.io');
      expect(userAccessStatus(row)).toBe('ACTIVE');
      expect(row.memberships).toEqual([expect.objectContaining({ role: 'VIEWER', teamId: team.id })]);
    });

    it('uses the admin allowlist to bootstrap, not to overrule a demotion', async () => {
      const boss = await signIn('boss@example.org', ['boss@example.org']);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: boss.id } })).globalRole).toBe('ADMIN');

      await setGlobalRole(prisma, { byActorId: admin.id, role: 'USER', userId: boss.id });
      await signIn('boss@example.org', ['boss@example.org']);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: boss.id } })).globalRole).toBe('USER');
    });

    it('refuses a suspended person, and a revoked invite', async () => {
      const member = await inviteUser(prisma, { by: asAdmin(), email: 'm@example.net', role: 'USER' });
      await signIn('m@example.net');
      await suspendUser(prisma, { byActorId: admin.id, userId: member.id });
      await expect(signIn('m@example.net')).rejects.toMatchObject({ reason: 'suspended' });

      const pending = await inviteUser(prisma, { by: asAdmin(), email: 'late@example.net', role: 'USER' });
      await revokeInvite(prisma, { by: asAdmin(), userId: pending.id });
      await expect(signIn('late@example.net')).rejects.toMatchObject({ reason: 'suspended' });

      // Re-inviting brings a revoked invite back.
      await inviteUser(prisma, { by: asAdmin(), email: 'late@example.net', role: 'USER' });
      await expect(signIn('late@example.net')).resolves.toBeTruthy();
    });
  });

  describe('inviting', () => {
    it('is for admins, and for members only when an admin allows it — never to make an admin', async () => {
      const member = await inviteUser(prisma, { by: asAdmin(), email: 'mem@example.com', role: 'USER' });
      const asMember = { actorId: member.id, actorKind: 'HUMAN' as const, globalRole: 'USER' as const };

      await expect(inviteUser(prisma, { by: asMember, email: 'x@example.com', role: 'USER' })).rejects.toThrow(INVITE_FORBIDDEN_MESSAGE);
      await updateWorkspaceSettings(prisma, { byActorId: admin.id, membersCanInvite: true });
      await expect(inviteUser(prisma, { by: asMember, email: 'x@example.com', role: 'USER' })).resolves.toBeTruthy();
      await expect(inviteUser(prisma, { by: asMember, email: 'y@example.com', role: 'ADMIN' })).rejects.toThrow(INVITE_ADMIN_FORBIDDEN_MESSAGE);

      const guest = await inviteUser(prisma, { by: asAdmin(), email: 'g@example.com', role: 'GUEST' });
      await expect(inviteUser(prisma, {
        by: { actorId: guest.id, actorKind: 'HUMAN', globalRole: 'GUEST' },
        email: 'z@example.com',
        role: 'GUEST',
      })).rejects.toThrow(INVITE_FORBIDDEN_MESSAGE);
    });
  });

  describe('suspending and roles', () => {
    it('signs the person out, refuses suspending yourself or the last admin, and reactivates', async () => {
      const member = await inviteUser(prisma, { by: asAdmin(), email: 'sus@example.com', role: 'USER' });
      await signIn('sus@example.com');
      await createSession(prisma, member.id);

      await suspendUser(prisma, { byActorId: admin.id, reason: 'left the company', userId: member.id });
      expect(await prisma.session.count({ where: { userId: member.id } })).toBe(0);
      expect(await prisma.actorAudit.count({ where: { action: 'suspended', subjectId: member.id } })).toBe(1);

      await expect(suspendUser(prisma, { byActorId: admin.id, userId: admin.id })).rejects.toThrow(USER_SUSPEND_SELF_MESSAGE);
      const other = await inviteUser(prisma, { by: asAdmin(), email: 'other-admin@example.com', role: 'USER' });
      await expect(suspendUser(prisma, { byActorId: other.id, userId: admin.id })).rejects.toThrow(GLOBAL_ROLE_LAST_ADMIN_MESSAGE);
      await expect(setGlobalRole(prisma, { byActorId: admin.id, role: 'USER', userId: admin.id })).rejects.toThrow(GLOBAL_ROLE_LAST_ADMIN_MESSAGE);

      await reactivateUser(prisma, { byActorId: admin.id, userId: member.id });
      await expect(signIn('sus@example.com')).resolves.toBeTruthy();
    });

    it('will not make a team owner a guest', async () => {
      const owner = await inviteUser(prisma, { by: asAdmin(), email: 'own@example.com', role: 'USER', teams: [{ role: 'OWNER', teamId: team.id }] });
      await expect(setGlobalRole(prisma, { byActorId: admin.id, role: 'GUEST', userId: owner.id })).rejects.toThrow(GUEST_HAS_TEAM_OWNERSHIP_MESSAGE);
    });
  });

  describe('guests', () => {
    it('do not see public teams they were not added to; members do', async () => {
      await prisma.team.update({ where: { id: team.id }, data: { visibility: 'PUBLIC' } });
      const guest = await inviteUser(prisma, { by: asAdmin(), email: 'gg@example.com', role: 'GUEST' });
      const member = await inviteUser(prisma, { by: asAdmin(), email: 'mm@example.com', role: 'USER' });
      const context = (viewer: User): GraphQLContext => ({ authMode: 'session', isTrustedSystem: false, prisma, viewer });

      expect(await prisma.team.count({ where: buildReadableTeamWhere(context(guest)) })).toBe(0);
      expect(await prisma.team.count({ where: buildReadableTeamWhere(context(member)) })).toBe(1);
    });
  });

  describe('over GraphQL', () => {
    let server: StartedServer | null = null;

    afterEach(async () => {
      await server?.stop();
      server = null;
    });

    async function graphql(user: User, query: string, variables: Record<string, unknown> = {}) {
      server ??= await startServer({ allowAdminFallback: false, authToken: 'unused-test-token', port: 0, prisma });
      const session = await createSession(prisma, user.id);
      const response = await fetch(`${server.url}/graphql`, {
        body: JSON.stringify({ query, variables }),
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
        method: 'POST',
      });
      return response.json() as Promise<{ data: any; errors?: Array<{ message: string }> }>;
    }

    it('tells each viewer what it may do, and keeps the admin surface to admins', async () => {
      const member = await inviteUser(prisma, { by: asAdmin(), email: 'cap@example.com', role: 'USER' });

      const asAdminResult = await graphql(admin, '{ viewerCapabilities { isAdmin canInvite canCreateTeams } workspaceSettings { membersCanInvite } }');
      expect(asAdminResult.data.viewerCapabilities).toEqual({ canCreateTeams: true, canInvite: true, isAdmin: true });

      const asMember = await graphql(member, '{ viewerCapabilities { isAdmin canInvite canCreateTeams } }');
      expect(asMember.data.viewerCapabilities).toEqual({ canCreateTeams: false, canInvite: false, isAdmin: false });

      const denied = await graphql(member, `mutation { userSuspend(id: "${admin.id}") { success message } }`);
      expect(denied.data?.userSuspend ?? null).toBeNull();
      expect(denied.errors?.length).toBeGreaterThan(0);
    });

    it('invites with teams and reports the pending status', async () => {
      const result = await graphql(
        admin,
        'mutation Invite($input: UserInviteInput!) { userInvite(input: $input) { success message user { email accessStatus globalRole teamMemberships { role team { key } } } } }',
        { input: { email: 'new@partner.io', role: 'GUEST', teams: [{ role: 'VIEWER', teamId: team.id }] } },
      );
      expect(result.errors).toBeUndefined();
      expect(result.data.userInvite).toMatchObject({
        success: true,
        user: { accessStatus: 'PENDING', email: 'new@partner.io', globalRole: 'GUEST', teamMemberships: [{ role: 'VIEWER', team: { key: DEFAULT_TEAM_KEY } }] },
      });
    });
  });
});
