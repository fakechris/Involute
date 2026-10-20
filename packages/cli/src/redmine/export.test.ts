import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RedmineClient } from './client.js';
import { deriveNamespace, exportRedmine } from './export.js';
import type {
  RedmineIssue,
  RedmineIssueDetail,
  RedmineIssueStatus,
  RedmineProject,
  RedmineTracker,
  RedmineUser,
} from './types.js';

const PROJECTS: RedmineProject[] = [
  { id: 9, identifier: 'demo', name: 'Demo Project', created_on: '2024-01-01T00:00:00.000Z', updated_on: '2024-01-02T00:00:00.000Z' },
  { id: 10, identifier: 'other', name: 'Other Project', created_on: '2024-01-01T00:00:00.000Z', updated_on: '2024-01-02T00:00:00.000Z' },
];

const USERS: RedmineUser[] = [
  { id: 1, login: 'ann', firstname: 'Ann', lastname: 'Li', mail: 'ann@example.com' },
  { id: 2, login: 'bo', firstname: 'Bo', lastname: 'Wang', mail: 'bo@example.com' },
];

const TRACKERS: RedmineTracker[] = [{ id: 1, name: '错误' }];

const STATUSES: RedmineIssueStatus[] = [
  { id: 1, name: '新建', is_default: true },
  { id: 2, name: '进行中' },
  { id: 3, name: '已解决', is_closed: true },
  { id: 4, name: '已拒绝', is_closed: true },
];

const ISSUES: RedmineIssue[] = [
  {
    id: 43238,
    project: { id: 9, name: 'Demo Project' },
    tracker: { id: 1, name: '错误' },
    status: { id: 2, name: '进行中' },
    priority: { id: 2, name: '普通' },
    author: { id: 1, name: 'Ann Li' },
    assigned_to: { id: 2, name: 'Bo Wang' },
    subject: 'Fix the thing',
    description: 'the body',
    created_on: '2024-02-01T00:00:00.000Z',
    updated_on: '2024-02-03T00:00:00.000Z',
  },
  {
    id: 43239,
    project: { id: 9, name: 'Demo Project' },
    tracker: { id: 1, name: '错误' },
    status: { id: 3, name: '已解决' },
    priority: { id: 3, name: '高' },
    author: { id: 1, name: 'Ann Li' },
    subject: 'Ship it',
    description: '',
    created_on: '2024-03-01T00:00:00.000Z',
    updated_on: '2024-03-02T00:00:00.000Z',
  },
];

const DETAILS = new Map<number, RedmineIssueDetail>([
  [
    43238,
    {
      ...ISSUES[0]!,
      journals: [
        { id: 900, user: { id: 2, name: 'Bo Wang' }, notes: 'done', created_on: '2024-02-02T00:00:00.000Z' },
      ],
    },
  ],
]);

function fakeClient(overrides: Partial<RedmineClient> = {}): RedmineClient {
  return {
    listProjects: async () => PROJECTS,
    listUsers: async () => USERS,
    listTrackers: async () => TRACKERS,
    listIssueStatuses: async () => STATUSES,
    listIssues: async () => ISSUES,
    getIssueDetail: async (id: number) => DETAILS.get(id) ?? { ...ISSUES[0]!, id },
    getUser: async () => null,
    ...overrides,
  } as unknown as RedmineClient;
}

describe('the Redmine export (INV-1288)', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'redmine-export-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('namespaces the legacy ids by source, so two Redmines cannot collide', () => {
    expect(deriveNamespace('https://redmine.91jinrong.com')).toBe('rm-redmine-91jinrong-com');
    expect(deriveNamespace('https://redmine.other.example.com/x')).toBe('rm-redmine-other-example-com');
    expect(deriveNamespace('not a url')).toBe('rm-redmine');
  });

  it('builds a project → issue hierarchy with matching repositories', async () => {
    const summary = await exportRedmine({
      client: fakeClient(),
      outputDir,
      sourceUrl: 'https://redmine.91jinrong.com',
      teamKey: 'RD',
      teamName: 'Redmine 迁移',
    });

    expect(summary.namespace).toBe('rm-redmine-91jinrong-com');
    expect(summary.issues).toBe(4); // 2 projects + 2 issues

    const issues = JSON.parse(await readFile(join(outputDir, 'issues.json'), 'utf8')) as Array<{
      id: string;
      identifier: string;
      kind: string;
      repository: string;
      parent: { id: string } | null;
      state: { id: string; name: string };
      priority: number;
      assignee: { email: string } | null;
    }>;

    const project = issues.find((issue) => issue.kind === 'PROJECT')!;
    const issue = issues.find((issue) => issue.kind === 'ISSUE')!;

    // The Redmine number survives, so "43238" still finds the work.
    expect(issue.identifier).toBe('RD-43238');
    expect(project.identifier).toBe('RD-1000009');
    expect(issue.parent?.id).toBe(project.id);
    // A CONTAINS edge needs both ends to agree on the repository.
    expect(issue.repository).toBe(project.repository);
    expect(issue.repository).toBe('redmine/demo');
    // A closed Redmine status lands in Done, an open one in progress.
    expect(issue.state.name).toBe('In Progress');
    expect(issues.find((entry) => entry.identifier === 'RD-43239')?.state.name).toBe('Done');
    expect(issue.priority).toBe(2);
    expect(issue.assignee?.email).toBe('bo@example.com');
  });

  it('says which hierarchy it produced, so the importer links the parents', async () => {
    await exportRedmine({
      client: fakeClient(),
      outputDir,
      sourceUrl: 'https://redmine.91jinrong.com',
      teamKey: 'RD',
      teamName: 'Redmine 迁移',
    });

    const hierarchy = JSON.parse(await readFile(join(outputDir, 'hierarchy.json'), 'utf8'));
    expect(hierarchy).toEqual({ enabled: true });
  });

  it('writes one comment file per issue, named after the legacy id', async () => {
    await exportRedmine({
      client: fakeClient(),
      outputDir,
      sourceUrl: 'https://redmine.91jinrong.com',
      teamKey: 'RD',
      teamName: 'Redmine 迁移',
    });

    const files = await readdir(join(outputDir, 'comments'));
    expect(files).toContain('rm-redmine-91jinrong-com-issue-43238.json');

    const comments = JSON.parse(await readFile(join(outputDir, 'comments', 'rm-redmine-91jinrong-com-issue-43238.json'), 'utf8'));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('done');
  });

  it('fetches a user the list did not show, so the issue keeps its owner', async () => {
    const client = fakeClient({
      getUser: async (id: number) =>
        id === 2 ? { id: 2, login: 'bo', firstname: 'Bo', lastname: 'Wang', mail: 'bo@example.com' } : null,
      listUsers: async () => [USERS[0]!],
    });

    const summary = await exportRedmine({
      client,
      outputDir,
      sourceUrl: 'https://redmine.91jinrong.com',
      teamKey: 'RD',
      teamName: 'Redmine 迁移',
    });

    expect(summary.unmatchedUsers).toBe(0);
    expect(summary.users).toBe(2);
  });

  it('reports an owner it could not find rather than dropping it silently', async () => {
    const summary = await exportRedmine({
      client: fakeClient({
        getUser: async () => null,
        listUsers: async () => [USERS[0]!],
      }),
      outputDir,
      sourceUrl: 'https://redmine.91jinrong.com',
      teamKey: 'RD',
      teamName: 'Redmine 迁移',
    });

    expect(summary.unmatchedUsers).toBe(1);
  });
});
