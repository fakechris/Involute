/**
 * Tests for the import and verify CLI commands.
 * Tests command registration, option parsing, error handling,
 * and integration with the import pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CliError,
  createConfiguredGraphQLClient,
  createProgram,
  getConfigPath,
  getConfigValue,
  normalizeGraphQLErrorMessage,
  setConfigValue,
} from '../index.js';
import { runImport, validateExportDir, loadEnv } from './import.js';

// --- Fixture data matching Linear export format ---

const FIXTURE_TEAMS = [
  { id: 'linear-team-1', key: 'TST', name: 'Test Team' },
];

const FIXTURE_WORKFLOW_STATES = [
  { id: 'linear-ws-1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'linear-team-1' } },
];

const FIXTURE_LABELS = [
  { id: 'linear-label-1', name: 'test-label', color: '#ff0000' },
];

const FIXTURE_USERS = [
  { id: 'linear-user-1', name: 'Alice', email: 'alice-test@example.com', displayName: 'Alice', active: true },
];

const FIXTURE_ISSUES = [
  {
    id: 'linear-issue-1',
    identifier: 'TST-1',
    title: 'Test Issue',
    description: null,
    priority: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    state: { id: 'linear-ws-1', name: 'Backlog' },
    team: { id: 'linear-team-1', key: 'TST' },
    assignee: null,
    labels: { nodes: [] },
    parent: null,
  },
];

async function writeFixtureExportDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'comments'), { recursive: true });
  await mkdir(join(dir, 'mappings'), { recursive: true });

  await writeFile(join(dir, 'teams.json'), JSON.stringify(FIXTURE_TEAMS, null, 2));
  await writeFile(join(dir, 'workflow_states.json'), JSON.stringify(FIXTURE_WORKFLOW_STATES, null, 2));
  await writeFile(join(dir, 'labels.json'), JSON.stringify(FIXTURE_LABELS, null, 2));
  await writeFile(join(dir, 'users.json'), JSON.stringify(FIXTURE_USERS, null, 2));
  await writeFile(join(dir, 'issues.json'), JSON.stringify(FIXTURE_ISSUES, null, 2));
}

describe('import command registration', () => {
  it('registers the import command on the program', () => {
    const program = createProgram();
    const importCmd = program.commands.find((c) => c.name() === 'import');
    expect(importCmd).toBeDefined();
  });

  it('has --file option on import command', () => {
    const program = createProgram();
    const importCmd = program.commands.find((c) => c.name() === 'import');
    expect(importCmd).toBeDefined();

    const fileOpt = importCmd!.options.find((o) => o.long === '--file');
    expect(fileOpt).toBeDefined();
  });

  it('registers verify as a subcommand of import', () => {
    const program = createProgram();
    const importCmd = program.commands.find((c) => c.name() === 'import');
    expect(importCmd).toBeDefined();

    const verifyCmd = importCmd!.commands.find((c) => c.name() === 'verify');
    expect(verifyCmd).toBeDefined();
  });

  it('verify subcommand requires --file option', () => {
    const program = createProgram();
    const importCmd = program.commands.find((c) => c.name() === 'import');
    const verifyCmd = importCmd!.commands.find((c) => c.name() === 'verify');
    expect(verifyCmd).toBeDefined();

    const fileOpt = verifyCmd!.options.find((o) => o.long === '--file');
    expect(fileOpt).toBeDefined();
    expect(fileOpt!.required).toBe(true);
  });
});

describe('validateExportDir', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'involute-import-validate-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('throws for nonexistent directory', async () => {
    await expect(validateExportDir('/nonexistent/path/12345')).rejects.toThrow(
      'Export directory not found',
    );
  });

  it('throws for missing required files', async () => {
    await mkdir(join(tempDir, 'empty-export'), { recursive: true });
    await expect(validateExportDir(join(tempDir, 'empty-export'))).rejects.toThrow(
      'Missing required file',
    );
  });

  it('passes for valid export directory', async () => {
    const exportDir = join(tempDir, 'valid-export');
    await writeFixtureExportDir(exportDir);
    await expect(validateExportDir(exportDir)).resolves.toBeUndefined();
  });

  it('lists the specific missing file in error', async () => {
    const exportDir = join(tempDir, 'partial-export');
    await mkdir(exportDir, { recursive: true });
    // Only write teams.json — missing the rest
    await writeFile(join(exportDir, 'teams.json'), '[]');

    await expect(validateExportDir(exportDir)).rejects.toThrow('workflow_states.json');
  });
});

describe('runImport error handling', () => {
  it('throws for nonexistent export directory', async () => {
    await expect(runImport({ file: '/nonexistent/path/12345' })).rejects.toThrow(
      'Export directory not found',
    );
  });

  it('throws for directory missing required files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'involute-import-nofiles-'));

    try {
      // Create empty directory with no export files
      await mkdir(tempDir, { recursive: true });
      await expect(runImport({ file: tempDir })).rejects.toThrow('Missing required file');
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('loadEnv', () => {
  it('loads environment variables without throwing', () => {
    // loadEnv should not throw even if .env doesn't exist in current path
    expect(() => loadEnv()).not.toThrow();
  });
});

describe('CLI config helpers', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'involute-cli-config-'));
    configPath = join(tempDir, 'config.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('persists server-url and token in ~/.involute/config.json format', async () => {
    await setConfigValue('server-url', 'http://localhost:4200', configPath);
    await setConfigValue('token', 'secret-token', configPath);

    await expect(access(configPath)).resolves.toBeUndefined();
    await expect(getConfigValue('server-url', configPath)).resolves.toBe('http://localhost:4200');
    await expect(getConfigValue('token', configPath)).resolves.toBe('secret-token');
  });

  it('creates a graphql client using configured server-url and token', async () => {
    await setConfigValue('server-url', 'http://localhost:4200', configPath);
    await setConfigValue('token', 'secret-token', configPath);

    const client = await createConfiguredGraphQLClient(configPath);

    expect(client).toBeInstanceOf(Object);
  });

  it('throws a helpful error when server-url is missing', async () => {
    await expect(createConfiguredGraphQLClient(configPath)).rejects.toThrow(
      'Missing required config "server-url". Run `involute config set server-url <url>` first.',
    );
  });

  it('normalizes not authenticated GraphQL errors with config guidance', () => {
    const message = normalizeGraphQLErrorMessage({
      response: {
        errors: [{ message: 'Not authenticated' }],
      },
    });

    expect(message).toContain('config set token');
  });

  it('exposes the default config path under ~/.involute', () => {
    expect(getConfigPath()).toContain('.involute/config.json');
  });

  it('preserves explicit CliError messages', () => {
    expect(normalizeGraphQLErrorMessage(new CliError('boom'))).toBe('boom');
  });
});
