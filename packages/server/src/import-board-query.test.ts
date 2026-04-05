import type { PrismaClient } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { runImportPipeline } from './import-pipeline.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';
let activeServer: StartedServer;

const teamsFixture = [{ id: 'team-son', key: 'SON', name: 'Sonata' }];
const workflowStatesFixture = [
  { id: 'state-backlog', name: 'Backlog', type: 'unstarted', position: 0, team: { id: 'team-son' } },
  { id: 'state-ready', name: 'Ready', type: 'started', position: 1, team: { id: 'team-son' } },
];
const labelsFixture = [{ id: 'label-feature', name: 'Feature', color: '#2563eb' }];
const usersFixture = [
  {
    id: 'user-alice',
    name: 'Alice Doe',
    email: 'alice@example.com',
    displayName: 'Alice Doe',
    active: true,
  },
];
const issuesFixture = [
  {
    id: 'linear-issue-1',
    identifier: 'SON-42',
    title: 'Imported parent issue',
    description: 'Parent issue for board query verification.',
    priority: 2,
    createdAt: '2024-06-01T10:00:00.000Z',
    updatedAt: '2024-06-02T15:00:00.000Z',
    state: { id: 'state-backlog', name: 'Backlog' },
    team: { id: 'team-son', key: 'SON' },
    assignee: { id: 'user-alice', name: 'Alice Doe', email: 'alice@example.com' },
    labels: { nodes: [{ id: 'label-feature', name: 'Feature' }] },
    parent: null,
  },
  {
    id: 'linear-issue-2',
    identifier: 'SON-43',
    title: 'Imported child issue',
    description: 'Child issue should keep its parent link.',
    priority: 1,
    createdAt: '2024-06-01T12:00:00.000Z',
    updatedAt: '2024-06-04T09:00:00.000Z',
    state: { id: 'state-ready', name: 'Ready' },
    team: { id: 'team-son', key: 'SON' },
    assignee: null,
    labels: { nodes: [] },
    parent: { id: 'linear-issue-1' },
  },
];
const commentsByIssueFixture = {
  'linear-issue-1': [
    {
      id: 'linear-comment-1',
      body: 'Imported comment from Alice.',
      createdAt: '2024-06-01T11:00:00.000Z',
      updatedAt: '2024-06-01T11:00:00.000Z',
      user: { id: 'user-alice', name: 'Alice Doe', email: 'alice@example.com' },
    },
  ],
  'linear-issue-2': [
    {
      id: 'linear-comment-2',
      body: 'Imported orphan comment.',
      createdAt: '2024-06-05T10:00:00.000Z',
      updatedAt: '2024-06-05T10:00:00.000Z',
      user: null,
    },
  ],
} as const;

describe('import board query integration', () => {
  let exportDir: string;
  let server: StartedServer;

  beforeAll(async () => {
    await prisma.$connect();
    server = await startServer({
      allowAdminFallback: true,
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
    await resetDatabase(prisma);
    exportDir = await createImportFixture();
  });

  afterEach(async () => {
    await rm(exportDir, { force: true, recursive: true });
  });

  it('returns imported board data through GraphQL with preserved parent and comment relationships', async () => {
    await runImportPipeline(prisma, exportDir);

    const response = await postGraphQL({
      query: `
        query ImportedBoard($first: Int!, $filter: IssueFilter) {
          issues(first: $first, filter: $filter) {
            nodes {
              identifier
              title
              state { name }
              parent { identifier }
              comments(first: 10, orderBy: createdAt) {
                nodes {
                  body
                  user { email }
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
      variables: {
        first: 20,
        filter: {
          team: {
            key: {
              eq: 'SON',
            },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.issues.pageInfo.hasNextPage).toBe(false);
    expect(response.body.data.issues.nodes).toEqual([
      {
        identifier: 'SON-43',
        title: 'Imported child issue',
        state: { name: 'Ready' },
        parent: { identifier: 'SON-42' },
        comments: {
          nodes: [
            {
              body: 'Imported orphan comment.',
              user: { email: 'orphan-comments@involute.import' },
            },
          ],
        },
      },
      {
        identifier: 'SON-42',
        title: 'Imported parent issue',
        state: { name: 'Backlog' },
        parent: null,
        comments: {
          nodes: [
            {
              body: 'Imported comment from Alice.',
              user: { email: 'alice@example.com' },
            },
          ],
        },
      },
    ]);
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

async function createImportFixture(): Promise<string> {
  const exportDir = await mkdtemp(join(tmpdir(), 'involute-import-board-'));
  await mkdir(join(exportDir, 'comments'), { recursive: true });

  await writeFile(join(exportDir, 'teams.json'), JSON.stringify(teamsFixture, null, 2));
  await writeFile(
    join(exportDir, 'workflow_states.json'),
    JSON.stringify(workflowStatesFixture, null, 2),
  );
  await writeFile(join(exportDir, 'labels.json'), JSON.stringify(labelsFixture, null, 2));
  await writeFile(join(exportDir, 'users.json'), JSON.stringify(usersFixture, null, 2));
  await writeFile(join(exportDir, 'issues.json'), JSON.stringify(issuesFixture, null, 2));

  for (const [issueId, comments] of Object.entries(commentsByIssueFixture)) {
    await writeFile(join(exportDir, 'comments', `${issueId}.json`), JSON.stringify(comments, null, 2));
  }

  return exportDir;
}

async function postGraphQL({
  query,
  variables,
}: {
  query: string;
  variables?: Record<string, unknown>;
}): Promise<{ body: any; status: number }> {
  const response = await fetch(`${activeServer.url}/graphql`, {
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
