import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { createConfiguredGraphQLClient, setConfigValue } from '../index.js';
import { startServer, type StartedServer } from '@involute/server';
import { createIssue } from '../../../server/dist/issue-service.js';

const DEFAULT_ADMIN_EMAIL = 'admin@involute.local';
const DEFAULT_TEAM_KEY = 'INV';

const TEST_AUTH_TOKEN = 'cli-comments-test-token';

describe('comment-related CLI commands', () => {
  let prisma: PrismaClient;
  let server: StartedServer;
  let tempDir: string;
  let configPath: string;
  let fixtureIssueId: string;
  let fixtureIssueIdentifier: string;
  let viewerId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    server = await startServer({ authToken: TEST_AUTH_TOKEN, port: 0, prisma });
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();

    await seedTestData(prisma);

    tempDir = await mkdtemp(join(tmpdir(), 'involute-cli-comments-'));
    configPath = join(tempDir, 'config.json');
    await setConfigValue('server-url', server.url, configPath);
    await setConfigValue('token', TEST_AUTH_TOKEN, configPath);

    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const backlogState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Backlog' },
    });
    const viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    viewerId = viewer.id;

    const issue = await createIssue(prisma, {
      teamId: team.id,
      title: 'Comment test issue',
      description: 'Fixture for comment tests',
      stateId: backlogState.id,
    });
    fixtureIssueId = issue.id;
    fixtureIssueIdentifier = issue.identifier;

    // Create two comments with known timestamps for ordering verification
    await prisma.comment.create({
      data: {
        body: 'First comment body',
        createdAt: new Date('2024-01-01T10:00:00.000Z'),
        updatedAt: new Date('2024-01-01T10:00:00.000Z'),
        issueId: issue.id,
        userId: viewer.id,
      },
    });

    await prisma.comment.create({
      data: {
        body: 'Second comment body',
        createdAt: new Date('2024-01-02T10:00:00.000Z'),
        updatedAt: new Date('2024-01-02T10:00:00.000Z'),
        issueId: issue.id,
        userId: viewer.id,
      },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists comments for an issue by identifier', async () => {
    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier], tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('First comment body');
    expect(stdout).toContain('Second comment body');
    expect(stdout).toContain('Admin');
    expect(stdout).toContain('2024-01-01');
    expect(stdout).toContain('2024-01-02');
  });

  it('lists comments in chronological order', async () => {
    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier], tempDir);
    expect(exitCode).toBe(0);

    const firstIndex = stdout.indexOf('First comment body');
    const secondIndex = stdout.indexOf('Second comment body');
    expect(firstIndex).toBeLessThan(secondIndex);
  });

  it('truncates long comment bodies in table output', async () => {
    const longBody = 'A'.repeat(200);
    await prisma.comment.create({
      data: {
        body: longBody,
        createdAt: new Date('2024-01-03T10:00:00.000Z'),
        updatedAt: new Date('2024-01-03T10:00:00.000Z'),
        issueId: fixtureIssueId,
        userId: viewerId,
      },
    });

    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier], tempDir);
    expect(exitCode).toBe(0);
    // Should be truncated, not the full 200 chars
    expect(stdout).not.toContain(longBody);
    expect(stdout).toContain('…');
  });

  it('outputs valid JSON for comments list with --json', async () => {
    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier, '--json'], tempDir);
    expect(exitCode).toBe(0);

    const comments = JSON.parse(stdout);
    expect(Array.isArray(comments)).toBe(true);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: expect.any(String),
      body: 'First comment body',
      createdAt: expect.stringContaining('2024-01-01'),
      user: expect.objectContaining({ name: 'Admin' }),
    });
  });

  it('lists comments beyond the first 100 entries for an issue identifier', async () => {
    const manyComments = Array.from({ length: 105 }, (_, index) => ({
      body: `Generated comment ${index + 1}`,
      createdAt: new Date(Date.parse('2024-01-03T00:00:00.000Z') + index * 60_000),
      updatedAt: new Date(Date.parse('2024-01-03T00:00:00.000Z') + index * 60_000),
      issueId: fixtureIssueId,
      userId: viewerId,
    }));

    await prisma.comment.createMany({
      data: manyComments,
    });

    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier, '--json'], tempDir);
    const comments = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(comments).toHaveLength(107);
    expect(comments.at(-1)).toMatchObject({
      body: 'Generated comment 105',
    });
  });

  it('shows error for nonexistent issue identifier', async () => {
    const result = await runCli(['comments', 'list', 'INV-999999'], tempDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error');
    expect(result.stderr).toContain('not found');
  });

  it('lists comments for an issue by UUID', async () => {
    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueId], tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('First comment body');
    expect(stdout).toContain('Second comment body');
  });

  it('treats opaque non-UUID issue ids as direct issue lookups before identifier fallback', async () => {
    const client = await createConfiguredGraphQLClient(configPath);
    const directIssue = await client.request<{
      issue: {
        id: string;
        identifier: string;
        comments: { nodes: Array<{ body: string }> };
      } | null;
    }>(
      /* GraphQL */ `
        query CliDirectIssueLookup($id: String!) {
          issue(id: $id) {
            id
            identifier
            comments(first: 100, orderBy: createdAt) {
              nodes {
                body
              }
            }
          }
        }
      `,
      { id: 'opaque-non-uuid-issue-id' },
    );

    expect(directIssue.issue).toBeNull();

    const { stdout, exitCode } = await runCli(['comments', 'list', 'opaque-non-uuid-issue-id'], tempDir);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
  });

  it('lists comments by identifier when direct issue-id lookup misses', async () => {
    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier], tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('First comment body');
  });

  it('uses issue lookup by identifier before listing comments', async () => {
    const client = await createConfiguredGraphQLClient(configPath);
    const issueByIdentifier = await client.request<{
      issues: {
        nodes: Array<{ id: string; identifier: string }>;
      };
    }>(
      /* GraphQL */ `
        query CliIssueIdentifierLookup($filter: IssueFilter, $first: Int!) {
          issues(first: $first, filter: $filter) {
            nodes {
              id
              identifier
            }
          }
        }
      `,
      {
        filter: {
          team: {
            key: {
              eq: 'INV',
            },
          },
        },
        first: 100,
      },
    );

    const lookedUp = issueByIdentifier.issues.nodes.find((issue) => issue.identifier === fixtureIssueIdentifier);

    expect(lookedUp?.id).toBe(fixtureIssueId);

    const { stdout, exitCode } = await runCli(['comments', 'list', fixtureIssueIdentifier], tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('First comment body');
  });

  it('shows empty table when issue has no comments', async () => {
    // Create another issue with no comments
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const backlogState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Backlog' },
    });
    const emptyIssue = await createIssue(prisma, {
      teamId: team.id,
      title: 'No comments issue',
      stateId: backlogState.id,
    });

    const { stdout, exitCode } = await runCli(['comments', 'list', emptyIssue.identifier], tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no results)');
  });

  it('adds a comment to an issue by identifier', async () => {
    const { stdout, exitCode } = await runCli(
      ['comments', 'add', fixtureIssueIdentifier, '--body', 'New comment from CLI'],
      tempDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('id:');

    // Verify the comment was created in DB
    const comments = await prisma.comment.findMany({
      where: { issueId: fixtureIssueId },
      orderBy: { createdAt: 'desc' },
    });
    expect(comments[0]!.body).toBe('New comment from CLI');
  });

  it('adds a comment to an issue by UUID', async () => {
    const { stdout, exitCode } = await runCli(
      ['comments', 'add', fixtureIssueId, '--body', 'Comment by UUID'],
      tempDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('id:');

    const comments = await prisma.comment.findMany({
      where: { issueId: fixtureIssueId, body: 'Comment by UUID' },
    });
    expect(comments).toHaveLength(1);
  });

  it('tries direct issue lookup for opaque non-UUID ids before add comment identifier fallback', async () => {
    const client = await createConfiguredGraphQLClient(configPath);
    const directIssue = await client.request<{ issue: { id: string } | null }>(
      /* GraphQL */ `
        query CliDirectIssueLookup($id: String!) {
          issue(id: $id) {
            id
          }
        }
      `,
      { id: 'opaque-non-uuid-issue-id' },
    );

    expect(directIssue.issue).toBeNull();

    const result = await runCli(
      ['comments', 'add', 'opaque-non-uuid-issue-id', '--body', 'Comment by opaque issue id'],
      tempDir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('adds a comment by identifier when direct issue-id lookup misses', async () => {
    const { stdout, exitCode } = await runCli(
      ['comments', 'add', fixtureIssueIdentifier, '--body', 'Comment by identifier fallback'],
      tempDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('id:');

    const comments = await prisma.comment.findMany({
      where: { issueId: fixtureIssueId, body: 'Comment by identifier fallback' },
    });
    expect(comments).toHaveLength(1);
  });

  it('resolves issue identifier to UUID before adding a comment', async () => {
    const client = await createConfiguredGraphQLClient(configPath);
    const issueByIdentifier = await client.request<{
      issues: {
        nodes: Array<{ id: string; identifier: string }>;
      };
    }>(
      /* GraphQL */ `
        query CliIssueIdentifierLookup($filter: IssueFilter, $first: Int!) {
          issues(first: $first, filter: $filter) {
            nodes {
              id
              identifier
            }
          }
        }
      `,
      {
        filter: {
          team: {
            key: {
              eq: 'INV',
            },
          },
        },
        first: 100,
      },
    );

    const lookedUp = issueByIdentifier.issues.nodes.find((issue) => issue.identifier === fixtureIssueIdentifier);
    expect(lookedUp?.id).toBe(fixtureIssueId);

    const { exitCode } = await runCli(
      ['comments', 'add', fixtureIssueIdentifier, '--body', 'Resolved by identifier'],
      tempDir,
    );

    expect(exitCode).toBe(0);

    const created = await prisma.comment.findFirst({
      where: {
        issueId: fixtureIssueId,
        body: 'Resolved by identifier',
      },
      orderBy: { createdAt: 'desc' },
    });

    expect(created).not.toBeNull();
  });

  it('outputs comment id as JSON with --json', async () => {
    const { stdout, exitCode } = await runCli(
      ['comments', 'add', fixtureIssueIdentifier, '--body', 'JSON comment', '--json'],
      tempDir,
    );
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      id: expect.any(String),
      body: 'JSON comment',
    });
  });

  it('shows error when adding comment to nonexistent issue', async () => {
    const result = await runCli(
      ['comments', 'add', 'INV-999999', '--body', 'Should fail'],
      tempDir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error');
  });

  it('shows error when --body is missing', async () => {
    // Commander.js calls process.exit(1) for missing required options,
    // which vitest intercepts as an error.
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = ((code?: number) => {
      exitCalled = true;
      if (code !== 0) {
        throw new Error(`process.exit unexpectedly called with "${code}"`);
      }
    }) as typeof process.exit;

    try {
      const result = await runCli(['comments', 'add', fixtureIssueIdentifier], tempDir);
      // If we reach here without error, check exit code
      expect(result.exitCode).not.toBe(0);
    } catch {
      // Commander called process.exit(1) for missing --body — this is expected
      expect(exitCalled).toBe(true);
    } finally {
      process.exit = originalExit;
    }
  });
});

async function seedTestData(prisma: PrismaClient): Promise<void> {
  const team = await prisma.team.create({
    data: {
      key: DEFAULT_TEAM_KEY,
      name: 'Involute',
      nextIssueNumber: 1,
    },
  });

  for (const name of ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done', 'Canceled']) {
    await prisma.workflowState.create({
      data: {
        name,
        teamId: team.id,
      },
    });
  }

  for (const name of ['task', 'epic', 'spec', 'needs-clarification', 'blocked', 'agent-ready', 'Feature', 'Bug', 'Improvement', 'spec-orch']) {
    await prisma.issueLabel.create({
      data: { name },
    });
  }

  await prisma.user.create({
    data: {
      email: DEFAULT_ADMIN_EMAIL,
      name: 'Admin',
    },
  });
}

async function runCli(args: string[], homeDir: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  process.env.INVOLUTE_CONFIG_PATH = join(homeDir, 'config.json');

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const { createProgram } = await import('../index.js');
    await createProgram().parseAsync(['node', 'involute', ...args], { from: 'node' });

    return {
      exitCode: process.exitCode ?? 0,
      stderr: stderrChunks.join(''),
      stdout: stdoutChunks.join(''),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
    process.env.HOME = originalHome;
    delete process.env.INVOLUTE_CONFIG_PATH;
  }
}
