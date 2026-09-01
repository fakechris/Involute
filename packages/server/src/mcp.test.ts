import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { READ_ONLY_MCP_TOOLS, WRITE_MCP_TOOLS } from './mcp-tools.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

describe('Involute MCP', () => {
  let team: Team;
  let viewer: User;
  let ready: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);

    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    ready = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Ready' },
    });
    server = await startServer({
      allowAdminFallback: true,
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects unauthenticated calls and hides write tools on the readonly endpoint', async () => {
    const unauthenticated = await mcpRpc('/mcp', { method: 'tools/list', id: 1 }, false);
    expect(unauthenticated.status).toBe(401);

    const allTools = await mcpRpc('/mcp', { method: 'tools/list', id: 2 });
    expect(allTools.status).toBe(200);
    const names = (allTools.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...READ_ONLY_MCP_TOOLS, ...WRITE_MCP_TOOLS]));

    const readonlyTools = await mcpRpc('/mcp/readonly', { method: 'tools/list', id: 3 });
    const readonlyNames = (readonlyTools.body.result.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(readonlyNames).toEqual([...READ_ONLY_MCP_TOOLS]);

    const blocked = await mcpRpc('/mcp/readonly', {
      id: 4,
      method: 'tools/call',
      params: {
        name: 'work_propose',
        arguments: { team: DEFAULT_TEAM_KEY, title: 'should fail' },
      },
    });
    expect(blocked.body.error.message).toContain('read-only');
  });

  it('runs search → context → propose → commit → claim without marking work done', async () => {
    await prisma.issue.create({
      data: {
        identifier: 'INV-100',
        title: 'Existing MCP search hit',
        teamId: team.id,
        stateId: ready.id,
      },
    });

    const search = await callTool('work_search', { query: 'MCP search' });
    expect(JSON.stringify(search)).toContain('INV-100');

    const proposed = await callTool('work_propose', {
      team: DEFAULT_TEAM_KEY,
      title: 'Ignore aborted turns in parser',
      idempotency_key: 'mcp-parser-1',
    });
    expect(proposed.commitmentStatus).toBe('CANDIDATE');

    const replay = await callTool('work_propose', {
      team: DEFAULT_TEAM_KEY,
      title: 'Ignore aborted turns in parser',
      idempotency_key: 'mcp-parser-1',
    });
    expect(replay.identifier).toBe(proposed.identifier);

    const readyBefore = await callTool('work_list_ready', {});
    expect(readyIdentifiers(readyBefore)).not.toContain(proposed.identifier);

    const context = await callTool('work_get_context', { id: proposed.identifier });
    expect(context.work.identifier).toBe(proposed.identifier);

    const committed = await callTool('work_commit', {
      id: proposed.identifier,
      expected_revision: proposed.revision,
      acceptance: 'Aborted turns are omitted from extracted issues',
      assignee_id: viewer.id,
    });
    expect(committed.commitmentStatus).toBe('COMMITTED');

    const claimed = await callTool('work_claim', { id: committed.identifier });
    expect(claimed.claim.actorId).toBe(viewer.id);
    expect(claimed.work.assigneeId).toBe(viewer.id);

    const readyAfter = await callTool('work_list_ready', {});
    expect(readyIdentifiers(readyAfter)).not.toContain(committed.identifier);
    expect(claimed.work.commitmentStatus).toBe('COMMITTED');
  });
});

function readyIdentifiers(result: { nodes?: Array<{ identifier: string }> }): string[] {
  return result.nodes?.map((issue) => issue.identifier) ?? [];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const response = await mcpRpc('/mcp', {
    id: name,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  expect(response.body.error).toBeUndefined();
  return JSON.parse(response.body.result.content[0].text);
}

async function mcpRpc(
  path: string,
  message: { id: number | string; method: string; params?: unknown },
  authenticated = true,
): Promise<{ body: any; status: number }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${TEST_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });

  return {
    body: await response.json(),
    status: response.status,
  };
}
