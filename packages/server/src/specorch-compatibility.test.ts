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

const SPECORCH_Q1 = `
query($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { name }
    labels { nodes { name } }
    assignee { name email }
  }
}
`;

const SPECORCH_Q2 = `
query($first: Int!, $teamKey: String!, $filterState: String!) {
  issues(
    filter: {
      and: [
        { team: { key: { eq: $teamKey } } }
        { state: { name: { eq: $filterState } } }
        { assignee: { isMe: { eq: true } } }
        { labels: { some: { name: { in: ["task"] } } } }
        { labels: { every: { name: { nin: ["blocked", "needs-clarification"] } } } }
      ]
    }
    first: $first
  ) {
    nodes {
      id identifier title description
      state { name }
      labels { nodes { name } }
      assignee { name email }
      children { nodes { id } }
      parent { id identifier title }
    }
  }
}
`;

const SPECORCH_Q3 = `
query($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
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
`;

const SPECORCH_Q4 = `
query($key: String!) {
  teams(filter: { key: { eq: $key } }) {
    nodes { id }
  }
}
`;

const SPECORCH_Q5 = `
query($issueId: String!) {
  issue(id: $issueId) {
    team {
      states { nodes { id name } }
    }
  }
}
`;

const SPECORCH_Q6 = `
query {
  teams {
    nodes {
      key
      name
      states { nodes { name } }
    }
  }
}
`;

const SPECORCH_Q7 = `
query($name: String!) {
  issueLabels(filter: { name: { eq: $name } }) {
    nodes { id name }
  }
}
`;

const SPECORCH_M1 = `
mutation($teamId: String!, $title: String!, $description: String) {
  issueCreate(input: {
    teamId: $teamId
    title: $title
    description: $description
  }) {
    success
    issue { id identifier title }
  }
}
`;

const SPECORCH_M2 = `
mutation($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id state { name } }
  }
}
`;

const SPECORCH_M3 = `
mutation($id: String!, $labelIds: [String!]!) {
  issueUpdate(id: $id, input: { labelIds: $labelIds }) {
    success
  }
}
`;

const SPECORCH_M4 = `
mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
  }
}
`;

const SPECORCH_M5 = `
mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id body }
  }
}
`;

let server: StartedServer;

interface SpecOrchFixture {
  labelsByName: Map<string, { id: string; name: string }>;
  otherTeam: Team;
  otherUser: User;
  pollTarget: { id: string; identifier: string };
  pollTargetChild: { id: string };
  states: {
    inProgress: WorkflowState;
    ready: WorkflowState;
  };
  team: Team;
  viewer: User;
}

describe('specorch GraphQL compatibility', () => {
  let fixture: SpecOrchFixture;

  beforeAll(async () => {
    await prisma.$connect();
    server = await startServer({
      allowAdminFallback: true,
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

  it('replays the exact specorch daemon poll → claim → comment → verify flow', async () => {
    const pollResponse = await postGraphQL({
      query: SPECORCH_Q2,
      variables: {
        first: 10,
        teamKey: DEFAULT_TEAM_KEY,
        filterState: 'Ready',
      },
    });

    expectGraphQLSuccess(pollResponse);
    expect(pollResponse.body.data.issues.nodes).toEqual([
      {
        id: fixture.pollTarget.id,
        identifier: fixture.pollTarget.identifier,
        title: 'Daemon-ready task',
        description: 'The only issue that should satisfy the daemon polling filter.',
        state: {
          name: 'Ready',
        },
        labels: {
          nodes: [{ name: 'Feature' }, { name: 'task' }],
        },
        assignee: {
          name: fixture.viewer.name,
          email: fixture.viewer.email,
        },
        parent: null,
        children: {
          nodes: [{ id: fixture.pollTargetChild.id }],
        },
      },
    ]);

    const readIssueResponse = await postGraphQL({
      query: SPECORCH_Q1,
      variables: {
        id: fixture.pollTarget.id,
      },
    });

    expectGraphQLSuccess(readIssueResponse);
    expect(readIssueResponse.body.data.issue).toEqual({
      id: fixture.pollTarget.id,
      identifier: fixture.pollTarget.identifier,
      title: 'Daemon-ready task',
      description: 'The only issue that should satisfy the daemon polling filter.',
      state: {
        name: 'Ready',
      },
      labels: {
        nodes: [{ name: 'Feature' }, { name: 'task' }],
      },
      assignee: {
        name: fixture.viewer.name,
        email: fixture.viewer.email,
      },
    });

    const statesResponse = await postGraphQL({
      query: SPECORCH_Q5,
      variables: {
        issueId: fixture.pollTarget.id,
      },
    });

    expectGraphQLSuccess(statesResponse);
    expect(statesResponse.body.data.issue.team.states.nodes).toEqual(
      DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({
        id:
          name === 'Ready'
            ? fixture.states.ready.id
            : name === 'In Progress'
              ? fixture.states.inProgress.id
              : expect.any(String),
        name,
      })),
    );

    const inProgressStateId = statesResponse.body.data.issue.team.states.nodes.find(
      (state: { id: string; name: string }) => state.name === 'In Progress',
    )?.id;

    expect(inProgressStateId).toBe(fixture.states.inProgress.id);

    const claimResponse = await postGraphQL({
      query: SPECORCH_M2,
      variables: {
        issueId: fixture.pollTarget.id,
        stateId: fixture.states.inProgress.id,
      },
    });

    expectGraphQLSuccess(claimResponse);
    expect(claimResponse.body.data.issueUpdate).toEqual({
      success: true,
      issue: {
        id: fixture.pollTarget.id,
        state: {
          name: 'In Progress',
        },
      },
    });

    const commentBody = 'SpecOrch daemon claimed this issue for execution.';
    const commentCreateResponse = await postGraphQL({
      query: SPECORCH_M5,
      variables: {
        issueId: fixture.pollTarget.id,
        body: commentBody,
      },
    });

    expectGraphQLSuccess(commentCreateResponse);
    expect(commentCreateResponse.body.data.commentCreate).toEqual({
      success: true,
      comment: {
        id: expect.any(String),
        body: commentBody,
      },
    });

    const commentsResponse = await postGraphQL({
      query: SPECORCH_Q3,
      variables: {
        issueId: fixture.pollTarget.id,
        first: 10,
      },
    });

    expectGraphQLSuccess(commentsResponse);
    expect(commentsResponse.body.data.issue.comments.nodes).toEqual([
      {
        id: expect.any(String),
        body: 'Initial daemon context comment',
        createdAt: '2025-01-15T10:30:00.000Z',
        user: {
          id: fixture.viewer.id,
          name: fixture.viewer.name,
          email: fixture.viewer.email,
        },
      },
      {
        id: commentCreateResponse.body.data.commentCreate.comment.id,
        body: commentBody,
        createdAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
        user: {
          id: fixture.viewer.id,
          name: fixture.viewer.name,
          email: fixture.viewer.email,
        },
      },
    ]);

    const updatedIssue = await prisma.issue.findUniqueOrThrow({
      where: {
        id: fixture.pollTarget.id,
      },
      include: {
        state: true,
      },
    });

    expect(updatedIssue.state.name).toBe('In Progress');
  });

  it('executes the remaining exact specorch query and mutation shapes without modification', async () => {
    const teamResponse = await postGraphQL({
      query: SPECORCH_Q4,
      variables: {
        key: DEFAULT_TEAM_KEY,
      },
    });

    expectGraphQLSuccess(teamResponse);
    expect(teamResponse.body.data.teams.nodes).toEqual([{ id: fixture.team.id }]);

    const createResponse = await postGraphQL({
      query: SPECORCH_M1,
      variables: {
        teamId: fixture.team.id,
        title: 'Promoted child issue',
        description: 'Created through the exact SpecOrch issueCreate mutation.',
      },
    });

    expectGraphQLSuccess(createResponse);
    expect(createResponse.body.data.issueCreate).toEqual({
      success: true,
      issue: {
        id: expect.any(String),
        identifier: 'INV-7',
        title: 'Promoted child issue',
      },
    });

    const createdIssueId = createResponse.body.data.issueCreate.issue.id as string;

    const labelResponse = await postGraphQL({
      query: SPECORCH_Q7,
      variables: {
        name: 'task',
      },
    });

    expectGraphQLSuccess(labelResponse);
    expect(labelResponse.body.data.issueLabels.nodes).toEqual([
      {
        id: fixture.labelsByName.get('task')?.id,
        name: 'task',
      },
    ]);

    const addLabelResponse = await postGraphQL({
      query: SPECORCH_M3,
      variables: {
        id: createdIssueId,
        labelIds: [fixture.labelsByName.get('task')!.id],
      },
    });

    expectGraphQLSuccess(addLabelResponse);
    expect(addLabelResponse.body.data.issueUpdate).toEqual({
      success: true,
    });

    const promoteResponse = await postGraphQL({
      query: SPECORCH_M4,
      variables: {
        id: createdIssueId,
        input: {
          labelIds: [fixture.labelsByName.get('Feature')!.id],
          parentId: fixture.pollTarget.id,
        },
      },
    });

    expectGraphQLSuccess(promoteResponse);
    expect(promoteResponse.body.data.issueUpdate).toEqual({
      success: true,
    });

    const promotedIssue = await prisma.issue.findUniqueOrThrow({
      where: {
        id: createdIssueId,
      },
      include: {
        labels: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    expect(promotedIssue.parentId).toBe(fixture.pollTarget.id);
    expect(promotedIssue.labels.map((label) => label.name)).toEqual(['Feature']);

    const teamsResponse = await postGraphQL({
      query: SPECORCH_Q6,
    });

    expectGraphQLSuccess(teamsResponse);
    expect(teamsResponse.body.data.teams.nodes).toEqual([
      {
        key: DEFAULT_TEAM_KEY,
        name: fixture.team.name,
        states: {
          nodes: DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({ name })),
        },
      },
      {
        key: fixture.otherTeam.key,
        name: fixture.otherTeam.name,
        states: {
          nodes: DEFAULT_WORKFLOW_STATE_NAMES.map((name) => ({ name })),
        },
      },
    ]);
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<SpecOrchFixture> {
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
      email: 'specorch-teammate@involute.local',
      name: 'SpecOrch Teammate',
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
    orderBy: {
      name: 'asc',
    },
  });

  const otherTeamStates = await prismaClient.workflowState.findMany({
    where: {
      teamId: otherTeam.id,
    },
    orderBy: {
      name: 'asc',
    },
  });

  const readyState = findStateByName(teamStates, 'Ready');
  const backlogState = findStateByName(teamStates, 'Backlog');
  const inProgressState = findStateByName(teamStates, 'In Progress');
  const otherTeamReadyState = findStateByName(otherTeamStates, 'Ready');

  const labels = await prismaClient.issueLabel.findMany({
    where: {
      name: {
        in: ['Feature', 'blocked', 'needs-clarification', 'task'],
      },
    },
    orderBy: {
      name: 'asc',
    },
  });

  const labelsByName = new Map(labels.map((label) => [label.name, label] as const));

  const pollTarget = await prismaClient.issue.create({
    data: {
      identifier: 'INV-1',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Daemon-ready task',
      description: 'The only issue that should satisfy the daemon polling filter.',
      createdAt: new Date('2025-01-15T10:00:00.000Z'),
      labels: {
        connect: [
          { id: labelsByName.get('Feature')!.id },
          { id: labelsByName.get('task')!.id },
        ],
      },
    },
  });

  const pollTargetChild = await prismaClient.issue.create({
    data: {
      identifier: 'INV-2',
      teamId: team.id,
      stateId: backlogState.id,
      parentId: pollTarget.id,
      title: 'Daemon-ready task child',
      description: 'Provides a parent-child relationship for the compatibility suite.',
      createdAt: new Date('2025-01-15T10:05:00.000Z'),
    },
  });

  await prismaClient.issue.create({
    data: {
      identifier: 'INV-3',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Blocked ready task',
      description: 'Excluded because it is blocked.',
      createdAt: new Date('2025-01-15T10:10:00.000Z'),
      labels: {
        connect: [
          { id: labelsByName.get('blocked')!.id },
          { id: labelsByName.get('task')!.id },
        ],
      },
    },
  });

  await prismaClient.issue.create({
    data: {
      identifier: 'INV-4',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: viewer.id,
      title: 'Needs clarification task',
      description: 'Excluded because it still needs clarification.',
      createdAt: new Date('2025-01-15T10:15:00.000Z'),
      labels: {
        connect: [
          { id: labelsByName.get('needs-clarification')!.id },
          { id: labelsByName.get('task')!.id },
        ],
      },
    },
  });

  await prismaClient.issue.create({
    data: {
      identifier: 'INV-5',
      teamId: team.id,
      stateId: inProgressState.id,
      assigneeId: viewer.id,
      title: 'Already in progress task',
      description: 'Excluded by the Ready state filter.',
      createdAt: new Date('2025-01-15T10:20:00.000Z'),
      labels: {
        connect: [{ id: labelsByName.get('task')!.id }],
      },
    },
  });

  await prismaClient.issue.create({
    data: {
      identifier: 'INV-6',
      teamId: team.id,
      stateId: readyState.id,
      assigneeId: otherUser.id,
      title: 'Other user ready task',
      description: 'Excluded because it is not assigned to the authenticated user.',
      createdAt: new Date('2025-01-15T10:25:00.000Z'),
      labels: {
        connect: [{ id: labelsByName.get('task')!.id }],
      },
    },
  });

  await prismaClient.issue.create({
    data: {
      identifier: 'OPS-1',
      teamId: otherTeam.id,
      stateId: otherTeamReadyState.id,
      assigneeId: viewer.id,
      title: 'Other team ready task',
      description: 'Excluded because it belongs to a different team.',
      createdAt: new Date('2025-01-15T10:30:00.000Z'),
      labels: {
        connect: [{ id: labelsByName.get('task')!.id }],
      },
    },
  });

  await prismaClient.comment.create({
    data: {
      issueId: pollTarget.id,
      userId: viewer.id,
      body: 'Initial daemon context comment',
      createdAt: new Date('2025-01-15T10:30:00.000Z'),
    },
  });

  await prismaClient.team.update({
    where: {
      id: team.id,
    },
    data: {
      nextIssueNumber: 7,
    },
  });

  return {
    labelsByName,
    otherTeam,
    otherUser,
    pollTarget: {
      id: pollTarget.id,
      identifier: pollTarget.identifier,
    },
    pollTargetChild: {
      id: pollTargetChild.id,
    },
    states: {
      inProgress: inProgressState,
      ready: readyState,
    },
    team,
    viewer,
  };
}

function expectGraphQLSuccess(response: { body: any; status: number }) {
  expect(response.status).toBe(200);
  expect(response.body.errors).toBeUndefined();
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
    data: DEFAULT_WORKFLOW_STATE_NAMES.map((stateName) => ({
      name: stateName,
      teamId: team.id,
    })),
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
