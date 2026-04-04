import { PrismaClient } from '@prisma/client';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { restoreSonValidationDataset } from './son-validation-restore.js';

loadProjectEnvironment();

const prisma = new PrismaClient();

describe('restoreSonValidationDataset', () => {
  let exportDir: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.legacyLinearMapping.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.team.deleteMany();

    exportDir = await mkdtemp(join(tmpdir(), 'involute-son-restore-'));
    await writeSonExportFixture(exportDir);
  });

  it('restores SON import data and preserves repeatable validation teams', async () => {
    const summary = await restoreSonValidationDataset(prisma, exportDir);

    expect(summary.sonIssueCount).toBe(3);
    expect(summary.importResult.counts.issues).toBe(3);
    expect(summary.importResult.counts.comments).toBe(2);
    expect(summary.setupSummary.sonTeamPresent).toBe(true);

    const teams = await prisma.team.findMany({
      orderBy: { key: 'asc' },
      include: {
        _count: {
          select: { issues: true },
        },
      },
    });

    expect(teams.map((team) => team.key)).toEqual(['APP', 'INV', 'SON', 'VAL']);
    expect(teams.find((team) => team.key === 'SON')?._count.issues).toBe(3);
    expect(teams.find((team) => team.key === 'VAL')?._count.issues).toBe(0);
    expect(teams.find((team) => team.key === 'INV')?._count.issues).toBeGreaterThanOrEqual(66);
  });

  it('is idempotent across repeated restore runs', async () => {
    await restoreSonValidationDataset(prisma, exportDir);
    const second = await restoreSonValidationDataset(prisma, exportDir);

    expect(second.sonIssueCount).toBe(3);
    expect(second.importResult.skipped.issues).toBe(3);
    expect(second.importResult.skipped.comments).toBe(2);
    expect(second.setupSummary.sonTeamPresent).toBe(true);
  });

  afterAll(async () => {
    await rm(exportDir, { force: true, recursive: true }).catch(() => {});
  });
});

const SON_FIXTURE_TEAMS = [
  { id: 'linear-team-son', key: 'SON', name: 'Sonata' },
];

const SON_FIXTURE_WORKFLOW_STATES = [
  { id: 'linear-ws-1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'linear-team-son' } },
  { id: 'linear-ws-2', name: 'Ready', type: 'unstarted', position: 1, team: { id: 'linear-team-son' } },
  { id: 'linear-ws-3', name: 'In Progress', type: 'started', position: 2, team: { id: 'linear-team-son' } },
];

const SON_FIXTURE_LABELS = [
  { id: 'linear-label-1', name: 'task', color: '#cccccc' },
  { id: 'linear-label-2', name: 'Bug', color: '#ff0000' },
];

const SON_FIXTURE_USERS = [
  { id: 'linear-user-1', name: 'Sonata Admin', email: 'son-admin@example.com', displayName: 'Son Admin', active: true },
];

const SON_FIXTURE_ISSUES = [
  {
    id: 'linear-issue-1',
    identifier: 'SON-1',
    title: 'Imported SON issue 1',
    description: 'Imported fixture issue',
    priority: 1,
    createdAt: '2024-06-01T10:00:00.000Z',
    updatedAt: '2024-06-01T10:00:00.000Z',
    state: { id: 'linear-ws-1', name: 'Backlog' },
    team: { id: 'linear-team-son', key: 'SON' },
    assignee: { id: 'linear-user-1', name: 'Sonata Admin', email: 'son-admin@example.com' },
    labels: { nodes: [{ id: 'linear-label-1', name: 'task' }] },
    parent: null,
  },
  {
    id: 'linear-issue-2',
    identifier: 'SON-2',
    title: 'Imported SON issue 2',
    description: null,
    priority: 1,
    createdAt: '2024-06-02T10:00:00.000Z',
    updatedAt: '2024-06-02T10:00:00.000Z',
    state: { id: 'linear-ws-2', name: 'Ready' },
    team: { id: 'linear-team-son', key: 'SON' },
    assignee: null,
    labels: { nodes: [] },
    parent: null,
  },
  {
    id: 'linear-issue-3',
    identifier: 'SON-3',
    title: 'Imported SON child issue',
    description: 'Child issue',
    priority: 2,
    createdAt: '2024-06-03T10:00:00.000Z',
    updatedAt: '2024-06-03T10:00:00.000Z',
    state: { id: 'linear-ws-3', name: 'In Progress' },
    team: { id: 'linear-team-son', key: 'SON' },
    assignee: { id: 'linear-user-1', name: 'Sonata Admin', email: 'son-admin@example.com' },
    labels: { nodes: [{ id: 'linear-label-2', name: 'Bug' }] },
    parent: { id: 'linear-issue-1' },
  },
];

const SON_FIXTURE_COMMENTS = [
  {
    id: 'linear-comment-1',
    body: 'Imported comment one',
    createdAt: '2024-06-03T11:00:00.000Z',
    updatedAt: '2024-06-03T11:00:00.000Z',
    user: { id: 'linear-user-1', name: 'Sonata Admin', email: 'son-admin@example.com' },
  },
  {
    id: 'linear-comment-2',
    body: 'Imported comment two',
    createdAt: '2024-06-03T12:00:00.000Z',
    updatedAt: '2024-06-03T12:00:00.000Z',
    user: null,
  },
];

async function writeSonExportFixture(exportDir: string): Promise<void> {
  await mkdir(exportDir, { recursive: true });
  await mkdir(join(exportDir, 'comments'), { recursive: true });
  await mkdir(join(exportDir, 'mappings'), { recursive: true });

  await writeFile(join(exportDir, 'teams.json'), JSON.stringify(SON_FIXTURE_TEAMS, null, 2));
  await writeFile(
    join(exportDir, 'workflow_states.json'),
    JSON.stringify(SON_FIXTURE_WORKFLOW_STATES, null, 2),
  );
  await writeFile(join(exportDir, 'labels.json'), JSON.stringify(SON_FIXTURE_LABELS, null, 2));
  await writeFile(join(exportDir, 'users.json'), JSON.stringify(SON_FIXTURE_USERS, null, 2));
  await writeFile(join(exportDir, 'issues.json'), JSON.stringify(SON_FIXTURE_ISSUES, null, 2));
  await writeFile(
    join(exportDir, 'comments', 'linear-issue-1.json'),
    JSON.stringify(SON_FIXTURE_COMMENTS, null, 2),
  );
  await writeFile(
    join(exportDir, 'mappings', 'parent_child.json'),
    JSON.stringify(
      [
        {
          parentId: 'linear-issue-1',
          childId: 'linear-issue-3',
          parentIdentifier: 'SON-1',
          childIdentifier: 'SON-3',
        },
      ],
      null,
      2,
    ),
  );
}
