import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

describe('IQL filtering across surfaces', () => {
  let team: Team;
  let viewer: User;
  let startedState: WorkflowState;
  let backlogState: WorkflowState;

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
    startedState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, type: 'STARTED' },
    });
    backlogState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, type: 'BACKLOG' },
    });
    const readyState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, type: 'UNSTARTED' },
    });
    server = await startServer({
      allowAdminFallback: true,
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });

    const base = {
      teamId: team.id,
      commitmentStatus: 'COMMITTED' as const,
    };
    await prisma.issue.create({
      data: { ...base, identifier: 'IQL-1', stateId: startedState.id, title: 'Migrate search', priority: 2 },
    });
    await prisma.issue.create({
      data: {
        ...base,
        identifier: 'IQL-2',
        stateId: readyState.id,
        title: 'Backup drill',
        priority: 0,
        acceptance: 'restore drill passes',
        assigneeId: viewer.id,
      },
    });
    await prisma.issue.create({
      data: {
        ...base,
        identifier: 'IQL-3',
        stateId: backlogState.id,
        title: 'Blocked import',
        priority: 3,
        commitmentStatus: 'CANDIDATE',
      },
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  async function postGraphQL(query: string, variables?: Record<string, unknown>) {
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    return { body: (await response.json()) as any, status: response.status };
  }

  it('filters issues by state-type, priority, and negated commitment', async () => {
    const result = await postGraphQL(
      'query($q: String) { issues(first: 10, query: $q) { nodes { identifier } } }',
      { q: 'state-type:STARTED priority:>=2 -commitment:candidate' },
    );
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.issues.nodes.map((node: { identifier: string }) => node.identifier)).toEqual(['IQL-1']);
  });

  it('matches free-text terms against titles', async () => {
    const result = await postGraphQL(
      'query($q: String) { issues(first: 10, query: $q) { nodes { identifier } } }',
      { q: 'backup' },
    );
    expect(result.body.data.issues.nodes.map((node: { identifier: string }) => node.identifier)).toEqual(['IQL-2']);
  });

  it('rejects invalid queries with an exposed IQL_PARSE error', async () => {
    const result = await postGraphQL(
      'query($q: String) { issues(first: 10, query: $q) { nodes { identifier } } }',
      { q: 'bogus:1' },
    );
    expect(result.body.errors).toHaveLength(1);
    expect(result.body.errors[0].message).toContain('Invalid IQL query');
    expect(result.body.errors[0].extensions?.code).toBe('IQL_PARSE');
  });

  it('applies IQL on the MCP work_search and work_list_ready tools', async () => {
    const search = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'work_search',
          arguments: { filter: 'commitment:CANDIDATE', team_key: DEFAULT_TEAM_KEY },
        },
      }),
    });
    const searchBody = (await search.json()) as any;
    const searchText = searchBody.result.content[0].text as string;
    expect(searchText).toContain('IQL-3');
    expect(searchText).not.toContain('IQL-1');

    const ready = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        id: 2,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'work_list_ready',
          arguments: { filter: 'priority:<=1' },
        },
      }),
    });
    const readyBody = (await json(ready)) as any;
    expect(readyBody.result.content[0].text).toContain('IQL-2');
  });

  async function json(response: globalThis.Response): Promise<unknown> {
    return response.json();
  }
});
