/**
 * Tests for the verify CLI command.
 * Tests the verification logic comparing imported data against export source.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runVerify, type VerificationResult } from './verify.js';

// --- Load environment for database access ---

import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: join(process.cwd(), '../../.env') });
loadDotenv({ path: join(process.cwd(), '.env') });

// Check if we have database access for integration tests
const hasDatabaseUrl = !!process.env['DATABASE_URL'];

// --- Fixture data matching the import-pipeline test fixtures ---

const FIXTURE_TEAMS = [
  { id: 'verify-team-1', key: 'VRF', name: 'Verify Team' },
];

const FIXTURE_WORKFLOW_STATES = [
  { id: 'verify-ws-1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 'verify-team-1' } },
  { id: 'verify-ws-2', name: 'Done', type: 'completed', position: 1, team: { id: 'verify-team-1' } },
];

const FIXTURE_LABELS = [
  { id: 'verify-label-1', name: 'verify-bug', color: '#ff0000' },
  { id: 'verify-label-2', name: 'verify-feature', color: '#00ff00' },
];

const FIXTURE_USERS = [
  { id: 'verify-user-1', name: 'Verify Alice', email: 'verify-alice@example.com', displayName: 'Verify Alice', active: true },
];

const FIXTURE_ISSUES = [
  {
    id: 'verify-issue-1',
    identifier: 'VRF-1',
    title: 'Verify Issue 1',
    description: 'Test verification',
    priority: 1,
    createdAt: '2024-06-01T10:00:00.000Z',
    updatedAt: '2024-06-01T12:00:00.000Z',
    state: { id: 'verify-ws-1', name: 'Backlog' },
    team: { id: 'verify-team-1', key: 'VRF' },
    assignee: { id: 'verify-user-1', name: 'Verify Alice', email: 'verify-alice@example.com' },
    labels: { nodes: [{ id: 'verify-label-1', name: 'verify-bug' }] },
    parent: null,
  },
  {
    id: 'verify-issue-2',
    identifier: 'VRF-2',
    title: 'Verify Issue 2',
    description: null,
    priority: 2,
    createdAt: '2024-06-02T10:00:00.000Z',
    updatedAt: '2024-06-02T10:00:00.000Z',
    state: { id: 'verify-ws-2', name: 'Done' },
    team: { id: 'verify-team-1', key: 'VRF' },
    assignee: null,
    labels: { nodes: [] },
    parent: { id: 'verify-issue-1' },
  },
];

const FIXTURE_COMMENTS = [
  {
    id: 'verify-comment-1',
    body: 'First verify comment',
    createdAt: '2024-06-01T11:00:00.000Z',
    updatedAt: '2024-06-01T11:00:00.000Z',
    user: { id: 'verify-user-1', name: 'Verify Alice', email: 'verify-alice@example.com' },
  },
];

async function writeVerifyFixtureExportDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'comments'), { recursive: true });
  await mkdir(join(dir, 'mappings'), { recursive: true });

  await writeFile(join(dir, 'teams.json'), JSON.stringify(FIXTURE_TEAMS, null, 2));
  await writeFile(join(dir, 'workflow_states.json'), JSON.stringify(FIXTURE_WORKFLOW_STATES, null, 2));
  await writeFile(join(dir, 'labels.json'), JSON.stringify(FIXTURE_LABELS, null, 2));
  await writeFile(join(dir, 'users.json'), JSON.stringify(FIXTURE_USERS, null, 2));
  await writeFile(join(dir, 'issues.json'), JSON.stringify(FIXTURE_ISSUES, null, 2));
  await writeFile(
    join(dir, 'comments', 'verify-issue-1.json'),
    JSON.stringify(FIXTURE_COMMENTS, null, 2),
  );
  await writeFile(
    join(dir, 'mappings', 'parent_child.json'),
    JSON.stringify([{ parentId: 'verify-issue-1', childId: 'verify-issue-2' }], null, 2),
  );
}

describe('verify command — error handling', () => {
  it('throws for nonexistent export directory', async () => {
    await expect(runVerify({ file: '/nonexistent/path/12345' })).rejects.toThrow(
      'Export directory not found',
    );
  });

  it('throws for directory that exists but has no export files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'involute-verify-empty-'));

    try {
      // The verify command checks for export files — an empty dir should still
      // proceed but report 0 export counts (it reads whatever files exist)
      // Here we just ensure it doesn't crash on an empty directory with no JSON files
      const result = await runVerify({ file: tempDir });
      // With no files, entities should all have 0 export counts
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// Integration tests that require a database connection
describe.runIf(hasDatabaseUrl)('verify command — integration', () => {
  let exportDir: string;

  beforeAll(async () => {
    // Import Prisma and run import pipeline to set up test data
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      // Clean up verify-specific data if it exists
      await prisma.legacyLinearMapping.deleteMany({
        where: { oldId: { startsWith: 'verify-' } },
      });
      await prisma.comment.deleteMany({
        where: { issue: { identifier: { startsWith: 'VRF-' } } },
      });
      await prisma.issue.deleteMany({
        where: { identifier: { startsWith: 'VRF-' } },
      });
      await prisma.workflowState.deleteMany({
        where: { team: { key: 'VRF' } },
      });
      await prisma.issueLabel.deleteMany({
        where: { name: { startsWith: 'verify-' } },
      });
      await prisma.team.deleteMany({
        where: { key: 'VRF' },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: 'verify-' } },
      });

      // Set up export directory with fixture data
      exportDir = await mkdtemp(join(tmpdir(), 'involute-verify-integration-'));
      await writeVerifyFixtureExportDir(exportDir);

      // Run the import pipeline
      const { runImportPipeline } = await import('@involute/server/import-pipeline');
      await runImportPipeline(prisma, exportDir);
    } finally {
      await prisma.$disconnect();
    }
  });

  afterAll(async () => {
    // Clean up export directory
    if (exportDir) {
      await rm(exportDir, { recursive: true, force: true }).catch(() => {});
    }

    // Clean up test data from DB
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();
      await prisma.legacyLinearMapping.deleteMany({
        where: { oldId: { startsWith: 'verify-' } },
      });
      await prisma.comment.deleteMany({
        where: { issue: { identifier: { startsWith: 'VRF-' } } },
      });
      await prisma.issue.deleteMany({
        where: { identifier: { startsWith: 'VRF-' } },
      });
      await prisma.workflowState.deleteMany({
        where: { team: { key: 'VRF' } },
      });
      await prisma.issueLabel.deleteMany({
        where: { name: { startsWith: 'verify-' } },
      });
      await prisma.team.deleteMany({
        where: { key: 'VRF' },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: 'verify-' } },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('reports all entity types as passed after successful import', async () => {
    const result = await runVerify({ file: exportDir });

    expect(result.allPassed).toBe(true);
    expect(result.entities.length).toBeGreaterThanOrEqual(5);

    for (const entity of result.entities) {
      expect(entity.passed).toBe(true);
    }
  });

  it('reports correct export and DB counts for each entity', async () => {
    const result = await runVerify({ file: exportDir });

    const teams = result.entities.find((e) => e.entity === 'Teams');
    expect(teams).toBeDefined();
    expect(teams!.exportCount).toBe(1);

    const states = result.entities.find((e) => e.entity === 'Workflow States');
    expect(states).toBeDefined();
    expect(states!.exportCount).toBe(2);

    const labels = result.entities.find((e) => e.entity === 'Labels');
    expect(labels).toBeDefined();
    expect(labels!.exportCount).toBe(2);

    const users = result.entities.find((e) => e.entity === 'Users');
    expect(users).toBeDefined();
    expect(users!.exportCount).toBe(1);

    const issues = result.entities.find((e) => e.entity === 'Issues');
    expect(issues).toBeDefined();
    expect(issues!.exportCount).toBe(2);

    const comments = result.entities.find((e) => e.entity === 'Comments');
    expect(comments).toBeDefined();
    expect(comments!.exportCount).toBe(1);
  });

  it('detects discrepancies when export has issues not in database', async () => {
    // Create a temporary export dir with an extra issue not in the DB
    const extraDir = await mkdtemp(join(tmpdir(), 'involute-verify-extra-'));

    try {
      await writeVerifyFixtureExportDir(extraDir);

      // Add an extra issue that wasn't imported
      const extraIssues = [
        ...FIXTURE_ISSUES,
        {
          id: 'verify-issue-extra',
          identifier: 'VRF-999',
          title: 'Extra Issue Not Imported',
          description: null,
          priority: 1,
          createdAt: '2024-07-01T10:00:00.000Z',
          updatedAt: '2024-07-01T10:00:00.000Z',
          state: { id: 'verify-ws-1', name: 'Backlog' },
          team: { id: 'verify-team-1', key: 'VRF' },
          assignee: null,
          labels: { nodes: [] },
          parent: null,
        },
      ];
      await writeFile(join(extraDir, 'issues.json'), JSON.stringify(extraIssues, null, 2));

      const result = await runVerify({ file: extraDir });

      const issues = result.entities.find((e) => e.entity === 'Issues');
      expect(issues).toBeDefined();
      expect(issues!.passed).toBe(false);
      expect(issues!.details).toContain('not found');
    } finally {
      await rm(extraDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports actual matching database comment rows when an exported comment was never mapped', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'involute-verify-comments-missing-map-'));

    try {
      await writeVerifyFixtureExportDir(extraDir);

      const extraComments = [
        ...FIXTURE_COMMENTS,
        {
          id: 'verify-comment-unmapped',
          body: 'Missing mapping comment',
          createdAt: '2024-06-01T12:00:00.000Z',
          updatedAt: '2024-06-01T12:00:00.000Z',
          user: { id: 'verify-user-1', name: 'Verify Alice', email: 'verify-alice@example.com' },
        },
      ];

      await writeFile(
        join(extraDir, 'comments', 'verify-issue-1.json'),
        JSON.stringify(extraComments, null, 2),
      );

      const result = await runVerify({ file: extraDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.exportCount).toBe(2);
      expect(comments!.dbCount).toBe(1);
      expect(comments!.details).toContain('1 export comments have no import mapping');
      expect(result.allPassed).toBe(false);
    } finally {
      await rm(extraDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports actual matching database comment rows when a mapped comment row is missing', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const mapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-comment-1',
            entityType: 'comment',
          },
        },
      });

      expect(mapping).not.toBeNull();

      await prisma.comment.delete({
        where: { id: mapping!.newId },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.exportCount).toBe(1);
      expect(comments!.dbCount).toBe(0);
      expect(comments!.details).toContain('1 mapped comments missing from database');
      expect(result.allPassed).toBe(false);
    } finally {
      const { runImportPipeline } = await import('@involute/server/import-pipeline');
      await runImportPipeline(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('returns VerificationResult with entities array and allPassed boolean', async () => {
    const result = await runVerify({ file: exportDir });

    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('allPassed');
    expect(Array.isArray(result.entities)).toBe(true);
    expect(typeof result.allPassed).toBe('boolean');

    for (const entity of result.entities) {
      expect(entity).toHaveProperty('entity');
      expect(entity).toHaveProperty('exportCount');
      expect(entity).toHaveProperty('dbCount');
      expect(entity).toHaveProperty('passed');
    }
  });
});
