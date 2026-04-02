import type { PrismaClient } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { runImportPipeline, type ImportResult } from './import-pipeline.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

// --- Fixture data matching Linear export format ---

const FIXTURE_TEAMS = [
  { id: 'linear-team-1', key: 'SON', name: 'Sonata' },
  { id: 'linear-team-2', key: 'EMP', name: 'Empty Team' },
];

const FIXTURE_WORKFLOW_STATES = [
  { id: 'linear-ws-1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'linear-team-1' } },
  { id: 'linear-ws-2', name: 'In Progress', type: 'started', position: 1, team: { id: 'linear-team-1' } },
  { id: 'linear-ws-3', name: 'Done', type: 'completed', position: 2, team: { id: 'linear-team-1' } },
  { id: 'linear-ws-4', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'linear-team-2' } },
  { id: 'linear-ws-5', name: 'Done', type: 'completed', position: 1, team: { id: 'linear-team-2' } },
];

const FIXTURE_LABELS = [
  { id: 'linear-label-1', name: 'bug', color: '#ff0000' },
  { id: 'linear-label-2', name: 'feature', color: '#00ff00' },
  { id: 'linear-label-3', name: 'urgent', color: '#ff6600' },
];

const FIXTURE_USERS = [
  { id: 'linear-user-1', name: 'Alice Smith', email: 'alice@example.com', displayName: 'Alice', active: true },
  { id: 'linear-user-2', name: 'Bob Jones', email: 'bob@example.com', displayName: 'Bob', active: true },
];

const FIXTURE_ISSUES = [
  {
    id: 'linear-issue-1',
    identifier: 'SON-42',
    title: 'Fix login bug',
    description: 'Users cannot log in',
    priority: 1,
    createdAt: '2024-06-01T10:00:00.000Z',
    updatedAt: '2024-06-02T15:00:00.000Z',
    state: { id: 'linear-ws-2', name: 'In Progress' },
    team: { id: 'linear-team-1', key: 'SON' },
    assignee: { id: 'linear-user-1', name: 'Alice Smith', email: 'alice@example.com' },
    labels: { nodes: [{ id: 'linear-label-1', name: 'bug' }, { id: 'linear-label-3', name: 'urgent' }] },
    parent: null,
  },
  {
    id: 'linear-issue-2',
    identifier: 'SON-43',
    title: 'Add dashboard widget',
    description: null,
    priority: 2,
    createdAt: '2024-06-03T08:00:00.000Z',
    updatedAt: '2024-06-03T08:00:00.000Z',
    state: { id: 'linear-ws-1', name: 'Backlog' },
    team: { id: 'linear-team-1', key: 'SON' },
    assignee: null,
    labels: { nodes: [] },
    parent: null,
  },
  {
    id: 'linear-issue-3',
    identifier: 'SON-44',
    title: 'Sub-task of login fix',
    description: 'Handle OAuth redirect',
    priority: 1,
    createdAt: '2024-06-01T12:00:00.000Z',
    updatedAt: '2024-06-04T09:00:00.000Z',
    state: { id: 'linear-ws-1', name: 'Backlog' },
    team: { id: 'linear-team-1', key: 'SON' },
    assignee: { id: 'linear-user-2', name: 'Bob Jones', email: 'bob@example.com' },
    labels: { nodes: [{ id: 'linear-label-2', name: 'feature' }] },
    parent: { id: 'linear-issue-1' },
  },
];

const FIXTURE_COMMENTS_ISSUE_1 = [
  {
    id: 'linear-comment-1',
    body: 'Looking into this now',
    createdAt: '2024-06-01T11:00:00.000Z',
    updatedAt: '2024-06-01T11:00:00.000Z',
    user: { id: 'linear-user-1', name: 'Alice Smith', email: 'alice@example.com' },
  },
  {
    id: 'linear-comment-2',
    body: 'Found the root cause',
    createdAt: '2024-06-02T14:00:00.000Z',
    updatedAt: '2024-06-02T14:00:00.000Z',
    user: { id: 'linear-user-2', name: 'Bob Jones', email: 'bob@example.com' },
  },
];

const FIXTURE_COMMENTS_ISSUE_3 = [
  {
    id: 'linear-comment-3',
    body: 'Orphan-safe comment',
    createdAt: '2024-06-05T10:00:00.000Z',
    updatedAt: '2024-06-05T10:00:00.000Z',
    user: null,
  },
];

const FIXTURE_PARENT_CHILD_MAPPINGS = [
  { parentId: 'linear-issue-1', childId: 'linear-issue-3', parentIdentifier: 'SON-42', childIdentifier: 'SON-44' },
];

// --- Helpers ---

async function writeFixtureExportDirectory(exportDir: string): Promise<void> {
  await mkdir(exportDir, { recursive: true });
  await mkdir(join(exportDir, 'comments'), { recursive: true });
  await mkdir(join(exportDir, 'mappings'), { recursive: true });

  await writeFile(join(exportDir, 'teams.json'), JSON.stringify(FIXTURE_TEAMS, null, 2));
  await writeFile(join(exportDir, 'workflow_states.json'), JSON.stringify(FIXTURE_WORKFLOW_STATES, null, 2));
  await writeFile(join(exportDir, 'labels.json'), JSON.stringify(FIXTURE_LABELS, null, 2));
  await writeFile(join(exportDir, 'users.json'), JSON.stringify(FIXTURE_USERS, null, 2));
  await writeFile(join(exportDir, 'issues.json'), JSON.stringify(FIXTURE_ISSUES, null, 2));

  await writeFile(
    join(exportDir, 'comments', 'linear-issue-1.json'),
    JSON.stringify(FIXTURE_COMMENTS_ISSUE_1, null, 2),
  );
  await writeFile(
    join(exportDir, 'comments', 'linear-issue-3.json'),
    JSON.stringify(FIXTURE_COMMENTS_ISSUE_3, null, 2),
  );

  await writeFile(
    join(exportDir, 'mappings', 'parent_child.json'),
    JSON.stringify(FIXTURE_PARENT_CHILD_MAPPINGS, null, 2),
  );
}

async function clearDatabase(client: PrismaClient): Promise<void> {
  await client.legacyLinearMapping.deleteMany();
  await client.comment.deleteMany();
  await client.issue.deleteMany();
  await client.workflowState.deleteMany();
  await client.team.deleteMany();
  await client.issueLabel.deleteMany();
  await client.user.deleteMany();
}

// --- Tests ---

describe('import pipeline', () => {
  let exportDir: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await clearDatabase(prisma);
    exportDir = await mkdtemp(join(tmpdir(), 'involute-import-test-'));
    await writeFixtureExportDirectory(exportDir);
  });

  it('imports all teams including empty ones', async () => {
    const result = await runImportPipeline(prisma, exportDir);

    expect(result.counts.teams).toBe(2);

    const teams = await prisma.team.findMany({ orderBy: { key: 'asc' } });
    expect(teams).toHaveLength(2);
    expect(teams.map((t) => t.key)).toEqual(['EMP', 'SON']);
    expect(teams.map((t) => t.name)).toEqual(['Empty Team', 'Sonata']);
  });

  it('imports workflow states per team', async () => {
    await runImportPipeline(prisma, exportDir);

    const states = await prisma.workflowState.findMany({
      include: { team: true },
      orderBy: [{ team: { key: 'asc' } }, { name: 'asc' }],
    });

    expect(states).toHaveLength(5);

    const sonataStates = states.filter((s) => s.team.key === 'SON');
    expect(sonataStates.map((s) => s.name).sort()).toEqual(['Backlog', 'Done', 'In Progress']);

    const emptyTeamStates = states.filter((s) => s.team.key === 'EMP');
    expect(emptyTeamStates.map((s) => s.name).sort()).toEqual(['Backlog', 'Done']);
  });

  it('imports labels by name', async () => {
    await runImportPipeline(prisma, exportDir);

    const labels = await prisma.issueLabel.findMany({ orderBy: { name: 'asc' } });
    expect(labels).toHaveLength(3);
    expect(labels.map((l) => l.name)).toEqual(['bug', 'feature', 'urgent']);
  });

  it('imports users with name and email preserved', async () => {
    await runImportPipeline(prisma, exportDir);

    const users = await prisma.user.findMany({ orderBy: { email: 'asc' } });
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ name: 'Alice Smith', email: 'alice@example.com' });
    expect(users[1]).toMatchObject({ name: 'Bob Jones', email: 'bob@example.com' });
  });

  it('imports issues with exact count matching export', async () => {
    const result = await runImportPipeline(prisma, exportDir);

    expect(result.counts.issues).toBe(3);

    const issueCount = await prisma.issue.count();
    expect(issueCount).toBe(FIXTURE_ISSUES.length);
  });

  it('preserves issue identifiers exactly (e.g., SON-42)', async () => {
    await runImportPipeline(prisma, exportDir);

    const issues = await prisma.issue.findMany({ orderBy: { identifier: 'asc' } });
    expect(issues.map((i) => i.identifier)).toEqual(['SON-42', 'SON-43', 'SON-44']);
  });

  it('preserves issue createdAt and updatedAt timestamps from source', async () => {
    await runImportPipeline(prisma, exportDir);

    const issue = await prisma.issue.findUnique({ where: { identifier: 'SON-42' } });
    expect(issue).not.toBeNull();
    expect(issue!.createdAt.toISOString()).toBe('2024-06-01T10:00:00.000Z');
    expect(issue!.updatedAt.toISOString()).toBe('2024-06-02T15:00:00.000Z');
  });

  it('preserves parent-child relationships via ID mapping', async () => {
    await runImportPipeline(prisma, exportDir);

    const parent = await prisma.issue.findUnique({ where: { identifier: 'SON-42' } });
    const child = await prisma.issue.findUnique({ where: { identifier: 'SON-44' } });

    expect(parent).not.toBeNull();
    expect(child).not.toBeNull();
    expect(child!.parentId).toBe(parent!.id);

    const children = await prisma.issue.findMany({
      where: { parentId: parent!.id },
      orderBy: { identifier: 'asc' },
    });
    expect(children).toHaveLength(1);
    expect(children[0]!.identifier).toBe('SON-44');
  });

  it('imports issues without assignee correctly', async () => {
    await runImportPipeline(prisma, exportDir);

    const unassigned = await prisma.issue.findUnique({ where: { identifier: 'SON-43' } });
    expect(unassigned).not.toBeNull();
    expect(unassigned!.assigneeId).toBeNull();
  });

  it('imports issues without labels correctly', async () => {
    await runImportPipeline(prisma, exportDir);

    const noLabels = await prisma.issue.findUnique({
      where: { identifier: 'SON-43' },
      include: { labels: true },
    });
    expect(noLabels).not.toBeNull();
    expect(noLabels!.labels).toHaveLength(0);
  });

  it('imports issues with labels correctly', async () => {
    await runImportPipeline(prisma, exportDir);

    const withLabels = await prisma.issue.findUnique({
      where: { identifier: 'SON-42' },
      include: { labels: { orderBy: { name: 'asc' } } },
    });
    expect(withLabels).not.toBeNull();
    expect(withLabels!.labels.map((l) => l.name)).toEqual(['bug', 'urgent']);
  });

  it('imports comments in chronological createdAt order preserving timestamps', async () => {
    await runImportPipeline(prisma, exportDir);

    const parent = await prisma.issue.findUnique({ where: { identifier: 'SON-42' } });
    expect(parent).not.toBeNull();

    const comments = await prisma.comment.findMany({
      where: { issueId: parent!.id },
      orderBy: { createdAt: 'asc' },
      include: { user: true },
    });

    expect(comments).toHaveLength(2);
    expect(comments[0]!.body).toBe('Looking into this now');
    expect(comments[0]!.createdAt.toISOString()).toBe('2024-06-01T11:00:00.000Z');
    expect(comments[0]!.updatedAt.toISOString()).toBe('2024-06-01T11:00:00.000Z');
    expect(comments[0]!.user.email).toBe('alice@example.com');

    expect(comments[1]!.body).toBe('Found the root cause');
    expect(comments[1]!.createdAt.toISOString()).toBe('2024-06-02T14:00:00.000Z');
    expect(comments[1]!.updatedAt.toISOString()).toBe('2024-06-02T14:00:00.000Z');
    expect(comments[1]!.user.email).toBe('bob@example.com');
  });

  it('handles comments with null user by skipping them', async () => {
    await runImportPipeline(prisma, exportDir);

    const child = await prisma.issue.findUnique({ where: { identifier: 'SON-44' } });
    expect(child).not.toBeNull();

    // The comment with null user should be skipped
    const comments = await prisma.comment.findMany({
      where: { issueId: child!.id },
    });
    expect(comments).toHaveLength(0);
  });

  it('writes legacy_linear_mapping entries for all entities', async () => {
    await runImportPipeline(prisma, exportDir);

    const mappings = await prisma.legacyLinearMapping.findMany({
      orderBy: [{ entityType: 'asc' }, { oldId: 'asc' }],
    });

    const teamMappings = mappings.filter((m) => m.entityType === 'team');
    expect(teamMappings).toHaveLength(2);

    const stateMappings = mappings.filter((m) => m.entityType === 'workflow_state');
    expect(stateMappings).toHaveLength(5);

    const labelMappings = mappings.filter((m) => m.entityType === 'label');
    expect(labelMappings).toHaveLength(3);

    const userMappings = mappings.filter((m) => m.entityType === 'user');
    expect(userMappings).toHaveLength(2);

    const issueMappings = mappings.filter((m) => m.entityType === 'issue');
    expect(issueMappings).toHaveLength(3);

    const commentMappings = mappings.filter((m) => m.entityType === 'comment');
    expect(commentMappings).toHaveLength(2);
  });

  it('ID mapping is bijective — each oldId and newId is unique per entity type', async () => {
    await runImportPipeline(prisma, exportDir);

    const mappings = await prisma.legacyLinearMapping.findMany();

    const entityTypes = [...new Set(mappings.map((m) => m.entityType))];

    for (const entityType of entityTypes) {
      const typeMappings = mappings.filter((m) => m.entityType === entityType);
      const oldIds = typeMappings.map((m) => m.oldId);
      const newIds = typeMappings.map((m) => m.newId);

      expect(new Set(oldIds).size).toBe(oldIds.length);
      expect(new Set(newIds).size).toBe(newIds.length);
    }
  });

  it('re-import is idempotent — skips already-imported records and does not create duplicates', async () => {
    const firstResult = await runImportPipeline(prisma, exportDir);
    const firstIssueCount = await prisma.issue.count();
    const firstMappingCount = await prisma.legacyLinearMapping.count();

    const secondResult = await runImportPipeline(prisma, exportDir);
    const secondIssueCount = await prisma.issue.count();
    const secondMappingCount = await prisma.legacyLinearMapping.count();

    expect(secondIssueCount).toBe(firstIssueCount);
    expect(secondMappingCount).toBe(firstMappingCount);

    // Verify skipped counts
    expect(secondResult.skipped.teams).toBe(2);
    expect(secondResult.skipped.issues).toBe(3);
    expect(secondResult.skipped.users).toBe(2);
  });

  it('returns a summary result with counts', async () => {
    const result = await runImportPipeline(prisma, exportDir);

    expect(result.counts.teams).toBe(2);
    expect(result.counts.workflowStates).toBe(5);
    expect(result.counts.labels).toBe(3);
    expect(result.counts.users).toBe(2);
    expect(result.counts.issues).toBe(3);
    expect(result.counts.comments).toBe(2);
    expect(result.counts.parentChildBackfills).toBe(1);
  });

  it('sets team nextIssueNumber correctly based on imported identifiers', async () => {
    await runImportPipeline(prisma, exportDir);

    const sonata = await prisma.team.findUnique({ where: { key: 'SON' } });
    expect(sonata).not.toBeNull();
    // SON-42, SON-43, SON-44 → nextIssueNumber should be 45
    expect(sonata!.nextIssueNumber).toBe(45);

    const emptyTeam = await prisma.team.findUnique({ where: { key: 'EMP' } });
    expect(emptyTeam).not.toBeNull();
    // Empty team, no issues → nextIssueNumber should stay at 1
    expect(emptyTeam!.nextIssueNumber).toBe(1);
  });

  it('correctly links issues to their workflow states', async () => {
    await runImportPipeline(prisma, exportDir);

    const issue = await prisma.issue.findUnique({
      where: { identifier: 'SON-42' },
      include: { state: true },
    });
    expect(issue).not.toBeNull();
    expect(issue!.state.name).toBe('In Progress');
  });

  it('correctly links issues to their team', async () => {
    await runImportPipeline(prisma, exportDir);

    const issue = await prisma.issue.findUnique({
      where: { identifier: 'SON-42' },
      include: { team: true },
    });
    expect(issue).not.toBeNull();
    expect(issue!.team.key).toBe('SON');
  });

  it('correctly links issues to their assignees', async () => {
    await runImportPipeline(prisma, exportDir);

    const issue = await prisma.issue.findUnique({
      where: { identifier: 'SON-42' },
      include: { assignee: true },
    });
    expect(issue).not.toBeNull();
    expect(issue!.assignee).not.toBeNull();
    expect(issue!.assignee!.email).toBe('alice@example.com');
  });

  it('accepts a progress callback for reporting', async () => {
    const messages: string[] = [];
    await runImportPipeline(prisma, exportDir, (msg) => messages.push(msg));

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.toLowerCase().includes('team'))).toBe(true);
    expect(messages.some((m) => m.toLowerCase().includes('issue'))).toBe(true);
    expect(messages.some((m) => m.toLowerCase().includes('comment'))).toBe(true);
  });
});
