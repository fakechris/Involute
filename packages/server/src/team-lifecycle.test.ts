import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { assertCanWriteTeam } from './access-control.ts';
import type { GraphQLContext } from './auth.ts';
import {
  TEAM_ARCHIVED_MESSAGE,
  TEAM_CREATE_FORBIDDEN_MESSAGE,
  TEAM_JOIN_FORBIDDEN_MESSAGE,
  TEAM_KEY_TAKEN_MESSAGE,
  TEAM_LAST_OWNER_LEAVE_MESSAGE,
} from './errors.ts';
import { startServer, type StartedServer } from './index.ts';
import { SESSION_COOKIE_NAME, createSession } from './session.ts';
import { createTeam, joinTeam, leaveTeam, setTeamArchived } from './team-lifecycle.ts';
import { inviteUser, updateWorkspaceSettings } from './workspace-access.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('team lifecycle (INV-848, docs/permissions.md §3 and §5)', () => {
  let admin: User;
  let member: User;
  let guest: User;
  let inv: Team;

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
    const by = { actorId: admin.id, actorKind: 'HUMAN' as const, globalRole: 'ADMIN' as const };
    member = await inviteUser(prisma, { by, email: 'member@example.com', role: 'USER' });
    guest = await inviteUser(prisma, { by, email: 'guest@example.com', role: 'GUEST' });
    inv = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  });

  const context = (viewer: User): GraphQLContext => ({ authMode: 'session', isTrustedSystem: false, prisma, viewer });

  it('creates a team with its creator as Owner and the default workflow', async () => {
    const team = await createTeam(prisma, { creator: admin, key: 'lum', name: 'LumenBox' });
    expect(team.key).toBe('LUM');
    expect(team.visibility).toBe('PRIVATE');
    const states = await prisma.workflowState.findMany({ where: { teamId: team.id }, orderBy: { position: 'asc' } });
    expect(states.map((state) => state.type)).toEqual(['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW', 'COMPLETED', 'CANCELED']);
    expect(await prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: team.id, userId: admin.id } } }))
      .toMatchObject({ role: 'OWNER' });

    await expect(createTeam(prisma, { creator: admin, key: 'INV', name: 'Again' })).rejects.toThrow(TEAM_KEY_TAKEN_MESSAGE);
  });

  it('lets members create teams only when an admin allows it, and never guests', async () => {
    await expect(createTeam(prisma, { creator: member, key: 'MEM', name: 'Members team' })).rejects.toThrow(TEAM_CREATE_FORBIDDEN_MESSAGE);
    await updateWorkspaceSettings(prisma, { byActorId: admin.id, membersCanCreateTeams: true });
    await expect(createTeam(prisma, { creator: member, key: 'MEM', name: 'Members team' })).resolves.toBeTruthy();
    await expect(createTeam(prisma, { creator: guest, key: 'GST', name: 'Guest team' })).rejects.toThrow(TEAM_CREATE_FORBIDDEN_MESSAGE);
  });

  it('makes an archived team read-only for everyone, admins included, until unarchived', async () => {
    await setTeamArchived(prisma, inv.id, true);
    await expect(assertCanWriteTeam(prisma, context(admin), inv.id)).rejects.toThrow(TEAM_ARCHIVED_MESSAGE);
    await setTeamArchived(prisma, inv.id, false);
    await expect(assertCanWriteTeam(prisma, context(admin), inv.id)).resolves.toBeUndefined();
  });

  it('lets members join public teams themselves, not private ones, and not guests', async () => {
    await expect(joinTeam(prisma, { teamId: inv.id, user: member })).rejects.toThrow(TEAM_JOIN_FORBIDDEN_MESSAGE);
    await prisma.team.update({ where: { id: inv.id }, data: { visibility: 'PUBLIC' } });
    await joinTeam(prisma, { teamId: inv.id, user: member });
    expect(await prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: inv.id, userId: member.id } } }))
      .toMatchObject({ role: 'EDITOR' });
    await expect(joinTeam(prisma, { teamId: inv.id, user: guest })).rejects.toThrow(TEAM_JOIN_FORBIDDEN_MESSAGE);
  });

  it('lets anyone leave, except the last owner', async () => {
    const team = await createTeam(prisma, { creator: admin, key: 'OPS', name: 'Ops' });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: member.id } });
    await leaveTeam(prisma, { teamId: team.id, userId: member.id });
    await expect(leaveTeam(prisma, { teamId: team.id, userId: admin.id })).rejects.toThrow(TEAM_LAST_OWNER_LEAVE_MESSAGE);
  });

  describe('over GraphQL', () => {
    let server: StartedServer | null = null;

    afterEach(async () => {
      await server?.stop();
      server = null;
    });

    async function graphql(user: User, query: string) {
      server ??= await startServer({ allowAdminFallback: false, authToken: 'unused-test-token', port: 0, prisma });
      const session = await createSession(prisma, user.id);
      const response = await fetch(`${server.url}/graphql`, {
        body: JSON.stringify({ query }),
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
        method: 'POST',
      });
      return response.json() as Promise<{ data: any; errors?: Array<{ message: string }> }>;
    }

    it('shows the roster with roles to a Viewer, not only to owners', async () => {
      await prisma.teamMembership.create({ data: { role: 'VIEWER', teamId: inv.id, userId: member.id } });
      const result = await graphql(member, '{ teams { nodes { key viewerIsMember memberships { nodes { role user { email } } } } } }');
      const roster = result.data.teams.nodes[0].memberships.nodes;
      expect(result.data.teams.nodes[0].viewerIsMember).toBe(true);
      expect(roster).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'VIEWER', user: { email: 'member@example.com' } })]));
      expect(roster.some((row: { role: string }) => row.role === 'OWNER')).toBe(true);
    });

    it('hides archived teams unless asked, and lets an owner rename a team', async () => {
      await setTeamArchived(prisma, inv.id, true);
      const hidden = await graphql(admin, '{ teams { nodes { key } } all: teams(includeArchived: true) { nodes { key archivedAt } } }');
      expect(hidden.data.teams.nodes).toEqual([]);
      expect(hidden.data.all.nodes[0].archivedAt).not.toBeNull();

      const renamed = await graphql(admin, `mutation { teamUpdate(input: { teamId: "${inv.id}", name: "Involute Core" }) { success team { name } } }`);
      expect(renamed.data.teamUpdate).toEqual({ success: true, team: { name: 'Involute Core' } });
    });

    it('moves workflow-state management to the team owner', async () => {
      await prisma.teamMembership.create({ data: { role: 'OWNER', teamId: inv.id, userId: member.id } });
      const created = await graphql(
        member,
        `mutation { workflowStateCreate(input: { teamId: "${inv.id}", name: "QA", type: STARTED }) { success message } }`,
      );
      expect(created.data.workflowStateCreate).toMatchObject({ success: true });
    });
  });
});
