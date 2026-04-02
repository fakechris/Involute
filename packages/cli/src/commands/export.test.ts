/**
 * Tests for the export CLI command.
 * Uses mocks for LinearClient to avoid requiring actual Linear API access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the entire linear module before importing the export command
vi.mock('../linear/index.js', () => {
  class MockLinearClient {
    paginate = vi.fn();
    request = vi.fn();
  }

  return {
    LinearClient: MockLinearClient,
    createLinearClientFromEnv: vi.fn(() => new MockLinearClient()),
    exportTeams: vi.fn(async () => [{ id: 't1', key: 'TST', name: 'Test Team' }]),
    exportWorkflowStates: vi.fn(async () => [
      { id: 'ws1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 't1' } },
    ]),
    exportLabels: vi.fn(async () => [{ id: 'l1', name: 'bug', color: '#ff0000' }]),
    exportUsers: vi.fn(async () => [
      { id: 'u1', name: 'Alice', email: 'alice@test.com', displayName: 'Alice', active: true },
    ]),
    exportIssues: vi.fn(async () => [
      {
        id: 'i1',
        identifier: 'TST-1',
        title: 'Test Issue',
        description: null,
        priority: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        state: { id: 'ws1', name: 'Backlog' },
        team: { id: 't1', key: 'TST' },
        assignee: null,
        labels: { nodes: [] },
        parent: null,
      },
    ]),
    exportAllComments: vi.fn(async () => new Map()),
    buildParentChildMapping: vi.fn(() => []),
    generateValidationReport: vi.fn(() => ({
      exportedAt: '2024-01-01T00:00:00.000Z',
      counts: { teams: 1, workflowStates: 1, labels: 1, users: 1, issues: 1, comments: 0, parentChildRelationships: 0 },
    })),
    writeExportData: vi.fn(async () => undefined),
    TEAMS_QUERY: '',
    WORKFLOW_STATES_QUERY: '',
    LABELS_QUERY: '',
    USERS_QUERY: '',
    ISSUES_QUERY: '',
    COMMENTS_QUERY: '',
  };
});

import { createProgram } from '../index.js';
import { registerExportCommand, runExport } from './export.js';
import * as linearMod from '../linear/index.js';

describe('export command', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'involute-export-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  });

  it('registers the export command on the program', () => {
    const program = createProgram();
    const exportCmd = program.commands.find((c) => c.name() === 'export');
    expect(exportCmd).toBeDefined();
  });

  it('requires --token option', () => {
    const program = createProgram();
    const exportCmd = program.commands.find((c) => c.name() === 'export');
    expect(exportCmd).toBeDefined();

    const tokenOpt = exportCmd!.options.find((o) => o.long === '--token');
    expect(tokenOpt).toBeDefined();
    expect(tokenOpt!.required).toBe(true);
  });

  it('requires --team option', () => {
    const program = createProgram();
    const exportCmd = program.commands.find((c) => c.name() === 'export');
    const teamOpt = exportCmd!.options.find((o) => o.long === '--team');
    expect(teamOpt).toBeDefined();
    expect(teamOpt!.required).toBe(true);
  });

  it('requires --output option', () => {
    const program = createProgram();
    const exportCmd = program.commands.find((c) => c.name() === 'export');
    const outputOpt = exportCmd!.options.find((o) => o.long === '--output');
    expect(outputOpt).toBeDefined();
    expect(outputOpt!.required).toBe(true);
  });

  it('calls export pipeline with correct parameters', async () => {
    await runExport({ token: 'test-token', team: 'TST', output: outputDir });

    // Verify pipeline functions were called
    expect(linearMod.exportTeams).toHaveBeenCalled();
    expect(linearMod.exportIssues).toHaveBeenCalled();
    expect(linearMod.exportAllComments).toHaveBeenCalled();
    expect(linearMod.writeExportData).toHaveBeenCalled();
  });

  it('throws when team key is not found', async () => {
    await expect(
      runExport({ token: 'test-token', team: 'NONEXISTENT', output: outputDir }),
    ).rejects.toThrow('Team with key "NONEXISTENT" not found');
  });

  it('shows export summary with all entity counts', async () => {
    const stdout: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdout.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runExport({ token: 'test-token', team: 'TST', output: outputDir });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdout.join('');
    expect(output).toContain('Export complete!');
    expect(output).toContain('Summary:');
    expect(output).toContain('Teams:');
    expect(output).toContain('Issues:');
  });
});
