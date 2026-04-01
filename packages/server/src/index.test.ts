import type { PrismaClient, Team, User, WorkflowState, IssueLabel, Issue, Comment } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, DEFAULT_WORKFLOW_STATE_NAMES, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';
let activeServer: StartedServer;

interface TestFixture {
  team: Team;
  admin: User;
  issue: Issue;
  childIssue: Issue;
  comment: Comment;
  states: WorkflowState[];
  labels: IssueLabel[];
}

describe('GraphQL server core', () => {
  let server: StartedServer;
  let fixture: TestFixture;

  beforeAll(async () => {
    await prisma.$connect();
    server = await startServer({
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });
    activeServer = server;
  });

  afterAll(async () => {
    await server.stop();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    fixture = await resetDatabase(prisma);
  });

  it('starts, exposes /health, and accepts JSON POSTs on /graphql', async () => {
    const healthResponse = await fetch(`${server.url}/health`);

    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe('OK');

    const graphQlResponse = await postGraphQL({
      query: '{ __typename }',
    });

    expect(graphQlResponse.status).toBe(200);
    expect(graphQlResponse.body).toEqual({
      data: {
        __typename: 'Query',
      },
    });
  });

  it('rejects missing or invalid auth with a GraphQL error while allowing valid bearer and raw tokens', async () => {
    const unauthenticatedResponse = await postGraphQL({
      query: '{ teams { nodes { id } } }',
    });

    expect(unauthenticatedResponse.status).toBe(200);
    expect(unauthenticatedResponse.body.errors?.[0]?.message).toBe('Not authenticated');

    const invalidTokenResponse = await postGraphQL({
      query: '{ teams { nodes { id } } }',
      token: 'Bearer definitely-invalid',
    });

    expect(invalidTokenResponse.status).toBe(200);
    expect(invalidTokenResponse.body.errors?.[0]?.message).toBe('Not authenticated');

    const bearerTokenResponse = await postGraphQL({
      query: '{ teams { nodes { key } } }',
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(bearerTokenResponse.status).toBe(200);
    expect(bearerTokenResponse.body.data.teams.nodes).toHaveLength(1);

    const rawTokenResponse = await postGraphQL({
      query: '{ teams { nodes { key } } }',
      token: TEST_AUTH_TOKEN,
    });

    expect(rawTokenResponse.status).toBe(200);
    expect(rawTokenResponse.body.data.teams.nodes).toHaveLength(1);
  });

  it('resolves authenticated data for issue, teams, and labels queries', async () => {
    const response = await postGraphQL({
      query: `
        query($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            state { id name }
            labels { nodes { id name } }
            assignee { id name email isMe }
            children { nodes { id title } }
            team {
              id
              key
              name
              states { nodes { id name } }
            }
            comments(orderBy: createdAt) {
              nodes {
                id
                body
                createdAt
                user { id name email isMe }
              }
            }
          }
          teams {
            nodes {
              id
              key
              name
              states { nodes { name } }
            }
          }
          issueLabels {
            nodes {
              id
              name
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issue).toMatchObject({
      id: fixture.issue.id,
      title: fixture.issue.title,
      description: fixture.issue.description,
      assignee: {
        id: fixture.admin.id,
        email: fixture.admin.email,
        isMe: true,
      },
      team: {
        id: fixture.team.id,
        key: fixture.team.key,
        name: fixture.team.name,
      },
    });
    expect(response.body.data.issue.labels.nodes).toEqual(
      fixture.labels.map((label) => ({
        id: label.id,
        name: label.name,
      })),
    );
    expect(response.body.data.issue.children.nodes).toEqual([
      {
        id: fixture.childIssue.id,
        title: fixture.childIssue.title,
      },
    ]);
    expect(response.body.data.issue.comments.nodes).toEqual([
      {
        id: fixture.comment.id,
        body: fixture.comment.body,
        createdAt: fixture.comment.createdAt.toISOString(),
        user: {
          id: fixture.admin.id,
          name: fixture.admin.name,
          email: fixture.admin.email,
          isMe: true,
        },
      },
    ]);
    expect(response.body.data.teams.nodes).toEqual([
      {
        id: fixture.team.id,
        key: fixture.team.key,
        name: fixture.team.name,
        states: {
          nodes: DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({ name })),
        },
      },
    ]);
    expect(response.body.data.issueLabels.nodes.length).toBeGreaterThanOrEqual(10);
  });

  it('returns null for a missing issue and returns GraphQL spec errors for malformed queries', async () => {
    const missingIssueResponse = await postGraphQL({
      query: 'query($id: String!) { issue(id: $id) { id } }',
      variables: {
        id: '00000000-0000-0000-0000-000000000000',
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(missingIssueResponse.status).toBe(200);
    expect(missingIssueResponse.body).toEqual({
      data: {
        issue: null,
      },
    });

    const malformedQueryResponse = await postGraphQL({
      query: '{ nonExistentField }',
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect([200, 400]).toContain(malformedQueryResponse.status);
    expect(Array.isArray(malformedQueryResponse.body.errors)).toBe(true);
    expect(malformedQueryResponse.body.errors[0]?.message).toContain('Cannot query field');
  });

  it('handles five concurrent authenticated requests successfully', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        postGraphQL({
          query: '{ teams { nodes { id key name } } }',
          token: `Bearer ${TEST_AUTH_TOKEN}`,
        }),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.teams.nodes).toEqual([
        {
          id: fixture.team.id,
          key: fixture.team.key,
          name: fixture.team.name,
        },
      ]);
    }
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<TestFixture> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();

  await seedDatabase(prismaClient);

  const team = await prismaClient.team.findUniqueOrThrow({
    where: {
      key: DEFAULT_TEAM_KEY,
    },
  });

  await prismaClient.team.update({
    where: {
      id: team.id,
    },
    data: {
      nextIssueNumber: 1,
    },
  });

  const refreshedTeam = await prismaClient.team.findUniqueOrThrow({
    where: {
      id: team.id,
    },
  });

  const admin = await prismaClient.user.findUniqueOrThrow({
    where: {
      email: DEFAULT_ADMIN_EMAIL,
    },
  });

  const states = await prismaClient.workflowState.findMany({
    where: {
      teamId: refreshedTeam.id,
    },
    orderBy: {
      name: 'asc',
    },
  });

  const labels = await prismaClient.issueLabel.findMany({
    where: {
      name: {
        in: ['task', 'Feature'],
      },
    },
    orderBy: {
      name: 'asc',
    },
  });

  const readyState = states.find((state) => state.name === 'Ready');
  const backlogState = states.find((state) => state.name === 'Backlog');

  if (!readyState || !backlogState) {
    throw new Error('Expected seeded workflow states to exist.');
  }

  const issue = await prismaClient.issue.create({
    data: {
      teamId: refreshedTeam.id,
      stateId: readyState.id,
      assigneeId: admin.id,
      title: 'Parent integration issue',
      description: 'Verifies server core behavior.',
      labels: {
        connect: labels.map((label) => ({ id: label.id })),
      },
    },
  });

  const childIssue = await prismaClient.issue.create({
    data: {
      teamId: refreshedTeam.id,
      stateId: backlogState.id,
      parentId: issue.id,
      title: 'Child integration issue',
      description: 'Nested under the parent issue.',
    },
  });

  const comment = await prismaClient.comment.create({
    data: {
      issueId: issue.id,
      userId: admin.id,
      body: 'First seeded comment',
      createdAt: new Date('2025-01-15T10:30:00.000Z'),
    },
  });

  return {
    team: refreshedTeam,
    admin,
    issue,
    childIssue,
    comment,
    states,
    labels,
  };
}

async function postGraphQL({
  query,
  variables,
  token,
}: {
  query: string;
  variables?: Record<string, unknown>;
  token?: string;
}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${activeServer.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}
