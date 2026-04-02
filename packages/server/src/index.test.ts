import type { PrismaClient, Team, User, WorkflowState, IssueLabel, Issue, Comment } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_LABEL_NAMES,
  DEFAULT_TEAM_KEY,
  DEFAULT_WORKFLOW_STATE_NAMES,
  seedDatabase,
} from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';
let activeServer: StartedServer;

interface TestFixture {
  team: Team;
  admin: User;
  importedUser: User;
  issue: Issue;
  childIssue: Issue;
  importedIssue: Issue;
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
      token: `Bearer ${TEST_AUTH_TOKEN}`,
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

  it('exposes imported issue timestamps and imported users through the live API surface', async () => {
    const response = await postGraphQL({
      query: `
        query($id: String!) {
          issue(id: $id) {
            id
            identifier
            createdAt
            updatedAt
          }
          users {
            nodes {
              id
              name
              email
            }
          }
        }
      `,
      variables: {
        id: fixture.importedIssue.id,
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issue).toEqual({
      id: fixture.importedIssue.id,
      identifier: fixture.importedIssue.identifier,
      createdAt: '2024-06-01T10:00:00.000Z',
      updatedAt: '2024-06-02T15:00:00.000Z',
    });
    expect(response.body.data.users.nodes).toEqual([
      {
        id: fixture.admin.id,
        name: fixture.admin.name,
        email: fixture.admin.email,
      },
      {
        id: fixture.importedUser.id,
        name: fixture.importedUser.name,
        email: fixture.importedUser.email,
      },
    ]);
  });

  it('returns issue comments in ascending createdAt order with first limits and complete fields', async () => {
    const collaborator = await prisma.user.create({
      data: {
        email: 'commenter@involute.local',
        name: 'Comment Collaborator',
      },
    });

    const middleComment = await prisma.comment.create({
      data: {
        issueId: fixture.issue.id,
        userId: collaborator.id,
        body: 'Second seeded comment',
        createdAt: new Date('2025-01-15T10:31:00.000Z'),
      },
    });

    const latestComment = await prisma.comment.create({
      data: {
        issueId: fixture.issue.id,
        userId: fixture.admin.id,
        body: 'Third seeded comment',
        createdAt: new Date('2025-01-15T10:32:00.000Z'),
      },
    });

    const fullResponse = await postGraphQL({
      query: `
        query($id: String!, $first: Int!) {
          issue(id: $id) {
            comments(first: $first, orderBy: createdAt) {
              nodes {
                id
                body
                createdAt
                user { id name email }
              }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        first: 10,
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(fullResponse.status).toBe(200);
    expect(fullResponse.body.errors).toBeUndefined();
    expect(fullResponse.body.data.issue.comments.nodes).toEqual([
      {
        id: fixture.comment.id,
        body: fixture.comment.body,
        createdAt: fixture.comment.createdAt.toISOString(),
        user: {
          id: fixture.admin.id,
          name: fixture.admin.name,
          email: fixture.admin.email,
        },
      },
      {
        id: middleComment.id,
        body: middleComment.body,
        createdAt: middleComment.createdAt.toISOString(),
        user: {
          id: collaborator.id,
          name: collaborator.name,
          email: collaborator.email,
        },
      },
      {
        id: latestComment.id,
        body: latestComment.body,
        createdAt: latestComment.createdAt.toISOString(),
        user: {
          id: fixture.admin.id,
          name: fixture.admin.name,
          email: fixture.admin.email,
        },
      },
    ]);
    expect(
      fullResponse.body.data.issue.comments.nodes.every(
        (comment: { createdAt: string }) =>
          comment.createdAt === new Date(comment.createdAt).toISOString(),
      ),
    ).toBe(true);

    const limitedResponse = await postGraphQL({
      query: `
        query($id: String!, $first: Int!) {
          issue(id: $id) {
            comments(first: $first, orderBy: createdAt) {
              nodes {
                id
              }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        first: 2,
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(limitedResponse.status).toBe(200);
    expect(limitedResponse.body.errors).toBeUndefined();
    expect(limitedResponse.body.data.issue.comments.nodes).toEqual([
      { id: fixture.comment.id },
      { id: middleComment.id },
    ]);
  });

  it('returns empty comment nodes arrays for issues with no comments', async () => {
    const response = await postGraphQL({
      query: `
        query($id: String!) {
          issue(id: $id) {
            comments(first: 5, orderBy: createdAt) {
              nodes {
                id
              }
            }
          }
        }
      `,
      variables: {
        id: fixture.childIssue.id,
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issue.comments).toEqual({
      nodes: [],
    });
  });

  it('filters teams by key and returns empty nodes when no team matches', async () => {
    await createTeamWithStates(prisma, {
      key: 'OPS',
      name: 'Operations',
    });

    const matchingTeamResponse = await postGraphQL({
      query: `
        query($key: String!) {
          teams(filter: { key: { eq: $key } }) {
            nodes {
              id
              key
              name
            }
          }
        }
      `,
      variables: {
        key: fixture.team.key,
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(matchingTeamResponse.status).toBe(200);
    expect(matchingTeamResponse.body.errors).toBeUndefined();
    expect(matchingTeamResponse.body.data.teams.nodes).toEqual([
      {
        id: fixture.team.id,
        key: fixture.team.key,
        name: fixture.team.name,
      },
    ]);

    const missingTeamResponse = await postGraphQL({
      query: `
        query($key: String!) {
          teams(filter: { key: { eq: $key } }) {
            nodes {
              id
            }
          }
        }
      `,
      variables: {
        key: 'NONEXISTENT',
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(missingTeamResponse.status).toBe(200);
    expect(missingTeamResponse.body).toEqual({
      data: {
        teams: {
          nodes: [],
        },
      },
    });
  });

  it('resolves workflow states through issue.team.states', async () => {
    const response = await postGraphQL({
      query: `
        query($id: String!) {
          issue(id: $id) {
            team {
              id
              key
              states {
                nodes {
                  id
                  name
                }
              }
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
    const expectedStatesByName = new Map(
      fixture.states.map((state) => [state.name, state] as const),
    );
    expect(response.body.data.issue.team).toEqual({
      id: fixture.team.id,
      key: fixture.team.key,
      states: {
        nodes: DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({
          id: expectedStatesByName.get(name)?.id,
          name,
        })),
      },
    });
  });

  it('returns all teams with nested states when no filter is provided', async () => {
    await createTeamWithStates(prisma, {
      key: 'OPS',
      name: 'Operations',
    });

    const response = await postGraphQL({
      query: `
        {
          teams {
            nodes {
              key
              name
              states {
                nodes {
                  name
                }
              }
            }
          }
        }
      `,
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.teams.nodes).toEqual([
      {
        key: fixture.team.key,
        name: fixture.team.name,
        states: {
          nodes: DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({ name })),
        },
      },
      {
        key: 'OPS',
        name: 'Operations',
        states: {
          nodes: DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({ name })),
        },
      },
    ]);
  });

  it('filters issue labels by name and returns empty nodes when no label matches', async () => {
    const matchingLabelResponse = await postGraphQL({
      query: `
        query($name: String!) {
          issueLabels(filter: { name: { eq: $name } }) {
            nodes {
              id
              name
            }
          }
        }
      `,
      variables: {
        name: 'task',
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(matchingLabelResponse.status).toBe(200);
    expect(matchingLabelResponse.body.errors).toBeUndefined();
    expect(matchingLabelResponse.body.data.issueLabels.nodes).toHaveLength(1);
    expect(matchingLabelResponse.body.data.issueLabels.nodes[0]).toMatchObject({
      name: 'task',
    });
    expect(matchingLabelResponse.body.data.issueLabels.nodes[0].id).toEqual(expect.any(String));

    const missingLabelResponse = await postGraphQL({
      query: `
        query($name: String!) {
          issueLabels(filter: { name: { eq: $name } }) {
            nodes {
              id
            }
          }
        }
      `,
      variables: {
        name: 'nonexistent',
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(missingLabelResponse.status).toBe(200);
    expect(missingLabelResponse.body).toEqual({
      data: {
        issueLabels: {
          nodes: [],
        },
      },
    });
  });

  it('returns all seeded issue labels when no filter is provided', async () => {
    const response = await postGraphQL({
      query: `
        {
          issueLabels {
            nodes {
              id
              name
            }
          }
        }
      `,
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issueLabels.nodes).toHaveLength(DEFAULT_LABEL_NAMES.length);
    expect(response.body.data.issueLabels.nodes.map((label: { name: string }) => label.name)).toEqual(
      expect.arrayContaining(DEFAULT_LABEL_NAMES),
    );
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
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  await prismaClient.user.deleteMany();
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

  const importedUser = await prismaClient.user.create({
    data: {
      email: 'imported.alice@example.com',
      name: 'Imported Alice',
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
      identifier: 'INV-1',
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
      identifier: 'INV-2',
      teamId: refreshedTeam.id,
      stateId: backlogState.id,
      parentId: issue.id,
      title: 'Child integration issue',
      description: 'Nested under the parent issue.',
    },
  });

  const importedIssue = await prismaClient.issue.create({
    data: {
      identifier: 'SON-42',
      teamId: refreshedTeam.id,
      stateId: readyState.id,
      assigneeId: importedUser.id,
      title: 'Imported integration issue',
      description: 'Represents a preserved imported issue.',
      createdAt: new Date('2024-06-01T10:00:00.000Z'),
      updatedAt: new Date('2024-06-02T15:00:00.000Z'),
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
    importedUser,
    issue,
    childIssue,
    importedIssue,
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

async function createTeamWithStates(
  prismaClient: PrismaClient,
  {
    key,
    name,
  }: {
    key: string;
    name: string;
  },
): Promise<Team> {
  const team = await prismaClient.team.create({
    data: {
      key,
      name,
    },
  });

  await prismaClient.workflowState.createMany({
    data: DEFAULT_WORKFLOW_STATE_NAMES.map((stateName) => ({
      name: stateName,
      teamId: team.id,
    })),
  });

  return team;
}
