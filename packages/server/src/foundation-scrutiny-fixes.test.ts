import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_NAME } from '../prisma/constants.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { seedDatabase } from '../prisma/seed-helpers.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

describe('foundation scrutiny fixes', () => {
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
    await resetDatabase(prisma);
  });

  it('centrally rejects unauthenticated root operations including __typename', async () => {
    const response = await postGraphQL({
      query: '{ __typename }',
    });

    expect(response.status).toBe(200);
    expect(response.body.errors?.[0]?.message).toBe('Not authenticated');
  });

  it('masks unexpected internal errors', async () => {
    const findManySpy = vi
      .spyOn(prisma.team, 'findMany')
      .mockRejectedValueOnce(new Error('database credentials leaked'));

    const response = await postGraphQL({
      query: '{ teams { nodes { id } } }',
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(response.body.errors?.[0]?.message).toBe('Unexpected error.');
    expect(JSON.stringify(response.body.errors)).not.toContain('database credentials leaked');

    findManySpy.mockRestore();
  });

  it('rejects issueCreate when the provided state belongs to another team', async () => {
    const fixture = await createTwoTeamFixture(prisma);

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
          teamId: fixture.primaryTeam.id,
          stateId: fixture.secondaryBacklogState.id,
          title: 'Cross-team create attempt',
        },
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(response.body.errors?.[0]?.message).toBe(
      'Workflow state does not belong to the specified team.',
    );
  });

  it('rejects issueUpdate when the new state belongs to another team', async () => {
    const fixture = await createTwoTeamFixture(prisma);

    const issue = await prisma.issue.create({
      data: {
        identifier: 'INV-1',
        teamId: fixture.primaryTeam.id,
        stateId: fixture.primaryBacklogState.id,
        title: 'Update validation issue',
      },
    });

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
        id: issue.id,
        input: {
          stateId: fixture.secondaryBacklogState.id,
        },
      },
      token: `Bearer ${TEST_AUTH_TOKEN}`,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toBeNull();
    expect(response.body.errors?.[0]?.message).toBe(
      'Workflow state does not belong to the issue team.',
    );
  });

  it('creates TEAMKEY-N identifiers atomically without any seed-installed trigger', async () => {
    const manualFixture = await createManualFixtureWithoutSeed(prisma);

    await dropIdentifierTrigger(prisma);

    const createMutation = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            state { name }
          }
        }
      }
    `;

    const [firstResponse, secondResponse] = await Promise.all([
      postGraphQL({
        query: createMutation,
        variables: {
          input: {
            teamId: manualFixture.team.id,
            title: 'First application-created issue',
          },
        },
        token: `Bearer ${TEST_AUTH_TOKEN}`,
      }),
      postGraphQL({
        query: createMutation,
        variables: {
          input: {
            teamId: manualFixture.team.id,
            title: 'Second application-created issue',
          },
        },
        token: `Bearer ${TEST_AUTH_TOKEN}`,
      }),
    ]);

    expect(firstResponse.body.errors).toBeUndefined();
    expect(secondResponse.body.errors).toBeUndefined();

    const identifiers = [
      firstResponse.body.data.issueCreate.issue.identifier,
      secondResponse.body.data.issueCreate.issue.identifier,
    ].sort();

    expect(identifiers).toEqual(['APP-1', 'APP-2']);
    expect(firstResponse.body.data.issueCreate.issue.state.name).toBe('Backlog');
    expect(secondResponse.body.data.issueCreate.issue.state.name).toBe('Backlog');

    const updatedTeam = await prisma.team.findUniqueOrThrow({
      where: {
        id: manualFixture.team.id,
      },
    });

    expect(updatedTeam.nextIssueNumber).toBe(3);
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
}

async function createTwoTeamFixture(prismaClient: PrismaClient): Promise<{
  primaryBacklogState: WorkflowState;
  primaryTeam: Team;
  secondaryBacklogState: WorkflowState;
}> {
  await seedDatabase(prismaClient);

  const primaryTeam = await prismaClient.team.findUniqueOrThrow({
    where: {
      key: 'INV',
    },
  });

  const primaryBacklogState = await prismaClient.workflowState.findFirstOrThrow({
    where: {
      teamId: primaryTeam.id,
      name: 'Backlog',
    },
  });

  const secondaryTeam = await prismaClient.team.create({
    data: {
      key: 'OPS',
      name: 'Operations',
    },
  });

  const secondaryBacklogState = await prismaClient.workflowState.create({
    data: {
      name: 'Backlog',
      teamId: secondaryTeam.id,
    },
  });

  return {
    primaryBacklogState,
    primaryTeam,
    secondaryBacklogState,
  };
}

async function createManualFixtureWithoutSeed(prismaClient: PrismaClient): Promise<{
  admin: User;
  team: Team;
}> {
  const admin = await prismaClient.user.create({
    data: {
      email: DEFAULT_ADMIN_EMAIL,
      name: DEFAULT_ADMIN_NAME,
    },
  });

  const team = await prismaClient.team.create({
    data: {
      key: 'APP',
      name: 'Application Team',
    },
  });

  await prismaClient.workflowState.create({
    data: {
      name: 'Ready',
      teamId: team.id,
    },
  });

  await prismaClient.workflowState.create({
    data: {
      name: 'Backlog',
      teamId: team.id,
    },
  });

  return {
    admin,
    team,
  };
}

async function dropIdentifierTrigger(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS assign_issue_identifier_before_insert ON "Issue";',
  );
  await prismaClient.$executeRawUnsafe('DROP FUNCTION IF EXISTS assign_issue_identifier();');
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
  const response = await fetch(`${server.url}/graphql`, {
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
