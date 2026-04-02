import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exportTeams,
  exportWorkflowStates,
  exportLabels,
  exportUsers,
  exportIssues,
  exportCommentsForIssue,
  exportAllComments,
  filterExportDataToTeamScope,
  buildParentChildMapping,
  generateValidationReport,
} from './export.js';
import { LinearClient } from './client.js';
import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearUser,
  LinearIssue,
  LinearComment,
} from './types.js';

// --- Mock data ---

const mockTeams: LinearTeam[] = [
  { id: 'team-1', key: 'ENG', name: 'Engineering' },
  { id: 'team-2', key: 'DES', name: 'Design' },
];

const mockStates: LinearWorkflowState[] = [
  { id: 'ws-1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'team-1' } },
  { id: 'ws-2', name: 'In Progress', type: 'started', position: 1, team: { id: 'team-1' } },
  { id: 'ws-3', name: 'Done', type: 'completed', position: 2, team: { id: 'team-1' } },
  { id: 'ws-4', name: 'Todo', type: 'unstarted', position: 0, team: { id: 'team-2' } },
];

const mockLabels: LinearLabel[] = [
  { id: 'lbl-1', name: 'bug', color: '#ff0000' },
  { id: 'lbl-2', name: 'feature', color: '#00ff00' },
];

const mockUsers: LinearUser[] = [
  { id: 'usr-1', name: 'Alice', email: 'alice@example.com', displayName: 'Alice A.', active: true },
  { id: 'usr-2', name: 'Bob', email: 'bob@example.com', displayName: 'Bob B.', active: true },
];

function makeIssue(overrides: Partial<LinearIssue> & { id: string; identifier: string }): LinearIssue {
  return {
    title: 'Test Issue',
    description: null,
    priority: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    state: { id: 'ws-1', name: 'Backlog' },
    team: { id: 'team-1', key: 'ENG' },
    assignee: null,
    labels: { nodes: [] },
    parent: null,
    ...overrides,
  };
}

const mockIssues: LinearIssue[] = [
  makeIssue({
    id: 'iss-1',
    identifier: 'ENG-1',
    title: 'Setup CI',
    assignee: { id: 'usr-1', name: 'Alice', email: 'alice@example.com' },
    labels: { nodes: [{ id: 'lbl-1', name: 'bug' }] },
  }),
  makeIssue({
    id: 'iss-2',
    identifier: 'ENG-2',
    title: 'Build API',
    parent: { id: 'iss-1' },
  }),
  makeIssue({
    id: 'iss-3',
    identifier: 'ENG-3',
    title: 'Sub-task',
    parent: { id: 'iss-1' },
  }),
  makeIssue({
    id: 'iss-4',
    identifier: 'DES-1',
    title: 'Design issue',
    team: { id: 'team-2', key: 'DES' },
    state: { id: 'ws-4', name: 'Todo' },
    assignee: { id: 'usr-2', name: 'Bob', email: 'bob@example.com' },
  }),
];

const mockComments: LinearComment[] = [
  {
    id: 'com-1',
    body: 'First comment',
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    user: { id: 'usr-1', name: 'Alice', email: 'alice@example.com' },
  },
  {
    id: 'com-2',
    body: 'Second comment',
    createdAt: '2024-01-03T00:00:00.000Z',
    updatedAt: '2024-01-03T00:00:00.000Z',
    user: { id: 'usr-2', name: 'Bob', email: 'bob@example.com' },
  },
];

// --- Helper to create a mock client ---

function createMockClient(responses: Map<string, unknown>): LinearClient {
  const client = new LinearClient({ apiToken: 'mock-token', endpoint: 'http://mock' });

  // Override paginate to return mock data directly
  vi.spyOn(client, 'paginate').mockImplementation(
    async <TData, TNode>(
      _query: string,
      extractor: (data: TData) => { nodes: TNode[] },
      _variables?: Record<string, unknown>,
    ): Promise<TNode[]> => {
      // Determine which mock data to return based on query content
      for (const [key, value] of responses.entries()) {
        if (_query.includes(key)) {
          const extracted = extractor(value as TData);
          return extracted.nodes;
        }
      }
      return [];
    },
  );

  // Override request for direct calls
  vi.spyOn(client, 'request').mockImplementation(
    async <T>(_query: string, variables?: Record<string, unknown>): Promise<T> => {
      // For comment queries
      if (_query.includes('comments') && variables?.['issueId']) {
        const issueId = variables['issueId'] as string;
        const comments = responses.get(`comments:${issueId}`);
        if (comments) {
          return {
            issue: {
              comments: {
                nodes: comments,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          } as T;
        }
        return {
          issue: {
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T;
      }
      return {} as T;
    },
  );

  return client;
}

describe('export functions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exportTeams', () => {
    it('returns all teams from paginated results', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportTeams', {
        teams: {
          nodes: mockTeams,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const client = createMockClient(responses);
      const teams = await exportTeams(client);
      expect(teams).toEqual(mockTeams);
    });

    it('calls progress callback', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportTeams', {
        teams: {
          nodes: mockTeams,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const client = createMockClient(responses);
      const progress = vi.fn();
      await exportTeams(client, progress);
      expect(progress).toHaveBeenCalledWith('Exporting teams...');
      expect(progress).toHaveBeenCalledWith('  Exported 2 teams');
    });
  });

  describe('exportWorkflowStates', () => {
    it('returns all workflow states', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportWorkflowStates', {
        workflowStates: {
          nodes: mockStates,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const client = createMockClient(responses);
      const states = await exportWorkflowStates(client);
      expect(states).toEqual(mockStates);
    });
  });

  describe('exportLabels', () => {
    it('returns all labels', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportLabels', {
        issueLabels: {
          nodes: mockLabels,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const client = createMockClient(responses);
      const labels = await exportLabels(client);
      expect(labels).toEqual(mockLabels);
    });
  });

  describe('exportUsers', () => {
    it('returns all users', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportUsers', {
        users: {
          nodes: mockUsers,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const client = createMockClient(responses);
      const users = await exportUsers(client);
      expect(users).toEqual(mockUsers);
    });
  });

  describe('exportIssues', () => {
    it('returns all issues', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportIssues', {
        issues: {
          nodes: mockIssues,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const client = createMockClient(responses);
      const issues = await exportIssues(client);
      expect(issues).toEqual(mockIssues);
    });
  });

  describe('exportCommentsForIssue', () => {
    it('returns comments for a given issue via paginate', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportComments', {
        issue: {
          comments: {
            nodes: mockComments,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      const client = createMockClient(responses);
      const comments = await exportCommentsForIssue(client, 'iss-1');
      expect(comments).toEqual(mockComments);
    });

    it('returns empty array when issue has no comments', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportComments', {
        issue: {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      const client = createMockClient(responses);
      const comments = await exportCommentsForIssue(client, 'iss-2');
      expect(comments).toEqual([]);
    });

    it('returns empty array when issue is null (deleted)', async () => {
      const responses = new Map<string, unknown>();
      responses.set('ExportComments', {
        issue: null,
      });
      const client = createMockClient(responses);
      const comments = await exportCommentsForIssue(client, 'nonexistent');
      expect(comments).toEqual([]);
    });
  });

  describe('exportAllComments', () => {
    it('exports comments for all issues and returns a map', async () => {
      const responses = new Map<string, unknown>();
      // For issue iss-1 => has 2 comments
      responses.set('ExportComments', {
        issue: {
          comments: {
            nodes: mockComments,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const client = createMockClient(responses);

      // We need a more controlled mock for this test
      let callCount = 0;
      vi.spyOn(client, 'paginate').mockImplementation(async () => {
        callCount++;
        // First issue returns comments, others return empty
        if (callCount === 1) return mockComments as never[];
        return [] as never[];
      });

      const result = await exportAllComments(client, mockIssues);
      expect(result.size).toBe(1);
      expect(result.get('iss-1')).toEqual(mockComments);
    });

    it('reports progress', async () => {
      const client = createMockClient(new Map());
      vi.spyOn(client, 'paginate').mockResolvedValue([]);

      const progress = vi.fn();
      await exportAllComments(client, mockIssues, progress);
      expect(progress).toHaveBeenCalledWith('Exporting comments...');
    });
  });
});

describe('buildParentChildMapping', () => {
  it('builds correct parent-child relationships', () => {
    const mappings = buildParentChildMapping(mockIssues);
    expect(mappings).toHaveLength(2);
    expect(mappings).toContainEqual({
      parentId: 'iss-1',
      childId: 'iss-2',
      parentIdentifier: 'ENG-1',
      childIdentifier: 'ENG-2',
    });
    expect(mappings).toContainEqual({
      parentId: 'iss-1',
      childId: 'iss-3',
      parentIdentifier: 'ENG-1',
      childIdentifier: 'ENG-3',
    });
  });

  it('returns empty array when no parent-child relationships exist', () => {
    const issues = [
      makeIssue({ id: 'iss-10', identifier: 'ENG-10' }),
      makeIssue({ id: 'iss-11', identifier: 'ENG-11' }),
    ];
    const mappings = buildParentChildMapping(issues);
    expect(mappings).toEqual([]);
  });

  it('handles issues whose parent is outside the exported set', () => {
    const issues = [
      makeIssue({ id: 'iss-20', identifier: 'ENG-20', parent: { id: 'external-parent' } }),
    ];
    const mappings = buildParentChildMapping(issues);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.parentIdentifier).toBeUndefined();
    expect(mappings[0]!.childIdentifier).toBe('ENG-20');
  });
});

describe('filterExportDataToTeamScope', () => {
  it('keeps only entities related to the selected team', () => {
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);
    commentsMap.set('iss-4', [
      {
        id: 'com-3',
        body: 'Design comment',
        createdAt: '2024-01-04T00:00:00.000Z',
        updatedAt: '2024-01-04T00:00:00.000Z',
        user: { id: 'usr-2', name: 'Bob', email: 'bob@example.com' },
      },
    ]);

    const scoped = filterExportDataToTeamScope('ENG', {
      teams: mockTeams,
      workflowStates: mockStates,
      labels: mockLabels,
      users: mockUsers,
      issues: mockIssues,
      comments: commentsMap,
      parentChildMappings: buildParentChildMapping(mockIssues),
    });

    expect(scoped.teams.map((team) => team.key)).toEqual(['ENG']);
    expect(scoped.workflowStates.every((state) => state.team.id === 'team-1')).toBe(true);
    expect(scoped.issues.map((issue) => issue.identifier)).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
    expect([...scoped.comments.keys()]).toEqual(['iss-1']);
    expect(scoped.users.map((user) => user.id)).toEqual(['usr-1', 'usr-2']);
    expect(scoped.parentChildMappings).toEqual([
      {
        parentId: 'iss-1',
        childId: 'iss-2',
        parentIdentifier: 'ENG-1',
        childIdentifier: 'ENG-2',
      },
      {
        parentId: 'iss-1',
        childId: 'iss-3',
        parentIdentifier: 'ENG-1',
        childIdentifier: 'ENG-3',
      },
    ]);
    expect(scoped.labels).toEqual(mockLabels);
  });
});

describe('generateValidationReport', () => {
  it('produces correct entity counts', () => {
    const commentsMap = new Map<string, LinearComment[]>();
    commentsMap.set('iss-1', mockComments);

    const parentChildMappings = buildParentChildMapping(mockIssues);

    const report = generateValidationReport(
      mockTeams,
      mockStates,
      mockLabels,
      mockUsers,
      mockIssues,
      commentsMap,
      parentChildMappings,
    );

    expect(report.counts.teams).toBe(2);
    expect(report.counts.workflowStates).toBe(4);
    expect(report.counts.labels).toBe(2);
    expect(report.counts.users).toBe(2);
    expect(report.counts.issues).toBe(4);
    expect(report.counts.comments).toBe(2);
    expect(report.counts.parentChildRelationships).toBe(2);
    expect(report.exportedAt).toBeTruthy();
  });

  it('handles empty data correctly', () => {
    const report = generateValidationReport(
      [], [], [], [], [], new Map(), [],
    );

    expect(report.counts.teams).toBe(0);
    expect(report.counts.workflowStates).toBe(0);
    expect(report.counts.labels).toBe(0);
    expect(report.counts.users).toBe(0);
    expect(report.counts.issues).toBe(0);
    expect(report.counts.comments).toBe(0);
    expect(report.counts.parentChildRelationships).toBe(0);
  });
});
