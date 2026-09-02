import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { setConfigValue } from '../index.js';
import { startServer, type StartedServer } from '@turnkeyai/involute-server';
import { createIssue, updateIssue } from '../../../server/dist/issue-service.js';
import { createWorkLink } from '../../../server/dist/link-service.js';

const DEFAULT_ADMIN_EMAIL = 'admin@involute.local';
const DEFAULT_TEAM_KEY = 'INV';
const TEST_AUTH_TOKEN = 'cli-work-test-token';

describe('work CLI commands', () => {
  let prisma: PrismaClient;
  let server: StartedServer;
  let tempDir: string;
  let readyStateId: string;
  let parentIdentifier: string;
  let childIdentifier: string;
  let blockedIdentifier: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
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
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();

    const team = await prisma.team.create({
      data: {
        key: DEFAULT_TEAM_KEY,
        name: 'Involute',
        nextIssueNumber: 1,
      },
    });

    const states = [
      ['Backlog', 'BACKLOG'],
      ['Ready', 'UNSTARTED'],
      ['In Progress', 'STARTED'],
      ['In Review', 'REVIEW'],
      ['Done', 'COMPLETED'],
      ['Canceled', 'CANCELED'],
    ] as const;
    for (const [position, [name, type]] of states.entries()) {
      await prisma.workflowState.create({
        data: { name, position, teamId: team.id, type },
      });
    }

    const admin = await prisma.user.create({
      data: { email: DEFAULT_ADMIN_EMAIL, name: 'Admin' },
    });
    await prisma.teamMembership.create({
      data: { role: 'OWNER', teamId: team.id, userId: admin.id },
    });

    const ready = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Ready' },
    });
    readyStateId = ready.id;

    const parent = await createIssue(prisma, {
      teamId: team.id,
      title: 'Parent work',
      stateId: readyStateId,
    });
    const child = await createIssue(prisma, {
      teamId: team.id,
      title: 'Child work',
      stateId: readyStateId,
    });
    const blocker = await createIssue(prisma, {
      teamId: team.id,
      title: 'Blocker work',
      stateId: readyStateId,
    });
    await updateIssue(prisma, parent.id, {
      acceptance: 'parent contract is ready',
      assigneeId: admin.id,
    });
    await updateIssue(prisma, child.id, {
      acceptance: 'child contract is ready after blockers finish',
      assigneeId: admin.id,
      parentId: parent.id,
    });
    await updateIssue(prisma, blocker.id, {
      acceptance: 'blocker contract is ready',
      assigneeId: admin.id,
    });
    await createWorkLink(prisma, { fromId: blocker.id, toId: child.id, type: 'BLOCKS' });

    parentIdentifier = parent.identifier;
    childIdentifier = child.identifier;
    blockedIdentifier = child.identifier;

    tempDir = await mkdtemp(join(tmpdir(), 'involute-cli-work-'));
    await setConfigValue('server-url', server.url, join(tempDir, 'config.json'));
    await setConfigValue('token', TEST_AUTH_TOKEN, join(tempDir, 'config.json'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('prints a context bundle and a ready queue', async () => {
    const { stdout: contextOut, exitCode: contextCode } = await runCli(
      ['work', 'context', childIdentifier, '--json'],
      tempDir,
    );
    expect(contextCode).toBe(0);
    const context = JSON.parse(contextOut) as {
      ancestors: Array<{ identifier: string }>;
      blockedBy: Array<{ identifier: string }>;
      work: { identifier: string };
    };
    expect(context.work.identifier).toBe(childIdentifier);
    expect(context.ancestors.map((issue) => issue.identifier)).toEqual([parentIdentifier]);
    expect(context.blockedBy).toHaveLength(1);

    const { stdout: readyOut, exitCode: readyCode } = await runCli(
      ['work', 'ready', '--json'],
      tempDir,
    );
    expect(readyCode).toBe(0);
    const ready = JSON.parse(readyOut) as Array<{ identifier: string }>;
    const identifiers = ready.map((issue) => issue.identifier);
    expect(identifiers).toContain(parentIdentifier);
    expect(identifiers).not.toContain(blockedIdentifier);
  });

  it('proposes, commits, and claims through the CLI', async () => {
    const { stdout: proposeOut, exitCode: proposeCode } = await runCli(
      [
        'work',
        'propose',
        '--team',
        DEFAULT_TEAM_KEY,
        '--title',
        'CLI candidate',
        '--idempotency-key',
        'cli-candidate-1',
        '--json',
      ],
      tempDir,
    );
    expect(proposeCode).toBe(0);
    const proposed = JSON.parse(proposeOut) as { commitmentStatus: string; identifier: string };
    expect(proposed.commitmentStatus).toBe('CANDIDATE');

    const viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const { stdout: commitOut, exitCode: commitCode } = await runCli(
      [
        'work',
        'commit',
        proposed.identifier,
        '--acceptance',
        'CLI can round-trip propose/commit/claim',
        '--assignee',
        viewer.id,
        '--json',
      ],
      tempDir,
    );
    expect(commitCode).toBe(0);
    const committed = JSON.parse(commitOut) as { commitmentStatus: string; identifier: string };
    expect(committed.commitmentStatus).toBe('COMMITTED');

    const { stdout: claimOut, exitCode: claimCode } = await runCli(
      ['work', 'claim', committed.identifier, '--json'],
      tempDir,
    );
    expect(claimCode).toBe(0);
    const claimed = JSON.parse(claimOut) as {
      claim: { leaseUntil: string };
      issue: { identifier: string };
    };
    expect(claimed.issue.identifier).toBe(committed.identifier);
    expect(claimed.claim.leaseUntil).toBeTruthy();
  });

  it('rejects a candidate through the CLI', async () => {
    const { stdout: proposeOut, exitCode: proposeCode } = await runCli(
      [
        'work',
        'propose',
        '--team',
        DEFAULT_TEAM_KEY,
        '--title',
        'CLI reject candidate',
        '--json',
      ],
      tempDir,
    );
    expect(proposeCode).toBe(0);
    const proposed = JSON.parse(proposeOut) as { identifier: string };

    const { stdout: rejectOut, exitCode: rejectCode } = await runCli(
      [
        'work',
        'reject',
        proposed.identifier,
        '--reason',
        'not a delivery contract',
        '--json',
      ],
      tempDir,
    );
    expect(rejectCode).toBe(0);
    const rejected = JSON.parse(rejectOut) as { commitmentStatus: string; identifier: string };
    expect(rejected.identifier).toBe(proposed.identifier);
    expect(rejected.commitmentStatus).toBe('REJECTED');
  });
});

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
