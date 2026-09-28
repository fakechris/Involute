import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { issueAgentCredential } from './agent-credentials.ts';
import { startServer, type StartedServer } from './index.ts';
import { SESSION_COOKIE_NAME, createSession } from './session.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * A person who has just signed in with Google and was added to nothing
 * (2026-09-28): by design they may see and do nothing. Before this they saw
 * every agent in the workspace, and the web offered them New project,
 * Invite and "Manage Team Access & RBAC".
 */
describe('a signed-in viewer with no team, no share and no role', () => {
  let server: StartedServer;
  let admin: User;
  let newcomer: User;

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
    await prisma.team.update({ where: { key: DEFAULT_TEAM_KEY }, data: { visibility: 'PRIVATE' } });
    await issueAgentCredential(prisma, { handle: 'mia', issuedById: admin.id, name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY });
    newcomer = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'newcomer@example.invalid', name: 'Newcomer' } });
    server = await startServer({ allowAdminFallback: false, authToken: 'unused-test-token', port: 0, prisma });
  });

  afterEach(async () => {
    await server.stop();
  });

  async function graphql(user: User, query: string) {
    const session = await createSession(prisma, user.id);
    const response = await fetch(`${server.url}/graphql`, {
      body: JSON.stringify({ query }),
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
      method: 'POST',
    });
    return response.json() as Promise<{ data: any; errors?: Array<{ message: string }> }>;
  }

  it('sees no agents and no agent pages', async () => {
    const result = await graphql(newcomer, '{ agents { handle } agentProfile(handle: "mia") { actor { handle } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.agents).toEqual([]);
    expect(result.data.agentProfile).toBeNull();

    // The owner still sees the agent it is accountable for.
    const asAdmin = await graphql(admin, '{ agents { handle } }');
    expect(asAdmin.data.agents.map((agent: { handle: string }) => agent.handle)).toContain('mia');
  });

  it('sees no team, no issues and no users but themself', async () => {
    const result = await graphql(newcomer, '{ teams { nodes { key } } issues(first: 50) { nodes { identifier } } users { nodes { email } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.teams.nodes).toEqual([]);
    expect(result.data.issues.nodes).toEqual([]);
    expect(result.data.users.nodes).toEqual([{ email: 'newcomer@example.invalid' }]);
  });

  it('cannot run the traceability audit, which lists PR titles across repositories', async () => {
    const result = await graphql(newcomer, '{ traceabilityAudit(days: 1) { scannedPrCount } }');
    expect(result.data?.traceabilityAudit ?? null).toBeNull();
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('is told, per team, that it may neither write nor manage', async () => {
    await prisma.team.update({ where: { key: DEFAULT_TEAM_KEY }, data: { visibility: 'PUBLIC' } });
    const result = await graphql(newcomer, '{ teams { nodes { key viewerCanWrite viewerCanManage } } }');
    expect(result.data.teams.nodes).toEqual([{ key: DEFAULT_TEAM_KEY, viewerCanManage: false, viewerCanWrite: false }]);

    const asAdmin = await graphql(admin, '{ teams { nodes { key viewerCanWrite viewerCanManage } } }');
    expect(asAdmin.data.teams.nodes).toEqual([{ key: DEFAULT_TEAM_KEY, viewerCanManage: true, viewerCanWrite: true }]);
  });

  it('is refused when it tries to create a project or invite a member anyway', async () => {
    await prisma.team.update({ where: { key: DEFAULT_TEAM_KEY }, data: { visibility: 'PUBLIC' } });
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });

    const create = await graphql(
      newcomer,
      `mutation { issueCreate(input: { teamId: "${team.id}", title: "Sneaky project", kind: PROJECT }) { success } }`,
    );
    expect(create.data?.issueCreate?.success ?? false).toBe(false);

    const invite = await graphql(
      newcomer,
      `mutation { teamMembershipUpsert(input: { teamId: "${team.id}", email: "friend@example.invalid", role: OWNER }) { success } }`,
    );
    expect(invite.data?.teamMembershipUpsert?.success ?? false).toBe(false);
    expect(await prisma.teamMembership.count({ where: { user: { email: 'friend@example.invalid' } } })).toBe(0);
  });
});
