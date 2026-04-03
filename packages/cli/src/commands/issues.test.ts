import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { setConfigValue } from '../index.js';
import { startServer, type StartedServer } from '@involute/server';
import { createIssue } from '../../../server/dist/issue-service.js';
const DEFAULT_ADMIN_EMAIL = 'admin@involute.local';
const DEFAULT_TEAM_KEY = 'INV';

const TEST_AUTH_TOKEN = 'cli-issues-test-token';

describe('issue-related CLI commands', () => {
  let prisma: PrismaClient;
  let server: StartedServer;
  let tempDir: string;
  let configPath: string;
  let fixtureIssueIdentifier: string;
  let viewerId: string;
  let invTeamId: string;
  let readyStateId: string;
  let backlogStateId: string;
  let taskLabelId: string;
  let bugLabelId: string;

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

    tempDir = await mkdtemp(join(tmpdir(), 'involute-cli-issues-'));
    configPath = join(tempDir, 'config.json');
    await setConfigValue('server-url', server.url, configPath);
    await setConfigValue('token', TEST_AUTH_TOKEN, configPath);

    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    invTeamId = team.id;

    const states = await prisma.workflowState.findMany({
      where: { teamId: team.id },
      orderBy: { name: 'asc' },
    });
    readyStateId = states.find((state) => state.name === 'Ready')!.id;
    backlogStateId = states.find((state) => state.name === 'Backlog')!.id;

    const labels = await prisma.issueLabel.findMany({
      where: { name: { in: ['task', 'Bug'] } },
      orderBy: { name: 'asc' },
    });
    taskLabelId = labels.find((label) => label.name === 'task')!.id;
    bugLabelId = labels.find((label) => label.name === 'Bug')!.id;

    const viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    viewerId = viewer.id;

    const issue = await createIssue(prisma, {
      teamId: team.id,
      title: 'CLI fixture issue',
      description: 'Seeded for CLI tests',
      stateId: readyStateId,
    });
    fixtureIssueIdentifier = issue.identifier;

    await prisma.issue.update({
      where: { id: issue.id },
      data: {
        assigneeId: viewer.id,
        labels: {
          set: [{ id: taskLabelId }],
        },
      },
    });

    await prisma.comment.create({
      data: {
        body: 'First CLI comment',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        issueId: issue.id,
        userId: viewer.id,
      },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists teams, states, and labels', async () => {
    const { stdout: teamsOut } = await runCli(['teams', 'list'], tempDir);
    expect(teamsOut).toContain('id');
    expect(teamsOut).toContain('key');
    expect(teamsOut).toContain('name');
    expect(teamsOut).toContain(DEFAULT_TEAM_KEY);

    const { stdout: statesOut } = await runCli(['states', 'list'], tempDir);
    expect(statesOut).toContain('Backlog');
    expect(statesOut).toContain('Ready');
    expect(statesOut).toContain('In Progress');
    expect(statesOut).toContain('In Review');
    expect(statesOut).toContain('Done');
    expect(statesOut).toContain('Canceled');

    const { stdout: labelsOut } = await runCli(['labels', 'list'], tempDir);
    expect(labelsOut).toContain('task');
    expect(labelsOut).toContain('Bug');
  });

  it('supports json output for list commands', async () => {
    const { stdout: teamsOut } = await runCli(['--json', 'teams', 'list'], tempDir);
    const teams = JSON.parse(teamsOut);
    expect(Array.isArray(teams)).toBe(true);
    expect(teams[0]).toMatchObject({ id: expect.any(String), key: expect.any(String), name: expect.any(String) });

    const { stdout: topLevelTeamsOut } = await runCli(['teams', '--json'], tempDir);
    expect(JSON.parse(topLevelTeamsOut)).toEqual(teams);

    const { stdout: topLevelStatesOut } = await runCli(['states', '--json'], tempDir);
    const states = JSON.parse(topLevelStatesOut);
    expect(Array.isArray(states)).toBe(true);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), name: 'Backlog' }),
        expect.objectContaining({ id: expect.any(String), name: 'Ready' }),
      ]),
    );

    const { stdout: topLevelLabelsOut } = await runCli(['labels', '--json'], tempDir);
    const labels = JSON.parse(topLevelLabelsOut);
    expect(Array.isArray(labels)).toBe(true);
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), name: 'task' }),
        expect.objectContaining({ id: expect.any(String), name: 'Bug' }),
      ]),
    );

    const { stdout: issuesOut } = await runCli(['issues', 'list', '--json'], tempDir);
    const issues = JSON.parse(issuesOut);
    expect(Array.isArray(issues)).toBe(true);
    expect(issues[0]).toMatchObject({
      identifier: expect.any(String),
      title: expect.any(String),
      state: { name: expect.any(String) },
    });
  });

  it('emits machine-readable JSON for config set and writes a private config file', async () => {
    const configDir = join(tempDir, 'private-config');
    const privateConfigPath = join(configDir, 'config.json');

    const result = await setConfigValue('token', 'super-secret-token', privateConfigPath);

    expect(result.token).toBe('super-secret-token');

    const { stdout, exitCode } = await runCli(
      ['config', 'set', 'server-url', server.url, '--json'],
      tempDir,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      key: 'server-url',
      path: join(tempDir, 'config.json'),
    });

    const configStats = await stat(privateConfigPath);
    expect(configStats.mode & 0o777).toBe(0o600);
  });

  it('lists issues and filters by team', async () => {
    await createSecondaryTeamFixture(prisma);

    const { stdout } = await runCli(['issues', 'list', '--team', DEFAULT_TEAM_KEY], tempDir);
    expect(stdout).toContain(fixtureIssueIdentifier);
    expect(stdout).toContain('CLI fixture issue');
    expect(stdout).toContain('Ready');
    expect(stdout).toContain('Admin');
    expect(stdout).not.toContain('OPS-1');
  });

  it('lists issues whose identifiers fall beyond the first 100 team issues', async () => {
    const highIdentifier = await createHighNumberIssue(prisma, 105);

    const { stdout, exitCode } = await runCli(['issues', 'list', '--team', DEFAULT_TEAM_KEY, '--json'], tempDir);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: highIdentifier,
        }),
      ]),
    );
  }, 10_000);

  it('shows issue detail and returns a helpful not found error', async () => {
    const { stdout } = await runCli(['issues', 'show', fixtureIssueIdentifier], tempDir);
    expect(stdout).toContain(`identifier: ${fixtureIssueIdentifier}`);
    expect(stdout).toContain('title: CLI fixture issue');
    expect(stdout).toContain('description: Seeded for CLI tests');
    expect(stdout).toContain('state: Ready');
    expect(stdout).toContain('labels: task');
    expect(stdout).toContain('assignee: Admin');
    expect(stdout).toContain('First CLI comment');

    const missing = await runCli(['issues', 'show', 'INV-999999'], tempDir);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('Error: Issue not found');
  });

  it('shows issue detail for identifiers beyond the first 100 team issues', async () => {
    const highIdentifier = await createHighNumberIssue(prisma, 105);

    const { stdout, exitCode } = await runCli(['issues', 'show', highIdentifier], tempDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`identifier: ${highIdentifier}`);
    expect(stdout).toContain(`title: Generated issue ${highIdentifier}`);
  }, 10_000);

  it('creates issues and outputs the identifier', async () => {
    const result = await runCli(
      ['issues', 'create', '--title', 'Created from CLI', '--team', DEFAULT_TEAM_KEY, '--description', 'Created description'],
      tempDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('identifier: INV-2');

    const created = await prisma.issue.findUniqueOrThrow({ where: { identifier: 'INV-2' } });
    expect(created.title).toBe('Created from CLI');
    expect(created.description).toBe('Created description');
    expect(created.teamId).toBe(invTeamId);
  });

  it('updates issue state, title, assignee, and labels', async () => {
    const stateUpdate = await runCli(
      ['issues', 'update', fixtureIssueIdentifier, '--state', 'Backlog'],
      tempDir,
    );
    expect(stateUpdate.exitCode).toBe(0);
    expect(stateUpdate.stdout).toContain('state: Backlog');

    const titleUpdate = await runCli(
      ['issues', 'update', fixtureIssueIdentifier, '--title', 'CLI renamed issue'],
      tempDir,
    );
    expect(titleUpdate.exitCode).toBe(0);
    expect(titleUpdate.stdout).toContain('title: CLI renamed issue');

    const assigneeUpdate = await runCli(
      ['issues', 'update', fixtureIssueIdentifier, '--assignee', viewerId],
      tempDir,
    );
    expect(assigneeUpdate.exitCode).toBe(0);

    const labelsUpdate = await runCli(
      ['issues', 'update', fixtureIssueIdentifier, '--labels', 'task,Bug'],
      tempDir,
    );
    expect(labelsUpdate.exitCode).toBe(0);
    expect(labelsUpdate.stdout).toContain('labels: Bug, task');

    const updated = await prisma.issue.findUniqueOrThrow({
      where: { identifier: fixtureIssueIdentifier },
      include: { state: true, assignee: true, labels: { orderBy: { name: 'asc' } } },
    });

    expect(updated.stateId).toBe(backlogStateId);
    expect(updated.title).toBe('CLI renamed issue');
    expect(updated.assigneeId).toBe(viewerId);
    expect(updated.labels.map((label) => label.id).sort()).toEqual([bugLabelId, taskLabelId].sort());
  });

  it('updates issues whose identifiers fall beyond the first 100 team issues', async () => {
    const highIdentifier = await createHighNumberIssue(prisma, 105);

    const result = await runCli(['issues', 'update', highIdentifier, '--title', 'Updated high-number issue'], tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`identifier: ${highIdentifier}`);
    expect(result.stdout).toContain('title: Updated high-number issue');

    const updated = await prisma.issue.findUniqueOrThrow({ where: { identifier: highIdentifier } });
    expect(updated.title).toBe('Updated high-number issue');
  });
});

async function createSecondaryTeamFixture(prisma: PrismaClient): Promise<void> {
  const opsTeam = await prisma.team.create({
    data: {
      key: 'OPS',
      name: 'Operations',
      nextIssueNumber: 2,
    },
  });

  const stateNames = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done', 'Canceled'];
  const createdStates = await Promise.all(
    stateNames.map((name) =>
      prisma.workflowState.create({
        data: {
          name,
          teamId: opsTeam.id,
        },
      }),
    ),
  );

  await prisma.issue.create({
    data: {
      identifier: 'OPS-1',
      title: 'Operations issue',
      description: null,
      teamId: opsTeam.id,
      stateId: createdStates.find((state) => state.name === 'Backlog')!.id,
    },
  });
}

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

async function createHighNumberIssue(prisma: PrismaClient, issueNumber: number): Promise<string> {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const readyState = await prisma.workflowState.findFirstOrThrow({
    where: { teamId: team.id, name: 'Ready' },
  });

  const issuesToCreate = issueNumber - team.nextIssueNumber + 1;
  for (let index = 0; index < issuesToCreate; index += 1) {
    await createIssue(prisma, {
      teamId: team.id,
      title: `Generated issue ${team.key}-${team.nextIssueNumber + index}`,
      stateId: readyState.id,
    });
  }

  return `${team.key}-${issueNumber}`;
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
