import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ADMIN_EMAIL,
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

interface IssueFilterFixture {
  otherTeam: Team;
  otherUser: User;
  issues: {
    blockedTask: { id: string; identifier: string };
    child: { id: string; identifier: string };
    inProgressTask: { id: string; identifier: string };
    noLabels: { id: string; identifier: string };
    otherTeamTask: { id: string; identifier: string };
    otherUserTask: { id: string; identifier: string };
    parentTask: { id: string; identifier: string };
    unassignedTask: { id: string; identifier: string };
    viewerEpic: { id: string; identifier: string };
  };
  team: Team;
  viewer: User;
}

describe('issues query filtering', () => {
  let server: StartedServer;
  let fixture: IssueFilterFixture;

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

  it('limits results with first and always returns children nodes arrays', async () => {
    const response = await queryIssues({
      first: 2,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.nodes).toHaveLength(2);
    expect(response.body.data.issues.nodes).toEqual([
      expect.objectContaining({
        id: fixture.issues.viewerEpic.id,
        identifier: fixture.issues.viewerEpic.identifier,
        children: {
          nodes: [],
        },
      }),
      expect.objectContaining({
        id: fixture.issues.otherTeamTask.id,
        identifier: fixture.issues.otherTeamTask.identifier,
        children: {
          nodes: [],
        },
      }),
    ]);
  });

  it('filters issues by team.key.eq', async () => {
    const response = await queryIssues({
      filter: {
        team: {
          key: {
            eq: fixture.otherTeam.key,
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.nodes).toHaveLength(1);
    expect(response.body.data.issues.nodes).toEqual([
      expect.objectContaining({
        id: fixture.issues.otherTeamTask.id,
        team: {
          key: fixture.otherTeam.key,
        },
      }),
    ]);
  });

  it('filters issues by state.name.eq', async () => {
    const response = await queryIssues({
      filter: {
        state: {
          name: {
            eq: 'In Progress',
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.nodes).toEqual([
      expect.objectContaining({
        id: fixture.issues.inProgressTask.id,
        state: {
          name: 'In Progress',
        },
      }),
    ]);
  });

  it('filters issues by assignee.isMe.eq true and excludes unassigned issues', async () => {
    const response = await queryIssues({
      filter: {
        assignee: {
          isMe: {
            eq: true,
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();

    const identifiers = response.body.data.issues.nodes.map(
      (issue: { identifier: string }) => issue.identifier,
    );

    expect(identifiers).toEqual([
      fixture.issues.viewerEpic.identifier,
      fixture.issues.otherTeamTask.identifier,
      fixture.issues.inProgressTask.identifier,
      fixture.issues.noLabels.identifier,
      fixture.issues.blockedTask.identifier,
      fixture.issues.parentTask.identifier,
    ]);
    expect(identifiers).not.toContain(fixture.issues.unassignedTask.identifier);
    expect(identifiers).not.toContain(fixture.issues.otherUserTask.identifier);
    expect(response.body.data.issues.nodes).toSatisfy(
      (issues: Array<{ assignee: { isMe: boolean } | null }>) =>
        issues.every((issue) => issue.assignee?.isMe === true),
    );
  });

  it('filters issues by labels.some.name.in', async () => {
    const response = await queryIssues({
      filter: {
        labels: {
          some: {
            name: {
              in: ['task', 'epic'],
            },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.nodes.map((issue: { identifier: string }) => issue.identifier)).toEqual([
      fixture.issues.viewerEpic.identifier,
      fixture.issues.otherTeamTask.identifier,
      fixture.issues.inProgressTask.identifier,
      fixture.issues.otherUserTask.identifier,
      fixture.issues.unassignedTask.identifier,
      fixture.issues.blockedTask.identifier,
      fixture.issues.parentTask.identifier,
    ]);
  });

  it('filters issues by labels.every.name.nin and allows issues with no labels', async () => {
    const response = await queryIssues({
      filter: {
        labels: {
          every: {
            name: {
              nin: ['blocked'],
            },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();

    const byIdentifier = new Map(
      response.body.data.issues.nodes.map((issue: { identifier: string }) => [issue.identifier, issue] as const),
    );

    expect(byIdentifier.has(fixture.issues.blockedTask.identifier)).toBe(false);
    expect(byIdentifier.get(fixture.issues.noLabels.identifier)).toMatchObject({
      assignee: {
        isMe: true,
      },
      labels: {
        nodes: [],
      },
    });
  });

  it('applies compound and filters conjunctively', async () => {
    const response = await queryIssues({
      filter: {
        and: [
          {
            team: {
              key: {
                eq: DEFAULT_TEAM_KEY,
              },
            },
          },
          {
            state: {
              name: {
                eq: 'Ready',
              },
            },
          },
          {
            assignee: {
              isMe: {
                eq: true,
              },
            },
          },
          {
            labels: {
              some: {
                name: {
                  in: ['task'],
                },
              },
            },
          },
          {
            labels: {
              every: {
                name: {
                  nin: ['blocked', 'needs-clarification'],
                },
              },
            },
          },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.nodes).toEqual([
      expect.objectContaining({
        id: fixture.issues.parentTask.id,
        identifier: fixture.issues.parentTask.identifier,
        state: expect.objectContaining({
          name: 'Ready',
        }),
        team: expect.objectContaining({
          key: DEFAULT_TEAM_KEY,
        }),
        assignee: expect.objectContaining({
          isMe: true,
        }),
        labels: {
          nodes: [{ name: 'Feature' }, { name: 'task' }],
        },
      }),
    ]);
  });

  it('returns an empty result set when labels.some.name.in is empty', async () => {
    const response = await queryIssues({
      filter: {
        labels: {
          some: {
            name: {
              in: [],
            },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        issues: {
          nodes: [],
        },
      },
    });
  });

  it('treats labels.every.name.nin with an empty array as a no-op', async () => {
    const unfilteredResponse = await queryIssues({
      first: 20,
    });
    const filteredResponse = await queryIssues({
      first: 20,
      filter: {
        labels: {
          every: {
            name: {
              nin: [],
            },
          },
        },
      },
    });

    expect(filteredResponse.status).toBe(200);
    expect(filteredResponse.body.errors).toBeUndefined();
    expect(filteredResponse.body.data.issues.nodes).toEqual(unfilteredResponse.body.data.issues.nodes);
  });

  it('treats a single-condition and filter the same as a direct filter', async () => {
    const directResponse = await queryIssues({
      first: 20,
      filter: {
        team: {
          key: {
            eq: DEFAULT_TEAM_KEY,
          },
        },
      },
    });
    const andResponse = await queryIssues({
      first: 20,
      filter: {
        and: [
          {
            team: {
              key: {
                eq: DEFAULT_TEAM_KEY,
              },
            },
          },
        ],
      },
    });

    expect(andResponse.status).toBe(200);
    expect(andResponse.body.errors).toBeUndefined();
    expect(andResponse.body.data.issues.nodes).toEqual(directResponse.body.data.issues.nodes);
  });

  it('returns empty nodes for a non-matching filter', async () => {
    const response = await queryIssues({
      filter: {
        state: {
          name: {
            eq: 'Does Not Exist',
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        issues: {
          nodes: [],
        },
      },
    });
  });

  it('returns null assignee values for unassigned issues', async () => {
    const response = await queryIssues({
      filter: {
        team: {
          key: {
            eq: DEFAULT_TEAM_KEY,
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(
      response.body.data.issues.nodes.find(
        (issue: { identifier: string }) => issue.identifier === fixture.issues.unassignedTask.identifier,
      ),
    ).toMatchObject({
      identifier: fixture.issues.unassignedTask.identifier,
      assignee: null,
    });
  });

  it('returns newest matching team issues first so fresh large-team items are not hidden behind take limits', async () => {
    const recentTeam = await createTeamWithStates(prisma, {
      key: 'SON',
      name: 'Songwork',
    });
    const recentBacklog = await prisma.workflowState.findFirstOrThrow({
      where: {
        teamId: recentTeam.id,
        name: 'Backlog',
      },
    });

    await prisma.issue.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        identifier: `SON-${index + 1}`,
        title: `Songwork issue ${index + 1}`,
        description: `Large team issue ${index + 1}`,
        teamId: recentTeam.id,
        stateId: recentBacklog.id,
        createdAt: new Date(`2025-02-${String((index % 27) + 1).padStart(2, '0')}T08:00:00.000Z`),
        updatedAt: new Date(`2025-02-${String((index % 27) + 1).padStart(2, '0')}T08:00:00.000Z`),
      })),
    });

    const newestIssue = await prisma.issue.create({
      data: {
        identifier: 'SON-206',
        title: 'Newest Songwork issue',
        description: 'Should remain visible within first 200 team results.',
        teamId: recentTeam.id,
        stateId: recentBacklog.id,
        createdAt: new Date('2025-03-31T12:00:00.000Z'),
        updatedAt: new Date('2025-03-31T12:00:00.000Z'),
      },
    });

    const response = await queryIssues({
      first: 200,
      filter: {
        team: {
          key: {
            eq: recentTeam.key,
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.nodes).toHaveLength(200);
    expect(response.body.data.issues.nodes[0]).toMatchObject({
      id: newestIssue.id,
      identifier: newestIssue.identifier,
    });
    expect(
      response.body.data.issues.nodes.some(
        (issue: { identifier: string }) => issue.identifier === newestIssue.identifier,
      ),
    ).toBe(true);
    expect(
      response.body.data.issues.nodes.some(
        (issue: { identifier: string }) => issue.identifier === 'SON-1',
      ),
    ).toBe(false);
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<IssueFilterFixture> {
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

  const otherUser = await prismaClient.user.create({
    data: {
      email: 'teammate@involute.local',
      name: 'Teammate User',
    },
  });

  const otherTeam = await createTeamWithStates(prismaClient, {
    key: 'OPS',
    name: 'Operations',
  });

  const teamStates = await prismaClient.workflowState.findMany({
    where: {
      teamId: team.id,
    },
  });
  const otherTeamStates = await prismaClient.workflowState.findMany({
    where: {
      teamId: otherTeam.id,
    },
  });

  const readyState = findStateByName(teamStates, 'Ready');
  const backlogState = findStateByName(teamStates, 'Backlog');
  const inProgressState = findStateByName(teamStates, 'In Progress');
  const otherReadyState = findStateByName(otherTeamStates, 'Ready');

  const labels = await prismaClient.issueLabel.findMany({
    where: {
      name: {
        in: ['Feature', 'blocked', 'epic', 'task'],
      },
    },
  });

  const labelIdsByName = new Map(labels.map((label) => [label.name, label.id] as const));

  const parentTask = await prismaClient.issue.create({
    data: {
      identifier: 'INV-1',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Viewer ready task',
      description: 'The canonical issue that should match the compound filter.',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      labels: {
        connect: [
          { id: labelIdsByName.get('Feature')! },
          { id: labelIdsByName.get('task')! },
        ],
      },
    },
  });

  const child = await prismaClient.issue.create({
    data: {
      identifier: 'INV-2',
      teamId: team.id,
      stateId: backlogState.id,
      parentId: parentTask.id,
      title: 'Child issue',
      description: 'Nested under the viewer task.',
      createdAt: new Date('2025-01-01T00:01:00.000Z'),
    },
  });

  const blockedTask = await prismaClient.issue.create({
    data: {
      identifier: 'INV-3',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Blocked viewer task',
      description: 'Should be excluded by labels.every.name.nin.',
      createdAt: new Date('2025-01-01T00:02:00.000Z'),
      labels: {
        connect: [
          { id: labelIdsByName.get('blocked')! },
          { id: labelIdsByName.get('task')! },
        ],
      },
    },
  });

  const noLabels = await prismaClient.issue.create({
    data: {
      identifier: 'INV-4',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Viewer issue with no labels',
      description: 'Should pass the every.nin exclusion filter.',
      createdAt: new Date('2025-01-01T00:03:00.000Z'),
    },
  });

  const unassignedTask = await prismaClient.issue.create({
    data: {
      identifier: 'INV-5',
      teamId: team.id,
      stateId: readyState.id,
      title: 'Unassigned ready task',
      description: 'Should not match assignee.isMe.',
      createdAt: new Date('2025-01-01T00:04:00.000Z'),
      labels: {
        connect: [{ id: labelIdsByName.get('task')! }],
      },
    },
  });

  const otherUserTask = await prismaClient.issue.create({
    data: {
      identifier: 'INV-6',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: otherUser.id,
      title: 'Other user task',
      description: 'Assigned to someone else.',
      createdAt: new Date('2025-01-01T00:05:00.000Z'),
      labels: {
        connect: [{ id: labelIdsByName.get('task')! }],
      },
    },
  });

  const inProgressTask = await prismaClient.issue.create({
    data: {
      identifier: 'INV-7',
      teamId: team.id,
      stateId: inProgressState.id,
      assigneeId: viewer.id,
      title: 'Viewer in-progress task',
      description: 'Should only match the state filter.',
      createdAt: new Date('2025-01-01T00:06:00.000Z'),
      labels: {
        connect: [{ id: labelIdsByName.get('task')! }],
      },
    },
  });

  const otherTeamTask = await prismaClient.issue.create({
    data: {
      identifier: 'OPS-1',
      teamId: otherTeam.id,
      stateId: otherReadyState.id,
      assigneeId: viewer.id,
      title: 'Other team viewer task',
      description: 'Matches isMe but not the default team filter.',
      createdAt: new Date('2025-01-01T00:07:00.000Z'),
      labels: {
        connect: [{ id: labelIdsByName.get('task')! }],
      },
    },
  });

  const viewerEpic = await prismaClient.issue.create({
    data: {
      identifier: 'INV-8',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Viewer epic issue',
      description: 'Matches labels.some.name.in when epic is present.',
      createdAt: new Date('2025-01-01T00:08:00.000Z'),
      labels: {
        connect: [{ id: labelIdsByName.get('epic')! }],
      },
    },
  });

  return {
    otherTeam,
    otherUser,
    issues: {
      blockedTask: pickIssue(blockedTask),
      child: pickIssue(child),
      inProgressTask: pickIssue(inProgressTask),
      noLabels: pickIssue(noLabels),
      otherTeamTask: pickIssue(otherTeamTask),
      otherUserTask: pickIssue(otherUserTask),
      parentTask: pickIssue(parentTask),
      unassignedTask: pickIssue(unassignedTask),
      viewerEpic: pickIssue(viewerEpic),
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

function pickIssue(issue: { id: string; identifier: string }) {
  return {
    id: issue.id,
    identifier: issue.identifier,
  };
}

async function queryIssues({
  first = 20,
  filter,
}: {
  first?: number;
  filter?: Record<string, unknown>;
}) {
  return postGraphQL({
    query: `
      query($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter) {
          nodes {
            id
            identifier
            team { key }
            state { name }
            assignee { id isMe }
            labels { nodes { name } }
            children { nodes { id } }
          }
        }
      }
    `,
    variables: {
      first,
      filter,
    },
    token: `Bearer ${TEST_AUTH_TOKEN}`,
  });
}

async function postGraphQL({
  query,
  variables,
  token,
}: {
  query: string;
  variables?: Record<string, unknown>;
  token?: string;
}): Promise<{ body: any; status: number }> {
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
    body: await response.json(),
    status: response.status,
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
