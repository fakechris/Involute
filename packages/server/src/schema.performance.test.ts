import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const TEST_AUTH_TOKEN = 'test-auth-token';

describe('schema query performance', () => {
  const prisma = new PrismaClientConstructor({
    log: [{ emit: 'event', level: 'query' }],
  });
  const executedQueries: string[] = [];
  let server: StartedServer;
  let adminId: string;
  let defaultTeamId: string;
  let readyStateId: string;

  beforeAll(async () => {
    prisma.$on('query', (event) => {
      executedQueries.push(event.query);
    });

    await prisma.$connect();
    server = await startServer({
      allowAdminFallback: true,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
      prisma,
    });
  });

  afterAll(async () => {
    await server.stop();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    executedQueries.length = 0;

    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();

    await seedDatabase(prisma);

    const admin = await prisma.user.findFirstOrThrow();
    const team = await prisma.team.findFirstOrThrow();
    const readyState = await prisma.workflowState.findFirstOrThrow({
      where: {
        name: 'Ready',
        teamId: team.id,
      },
    });

    adminId = admin.id;
    defaultTeamId = team.id;
    readyStateId = readyState.id;

    await seedBoardFixture(prisma, {
      adminId,
      readyStateId,
      teamId: defaultTeamId,
    });
    executedQueries.length = 0;
  });

  it('keeps board query count effectively flat as the issue list grows', async () => {
    const baseline = await runBoardQuery(server, executedQueries);

    await seedBoardFixture(prisma, {
      adminId,
      readyStateId,
      startNumber: 200,
      teamId: defaultTeamId,
      totalIssues: 18,
    });

    const expanded = await runBoardQuery(server, executedQueries);

    expect(baseline.issueCount).toBe(19);
    expect(expanded.issueCount).toBe(38);
    expect(baseline.queryCount).toBeLessThanOrEqual(20);
    expect(expanded.queryCount).toBeLessThanOrEqual(baseline.queryCount + 1);
  });
});

async function seedBoardFixture(
  prisma: PrismaClientConstructor,
  options: { adminId: string; readyStateId: string; startNumber?: number; teamId: string; totalIssues?: number },
): Promise<void> {
  const parentIssue = await prisma.issue.create({
    data: {
      assigneeId: options.adminId,
      identifier: `INV-${options.startNumber ?? 100}`,
      stateId: options.readyStateId,
      teamId: options.teamId,
      title: 'Parent performance issue',
    },
  });

  const totalIssues = options.totalIssues ?? 18;
  const startNumber = options.startNumber ?? 1;

  for (let index = 0; index < totalIssues; index += 1) {
    const issue = await prisma.issue.create({
      data: {
        assigneeId: options.adminId,
        identifier: `INV-${startNumber + index + 1}`,
        parentId: index % 3 === 0 ? parentIssue.id : null,
        stateId: options.readyStateId,
        teamId: options.teamId,
        title: `Performance issue ${index + 1}`,
      },
    });

    await prisma.comment.create({
      data: {
        body: `Comment for issue ${index + 1}`,
        issueId: issue.id,
        userId: options.adminId,
      },
    });
  }
}

async function postGraphQL(
  server: StartedServer,
  {
    query,
    token,
    variables,
  }: {
    query: string;
    token?: string;
    variables?: Record<string, unknown>;
  },
): Promise<{ body: Record<string, any>; status: number }> {
  const response = await fetch(`${server.url}/graphql`, {
    body: JSON.stringify({
      query,
      variables,
    }),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
    },
    method: 'POST',
  });

  return {
    body: (await response.json()) as Record<string, any>,
    status: response.status,
  };
}

async function runBoardQuery(
  server: StartedServer,
  executedQueries: string[],
): Promise<{ issueCount: number; queryCount: number }> {
  executedQueries.length = 0;

  const response = await postGraphQL(server, {
    query: `
      query BoardPerformance($first: Int!) {
        teams {
          nodes {
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
        users {
          nodes {
            id
            name
          }
        }
        issueLabels {
          nodes {
            id
            name
          }
        }
        issues(first: $first) {
          nodes {
            id
            identifier
            title
            state {
              id
              name
            }
            team {
              id
              key
            }
            assignee {
              id
              name
            }
            labels {
              nodes {
                id
                name
              }
            }
            parent {
              id
              identifier
            }
            children {
              nodes {
                id
                identifier
              }
            }
            comments(first: 100, orderBy: createdAt) {
              nodes {
                id
                body
                user {
                  id
                  email
                }
              }
            }
          }
        }
      }
    `,
    token: `Bearer ${TEST_AUTH_TOKEN}`,
    variables: {
      first: 80,
    },
  });

  expect(response.status).toBe(200);
  expect(response.body.errors).toBeUndefined();

  return {
    issueCount: response.body.data.issues.nodes.length,
    queryCount: executedQueries.length,
  };
}
