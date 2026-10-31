import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import type { GraphQLContext } from './auth.ts';
import { startServer, type StartedServer } from './index.ts';
import { readWorkCatalog } from './work-catalog.ts';

loadProjectEnvironment();

const TEST_AUTH_TOKEN = 'test-auth-token';

/**
 * INV-1451: a team reference is a team key or a team id. The web app and
 * every other tool name teams by key, so the catalog has to accept the key
 * too — and an unknown team must read as "not found", never as a database
 * error.
 */
describe('work catalog team reference (INV-1451)', () => {
  const prisma = new PrismaClient();
  let server: StartedServer;
  let team: Team;
  let other: Team;
  let admin: User;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    other = await prisma.team.create({ data: { key: 'SON', name: 'Sonata' } });
    await prisma.workflowState.create({ data: { teamId: other.id, name: 'Ready', type: 'UNSTARTED', position: 1 } });
    await prisma.cycle.create({
      data: { teamId: team.id, name: 'Cycle A', number: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-02-01') },
    });
    await prisma.cycle.create({
      data: { teamId: other.id, name: 'Cycle B', number: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-02-01') },
    });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: TEST_AUTH_TOKEN, port: 0 });
  });

  afterEach(async () => {
    await server.stop();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const context = (): GraphQLContext => ({ prisma, viewer: admin, authMode: 'token', isTrustedSystem: true });
  const ids = (nodes: Array<{ id: string }>) => nodes.map((node) => node.id);

  it('reads the same states by team key and by team id, and only that team', async () => {
    const byKey = await readWorkCatalog(context(), 'states', 50, undefined, DEFAULT_TEAM_KEY);
    const byId = await readWorkCatalog(context(), 'states', 50, undefined, team.id);

    expect(ids(byKey.nodes)).toEqual(ids(byId.nodes));
    expect(byKey.nodes.length).toBeGreaterThan(0);

    const otherState = await prisma.workflowState.findFirstOrThrow({ where: { teamId: other.id } });
    expect(ids(byKey.nodes)).not.toContain(otherState.id);
  });

  it('narrows teams, actors and cycles by team key as well', async () => {
    const teams = await readWorkCatalog(context(), 'teams', 50, undefined, DEFAULT_TEAM_KEY);
    expect(ids(teams.nodes)).toEqual([team.id]);

    const actors = await readWorkCatalog(context(), 'actors', 50, undefined, DEFAULT_TEAM_KEY);
    expect(ids(actors.nodes)).toContain(admin.id);

    const cycles = await readWorkCatalog(context(), 'cycles', 50, undefined, DEFAULT_TEAM_KEY);
    const cycleNames = cycles.nodes.map((node) => (node as { name: string }).name);
    expect(cycleNames).toEqual(['Cycle A']);
  });

  it('reports an unknown team as not found instead of a database error', async () => {
    const failure = await readWorkCatalog(context(), 'states', 50, undefined, 'NOPE').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('Team not found');
    expect(message.toLowerCase()).not.toContain('prisma');
  });

  it('keeps the cursor working when the team is named by key', async () => {
    const first = await readWorkCatalog(context(), 'states', 1, undefined, DEFAULT_TEAM_KEY);
    expect(first.pageInfo.hasNextPage).toBe(true);

    const second = await readWorkCatalog(context(), 'states', 50, first.pageInfo.endCursor, DEFAULT_TEAM_KEY);
    expect(second.nodes.length).toBeGreaterThan(0);
    expect(ids(second.nodes)).not.toEqual(ids(first.nodes));
  });

  it('serves the catalog and the incident summary for a team key over MCP', async () => {
    const states = await callTool('work_catalog', { kind: 'states', team_id: DEFAULT_TEAM_KEY });
    expect(states.kind).toBe('states');
    expect(states.nodes.length).toBeGreaterThan(0);

    const summary = await callTool('work_catalog', { kind: 'incident_summary', team_id: DEFAULT_TEAM_KEY });
    expect(summary.openCount).toBe(0);
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }),
    });

    const body = await response.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    return JSON.parse(body.result.content[0].text);
  }
});
