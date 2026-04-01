import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_TEAM_KEY,
  seedDatabase,
} from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

interface MutationFixture {
  issue: { id: string; identifier: string };
  labelsByName: Map<string, { id: string; name: string }>;
  otherTeam: Team;
  otherTeamReadyState: WorkflowState;
  parentIssue: { id: string; identifier: string };
  states: {
    backlog: WorkflowState;
    inProgress: WorkflowState;
    ready: WorkflowState;
  };
  team: Team;
  viewer: User;
}

describe('GraphQL mutations', () => {
  let fixture: MutationFixture;

  beforeAll(async () => {
    await prisma.$connect();
    server = await startServer({
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });
  });

  afterAll(async () => {
    await server.stop();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    fixture = await resetDatabase(prisma);
  });

  it('creates an issue with a generated identifier, Backlog state, and retrievable connection fields', async () => {
    const createResponse = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              title
            }
          }
        }
      `,
      variables: {
        input: {
          teamId: fixture.team.id,
          title: 'Created from mutation',
          description: 'Created description',
        },
      },
    });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.errors).toBeUndefined();
    expect(createResponse.body.data.issueCreate).toEqual({
      success: true,
      issue: {
        id: expect.any(String),
        identifier: 'INV-3',
        title: 'Created from mutation',
      },
    });

    const createdIssueId = createResponse.body.data.issueCreate.issue.id as string;

    const readResponse = await postGraphQL({
      query: `
        query Issue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            state { name }
            labels { nodes { name } }
            assignee { id isMe }
            comments(first: 10, orderBy: createdAt) { nodes { id } }
          }
        }
      `,
      variables: {
        id: createdIssueId,
      },
    });

    expect(readResponse.status).toBe(200);
    expect(readResponse.body.errors).toBeUndefined();
    expect(readResponse.body.data.issue).toEqual({
      id: createdIssueId,
      identifier: 'INV-3',
      title: 'Created from mutation',
      description: 'Created description',
      state: {
        name: 'Backlog',
      },
      labels: {
        nodes: [],
      },
      assignee: null,
      comments: {
        nodes: [],
      },
    });
  });

  it('returns success false for issueCreate with an invalid teamId', async () => {
    const response = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        input: {
          teamId: '00000000-0000-0000-0000-000000000000',
          title: 'Missing team',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issueCreate).toEqual({
      success: false,
      issue: null,
    });
  });

  it('returns success false when issueCreate uses a workflow state from another team', async () => {
    const response = await postGraphQL({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        input: {
          teamId: fixture.team.id,
          stateId: fixture.otherTeamReadyState.id,
          title: 'Cross-team create attempt',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issueCreate).toEqual({
      success: false,
      issue: null,
    });
  });

  it('updates an issue state and returns the new state payload', async () => {
    const response = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              state { name }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          stateId: fixture.states.inProgress.id,
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.issue.id,
        state: {
          name: 'In Progress',
        },
      },
    });

    const updatedIssue = await prisma.issue.findUniqueOrThrow({
      where: { id: fixture.issue.id },
      include: { state: true },
    });

    expect(updatedIssue.state.name).toBe('In Progress');
  });

  it('returns success false for invalid or nonexistent issue state transitions', async () => {
    const invalidStateResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          stateId: '00000000-0000-0000-0000-000000000000',
        },
      },
    });

    const crossTeamStateResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          stateId: fixture.otherTeamReadyState.id,
        },
      },
    });

    const missingIssueResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        id: '00000000-0000-0000-0000-000000000000',
        input: {
          stateId: fixture.states.ready.id,
        },
      },
    });

    expect(invalidStateResponse.body.errors).toBeUndefined();
    expect(invalidStateResponse.body.data.issueUpdate).toEqual({
      success: false,
      issue: null,
    });
    expect(crossTeamStateResponse.body.errors).toBeUndefined();
    expect(crossTeamStateResponse.body.data.issueUpdate).toEqual({
      success: false,
      issue: null,
    });
    expect(missingIssueResponse.body.errors).toBeUndefined();
    expect(missingIssueResponse.body.data.issueUpdate).toEqual({
      success: false,
      issue: null,
    });
  });

  it('replaces labels entirely and clears them when given an empty array', async () => {
    const replaceResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              labels { nodes { name } }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          labelIds: [
            fixture.labelsByName.get('task')!.id,
            fixture.labelsByName.get('Bug')!.id,
          ],
        },
      },
    });

    expect(replaceResponse.status).toBe(200);
    expect(replaceResponse.body.errors).toBeUndefined();
    expect(replaceResponse.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.issue.id,
        labels: {
          nodes: [{ name: 'Bug' }, { name: 'task' }],
        },
      },
    });

    const clearResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              labels { nodes { name } }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          labelIds: [],
        },
      },
    });

    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body.errors).toBeUndefined();
    expect(clearResponse.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.issue.id,
        labels: {
          nodes: [],
        },
      },
    });
  });

  it('updates labels and parent atomically, and rejects an invalid parent without partial updates', async () => {
    const updateResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              labels { nodes { name } }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          labelIds: [fixture.labelsByName.get('task')!.id],
          parentId: fixture.parentIssue.id,
        },
      },
    });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.errors).toBeUndefined();
    expect(updateResponse.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.issue.id,
        labels: {
          nodes: [{ name: 'task' }],
        },
      },
    });

    const parentReadResponse = await postGraphQL({
      query: `
        query Issue($id: String!) {
          issue(id: $id) {
            id
            children { nodes { id } }
          }
        }
      `,
      variables: {
        id: fixture.parentIssue.id,
      },
    });

    expect(parentReadResponse.body.errors).toBeUndefined();
    expect(parentReadResponse.body.data.issue.children.nodes).toEqual([{ id: fixture.issue.id }]);

    const failedUpdateResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          labelIds: [fixture.labelsByName.get('blocked')!.id],
          parentId: '00000000-0000-0000-0000-000000000000',
        },
      },
    });

    expect(failedUpdateResponse.status).toBe(200);
    expect(failedUpdateResponse.body.errors).toBeUndefined();
    expect(failedUpdateResponse.body.data.issueUpdate).toEqual({
      success: false,
      issue: null,
    });

    const issueAfterFailedUpdate = await prisma.issue.findUniqueOrThrow({
      where: { id: fixture.issue.id },
      include: {
        labels: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    expect(issueAfterFailedUpdate.parentId).toBe(fixture.parentIssue.id);
    expect(issueAfterFailedUpdate.labels.map((label) => label.name)).toEqual(['task']);
  });

  it('updates title, description, and assignee, then supports assigneeId null to unassign', async () => {
    const assignResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              title
              description
              assignee { id email isMe }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          title: 'Updated title',
          description: 'Updated description',
          assigneeId: fixture.viewer.id,
        },
      },
    });

    expect(assignResponse.status).toBe(200);
    expect(assignResponse.body.errors).toBeUndefined();
    expect(assignResponse.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.issue.id,
        title: 'Updated title',
        description: 'Updated description',
        assignee: {
          id: fixture.viewer.id,
          email: DEFAULT_ADMIN_EMAIL,
          isMe: true,
        },
      },
    });

    const unassignResponse = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              assignee { id }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          assigneeId: null,
        },
      },
    });

    expect(unassignResponse.status).toBe(200);
    expect(unassignResponse.body.errors).toBeUndefined();
    expect(unassignResponse.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.issue.id,
        assignee: null,
      },
    });
  });

  it('returns success false when assigneeId does not exist', async () => {
    const response = await postGraphQL({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
        input: {
          assigneeId: '00000000-0000-0000-0000-000000000000',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issueUpdate).toEqual({
      success: false,
      issue: null,
    });
  });

  it('creates comments with the authenticated user and exposes them in chronological order', async () => {
    const createResponse = await postGraphQL({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment {
              id
              body
            }
          }
        }
      `,
      variables: {
        input: {
          issueId: fixture.issue.id,
          body: 'A mutation-created comment',
        },
      },
    });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.errors).toBeUndefined();
    expect(createResponse.body.data.commentCreate).toEqual({
      success: true,
      comment: {
        id: expect.any(String),
        body: 'A mutation-created comment',
      },
    });

    const commentsResponse = await postGraphQL({
      query: `
        query IssueComments($id: String!) {
          issue(id: $id) {
            comments(first: 10, orderBy: createdAt) {
              nodes {
                id
                body
                createdAt
                user { id email name }
              }
            }
          }
        }
      `,
      variables: {
        id: fixture.issue.id,
      },
    });

    expect(commentsResponse.status).toBe(200);
    expect(commentsResponse.body.errors).toBeUndefined();
    expect(commentsResponse.body.data.issue.comments.nodes).toEqual([
      {
        id: createResponse.body.data.commentCreate.comment.id,
        body: 'A mutation-created comment',
        createdAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
        user: {
          id: fixture.viewer.id,
          email: DEFAULT_ADMIN_EMAIL,
          name: fixture.viewer.name,
        },
      },
    ]);
  });

  it('returns success false when commentCreate targets a nonexistent issue', async () => {
    const response = await postGraphQL({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id }
          }
        }
      `,
      variables: {
        input: {
          issueId: '00000000-0000-0000-0000-000000000000',
          body: 'This should not be created',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.commentCreate).toEqual({
      success: false,
      comment: null,
    });
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<MutationFixture> {
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

  const viewer = await prismaClient.user.findUniqueOrThrow({
    where: {
      email: DEFAULT_ADMIN_EMAIL,
    },
  });

  const states = await prismaClient.workflowState.findMany({
    where: {
      teamId: team.id,
    },
  });

  const labels = await prismaClient.issueLabel.findMany({
    where: {
      name: {
        in: ['Bug', 'Feature', 'blocked', 'task'],
      },
    },
    orderBy: {
      name: 'asc',
    },
  });

  const parentIssue = await prismaClient.issue.create({
    data: {
      identifier: 'INV-1',
      title: 'Parent issue',
      description: 'Used for parent update tests.',
      teamId: team.id,
      stateId: findStateByName(states, 'Backlog').id,
      labels: {
        connect: [{ id: labels.find((label) => label.name === 'Feature')!.id }],
      },
    },
  });

  const issue = await prismaClient.issue.create({
    data: {
      identifier: 'INV-2',
      title: 'Mutable issue',
      description: 'Initial description',
      teamId: team.id,
      stateId: findStateByName(states, 'Ready').id,
      labels: {
        connect: [{ id: labels.find((label) => label.name === 'Feature')!.id }],
      },
    },
  });

  await prismaClient.team.update({
    where: {
      id: team.id,
    },
    data: {
      nextIssueNumber: 3,
    },
  });

  const otherTeam = await createTeamWithStates(prismaClient, {
    key: 'OPS',
    name: 'Operations',
  });

  const otherTeamStates = await prismaClient.workflowState.findMany({
    where: {
      teamId: otherTeam.id,
    },
  });

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
    },
    labelsByName: new Map(labels.map((label) => [label.name, label] as const)),
    otherTeam,
    otherTeamReadyState: findStateByName(otherTeamStates, 'Ready'),
    parentIssue: {
      id: parentIssue.id,
      identifier: parentIssue.identifier,
    },
    states: {
      backlog: findStateByName(states, 'Backlog'),
      inProgress: findStateByName(states, 'In Progress'),
      ready: findStateByName(states, 'Ready'),
    },
    team,
    viewer,
  };
}

function findStateByName(states: WorkflowState[], name: string): WorkflowState {
  const state = states.find((candidate) => candidate.name === name);

  if (!state) {
    throw new Error(`Expected workflow state "${name}" to exist.`);
  }

  return state;
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
    data: ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done', 'Canceled'].map(
      (stateName) => ({
        name: stateName,
        teamId: team.id,
      }),
    ),
  });

  return team;
}

async function postGraphQL({
  query,
  variables,
}: {
  query: string;
  variables?: Record<string, unknown>;
}): Promise<{ body: any; status: number }> {
  const response = await fetch(`${server.url}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  return {
    body: await response.json(),
    status: response.status,
  };
}
