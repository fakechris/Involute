import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeExportData, type ExportData } from './writer.js';
import { readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearUser,
  LinearIssue,
  LinearComment,
} from './types.js';

const mockTeams: LinearTeam[] = [
  { id: 'team-1', key: 'ENG', name: 'Engineering' },
];

const mockStates: LinearWorkflowState[] = [
  { id: 'ws-1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'team-1' } },
  { id: 'ws-2', name: 'Done', type: 'completed', position: 1, team: { id: 'team-1' } },
];

const mockLabels: LinearLabel[] = [
  { id: 'lbl-1', name: 'bug', color: '#ff0000' },
];

const mockUsers: LinearUser[] = [
  { id: 'usr-1', name: 'Alice', email: 'alice@example.com', displayName: 'Alice A.', active: true },
];

const mockIssues: LinearIssue[] = [
  {
    id: 'iss-1',
    identifier: 'ENG-1',
    title: 'Test Issue',
    description: 'A test',
    priority: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    state: { id: 'ws-1', name: 'Backlog' },
    team: { id: 'team-1', key: 'ENG' },
    assignee: { id: 'usr-1', name: 'Alice', email: 'alice@example.com' },
    labels: { nodes: [{ id: 'lbl-1', name: 'bug' }] },
    parent: null,
  },
];

const mockComments: LinearComment[] = [
  {
    id: 'com-1',
    body: 'Hello',
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    user: { id: 'usr-1', name: 'Alice', email: 'alice@example.com' },
  },
];

describe('writeExportData', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'involute-export-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the complete directory structure', async () => {
    const outputDir = join(tmpDir, 'export');
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: commentsMap,
      parentChildMappings: [],
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 1,
          workflowStates: 2,
          labels: 1,
          users: 1,
          issues: 1,
          comments: 1,
          parentChildRelationships: 0,
        },
      },
    };

    await writeExportData(outputDir, data);

    // Verify top-level files
    const topFiles = await readdir(outputDir);
    expect(topFiles).toContain('teams.json');
    expect(topFiles).toContain('workflow_states.json');
    expect(topFiles).toContain('labels.json');
    expect(topFiles).toContain('users.json');
    expect(topFiles).toContain('issues.json');
    expect(topFiles).toContain('comments');
    expect(topFiles).toContain('mappings');
    expect(topFiles).toContain('validation_report.json');
  });

  it('writes valid JSON for each file', async () => {
    const outputDir = join(tmpDir, 'export-json');
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: commentsMap,
      parentChildMappings: [],
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 1,
          workflowStates: 2,
          labels: 1,
          users: 1,
          issues: 1,
          comments: 1,
          parentChildRelationships: 0,
        },
      },
    };

    await writeExportData(outputDir, data);

    // Verify JSON parse for each file
    const teamsContent = JSON.parse(await readFile(join(outputDir, 'teams.json'), 'utf-8')) as LinearTeam[];
    expect(teamsContent).toEqual(mockTeams);

    const statesContent = JSON.parse(await readFile(join(outputDir, 'workflow_states.json'), 'utf-8')) as LinearWorkflowState[];
    expect(statesContent).toEqual(mockStates);

    const labelsContent = JSON.parse(await readFile(join(outputDir, 'labels.json'), 'utf-8')) as LinearLabel[];
    expect(labelsContent).toEqual(mockLabels);

    const usersContent = JSON.parse(await readFile(join(outputDir, 'users.json'), 'utf-8')) as LinearUser[];
    expect(usersContent).toEqual(mockUsers);

    const issuesContent = JSON.parse(await readFile(join(outputDir, 'issues.json'), 'utf-8')) as LinearIssue[];
    expect(issuesContent).toEqual(mockIssues);
  });

  it('writes per-issue comment files in comments/ directory', async () => {
    const outputDir = join(tmpDir, 'export-comments');
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: commentsMap,
      parentChildMappings: [],
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 1,
          workflowStates: 2,
          labels: 1,
          users: 1,
          issues: 1,
          comments: 1,
          parentChildRelationships: 0,
        },
      },
    };

    await writeExportData(outputDir, data);

    const commentFiles = await readdir(join(outputDir, 'comments'));
    expect(commentFiles).toContain('iss-1.json');

    const commentContent = JSON.parse(
      await readFile(join(outputDir, 'comments', 'iss-1.json'), 'utf-8'),
    ) as LinearComment[];
    expect(commentContent).toEqual(mockComments);
    expect(commentContent[0]!.user?.name).toBe('Alice');
    expect(commentContent[0]!.createdAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('writes parent_child.json in mappings/ directory', async () => {
    const outputDir = join(tmpDir, 'export-mappings');
    const parentChildMappings = [
      { parentId: 'iss-1', childId: 'iss-2', parentIdentifier: 'ENG-1', childIdentifier: 'ENG-2' },
    ];

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: new Map(),
      parentChildMappings,
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 1,
          workflowStates: 2,
          labels: 1,
          users: 1,
          issues: 1,
          comments: 0,
          parentChildRelationships: 1,
        },
      },
    };

    await writeExportData(outputDir, data);

    const mappingContent = JSON.parse(
      await readFile(join(outputDir, 'mappings', 'parent_child.json'), 'utf-8'),
    ) as typeof parentChildMappings;
    expect(mappingContent).toEqual(parentChildMappings);
  });

  it('writes validation_report.json with entity counts', async () => {
    const outputDir = join(tmpDir, 'export-report');
    const report = {
      exportedAt: '2024-01-05T00:00:00.000Z',
      counts: {
        teams: 1,
        workflowStates: 2,
        labels: 1,
        users: 1,
        issues: 1,
        comments: 1,
        parentChildRelationships: 0,
      },
    };

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: new Map(),
      parentChildMappings: [],
      validationReport: report,
    };

    await writeExportData(outputDir, data);

    const reportContent = JSON.parse(
      await readFile(join(outputDir, 'validation_report.json'), 'utf-8'),
    ) as typeof report;
    expect(reportContent).toEqual(report);
  });

  it('does not write unrelated team data when given scoped export data', async () => {
    const outputDir = join(tmpDir, 'export-scoped');
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: commentsMap,
      parentChildMappings: [],
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 1,
          workflowStates: 2,
          labels: 1,
          users: 1,
          issues: 1,
          comments: 1,
          parentChildRelationships: 0,
        },
      },
    };

    await writeExportData(outputDir, data);

    const teamsContent = await readFile(join(outputDir, 'teams.json'), 'utf-8');
    const issuesContent = await readFile(join(outputDir, 'issues.json'), 'utf-8');
    const usersContent = await readFile(join(outputDir, 'users.json'), 'utf-8');
    const reportContent = await readFile(join(outputDir, 'validation_report.json'), 'utf-8');

    expect(teamsContent).not.toContain('Design');
    expect(issuesContent).not.toContain('DES-1');
    expect(usersContent).not.toContain('bob@example.com');
    expect(reportContent).toContain('"teams": 1');
    expect(reportContent).toContain('"issues": 1');
  });

  it('handles empty data (no issues, no comments)', async () => {
    const outputDir = join(tmpDir, 'export-empty');

    const data: ExportData = {
      teams: [],
      workflowStates: [],
      labels: [],
      users: [],
      issues: [],
      comments: new Map(),
      parentChildMappings: [],
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 0,
          workflowStates: 0,
          labels: 0,
          users: 0,
          issues: 0,
          comments: 0,
          parentChildRelationships: 0,
        },
      },
    };

    await writeExportData(outputDir, data);

    const teamsContent = JSON.parse(await readFile(join(outputDir, 'teams.json'), 'utf-8')) as LinearTeam[];
    expect(teamsContent).toEqual([]);

    const issuesContent = JSON.parse(await readFile(join(outputDir, 'issues.json'), 'utf-8')) as LinearIssue[];
    expect(issuesContent).toEqual([]);

    const commentFiles = await readdir(join(outputDir, 'comments'));
    expect(commentFiles).toEqual([]);
  });

  it('handles multiple issues with comments', async () => {
    const outputDir = join(tmpDir, 'export-multi');
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);
    commentsMap.set('iss-2', [{
      id: 'com-3',
      body: 'Another comment',
      createdAt: '2024-01-04T00:00:00.000Z',
      updatedAt: '2024-01-04T00:00:00.000Z',
      user: null,
    }]);

    const data: ExportData = {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: commentsMap,
      parentChildMappings: [],
      validationReport: {
        exportedAt: '2024-01-05T00:00:00.000Z',
        counts: {
          teams: 1,
          workflowStates: 2,
          labels: 1,
          users: 1,
          issues: 1,
          comments: 2,
          parentChildRelationships: 0,
        },
      },
    };

    await writeExportData(outputDir, data);

    const commentFiles = await readdir(join(outputDir, 'comments'));
    expect(commentFiles).toContain('iss-1.json');
    expect(commentFiles).toContain('iss-2.json');

    const iss2Comments = JSON.parse(
      await readFile(join(outputDir, 'comments', 'iss-2.json'), 'utf-8'),
    ) as LinearComment[];
    expect(iss2Comments).toHaveLength(1);
    expect(iss2Comments[0]!.user).toBeNull();
  });
});
