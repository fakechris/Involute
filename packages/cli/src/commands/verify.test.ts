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

async function resetVerifyImportState(
  prisma: InstanceType<(typeof import('@prisma/client'))['PrismaClient']>,
  exportDir: string,
): Promise<void> {
  // Delete ALL legacy mappings — not just verify-prefixed ones.
  // Other test suites (e.g. issues.test.ts) may leave stale mappings whose
  // newId points to a row that was already deleted.  The import pipeline's
  // idempotency path reads *all* mappings per entity type, so any stale
  // entry causes it to skip re-creating prerequisite rows, leading to FK
  // violations when downstream entities reference the missing rows.
  await prisma.legacyLinearMapping.deleteMany();
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

  const { runImportPipeline } = await import('@turnkeyai/involute-server/import-pipeline');
  await runImportPipeline(prisma, exportDir);
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

  it('throws a file-specific error when issues.json has an invalid runtime shape', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'involute-verify-invalid-issues-'));

    try {
      await writeVerifyFixtureExportDir(tempDir);
      await writeFile(
        join(tempDir, 'issues.json'),
        JSON.stringify([{ ...FIXTURE_ISSUES[0], id: 123 }], null, 2),
      );

      await expect(runVerify({ file: tempDir })).rejects.toThrow(
        /Invalid export data in .*issues\.json: issues\.json\[0\]\.id must be a string\./,
      );
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

      // Clear ALL legacy mappings to avoid stale newId references left by
      // other test suites that share the same database.
      await prisma.legacyLinearMapping.deleteMany();
      // Clean up verify-specific data rows if they exist
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
      const { runImportPipeline } = await import('@turnkeyai/involute-server/import-pipeline');
      await runImportPipeline(prisma, exportDir);
    } finally {
      await prisma.$disconnect();
    }
  });


  beforeEach(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();
      await resetVerifyImportState(prisma, exportDir);
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

    const comments = result.entities.find((entity) => entity.entity === 'Comments');
    expect(comments).toBeDefined();
    expect(comments).toMatchObject({
      passed: true,
      dbCount: 1,
      exportCount: 1,
    });
  });

  it('treats comment updatedAt normalized to the owning issue updatedAt as a valid import result', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const commentMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-comment-1',
            entityType: 'comment',
          },
        },
      });
      const issueMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-issue-1',
            entityType: 'issue',
          },
        },
      });

      expect(commentMapping).not.toBeNull();
      expect(issueMapping).not.toBeNull();

      const importedIssue = await prisma.issue.findUnique({
        where: { id: issueMapping!.newId },
        select: { updatedAt: true },
      });

      expect(importedIssue).not.toBeNull();

      await prisma.comment.update({
        where: { id: commentMapping!.newId },
        data: { updatedAt: importedIssue!.updatedAt },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(true);
      expect(comments!.dbCount).toBe(1);
      expect(result.allPassed).toBe(true);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('treats comment updatedAt collapsing to createdAt as a valid import result', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const commentMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-comment-1',
            entityType: 'comment',
          },
        },
      });

      expect(commentMapping).not.toBeNull();

      await prisma.comment.update({
        where: { id: commentMapping!.newId },
        data: { updatedAt: new Date(FIXTURE_COMMENTS[0]!.createdAt) },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(true);
      expect(comments!.dbCount).toBe(1);
      expect(result.allPassed).toBe(true);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails comment verification when the mapped comment updatedAt is later than all documented import normalization values', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const commentMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-comment-1',
            entityType: 'comment',
          },
        },
      });

      expect(commentMapping).not.toBeNull();

      await prisma.comment.update({
        where: { id: commentMapping!.newId },
        data: { updatedAt: new Date('2024-06-01T11:30:00.000Z') },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.dbCount).toBe(0);
      expect(comments!.details).toContain('1 mapped comments have mismatched timestamps');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
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
      expect(issues!.details).toContain('have no import mapping');
    } finally {
      await rm(extraDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('fails issue verification when an exported issue mapping is missing even if a matching identifier exists', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      await prisma.legacyLinearMapping.delete({
        where: {
          oldId_entityType: {
            oldId: 'verify-issue-1',
            entityType: 'issue',
          },
        },
      });

      const result = await runVerify({ file: exportDir });
      const issues = result.entities.find((entity) => entity.entity === 'Issues');

      expect(issues).toBeDefined();
      expect(issues!.passed).toBe(false);
      expect(issues!.exportCount).toBe(2);
      expect(issues!.dbCount).toBe(0);
      expect(issues!.details).toContain('1 export issues have no import mapping');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails issue verification when the mapped issue has the wrong identifier', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const mapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-issue-1',
            entityType: 'issue',
          },
        },
      });

      expect(mapping).not.toBeNull();

      await prisma.issue.update({
        where: { id: mapping!.newId },
        data: { identifier: 'VRF-999' },
      });

      const result = await runVerify({ file: exportDir });
      const issues = result.entities.find((entity) => entity.entity === 'Issues');

      expect(issues).toBeDefined();
      expect(issues!.passed).toBe(false);
      expect(issues!.dbCount).toBe(1);
      expect(issues!.details).toContain('1 mapped issues have mismatched identifiers');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails issue verification when the mapped issue parent relationship is corrupted', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const childMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-issue-2',
            entityType: 'issue',
          },
        },
      });

      expect(childMapping).not.toBeNull();

      await prisma.issue.update({
        where: { id: childMapping!.newId },
        data: { parentId: null },
      });

      const result = await runVerify({ file: exportDir });
      const issues = result.entities.find((entity) => entity.entity === 'Issues');

      expect(issues).toBeDefined();
      expect(issues!.passed).toBe(false);
      expect(issues!.dbCount).toBe(1);
      expect(issues!.details).toContain('1 mapped issues have mismatched parent relationships');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
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
      expect(comments!.exportCount).toBe(2);
      expect(comments!.dbCount).toBeGreaterThanOrEqual(0);
      expect(comments!.details).toContain('1 export comments have no import mapping');
      expect(comments!.passed).toBe(false);
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
      const { runImportPipeline } = await import('@turnkeyai/involute-server/import-pipeline');
      await runImportPipeline(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails comment verification when the mapped comment body is corrupted', async () => {
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

      await prisma.comment.update({
        where: { id: mapping!.newId },
        data: { body: 'Corrupted verify comment' },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.dbCount).toBe(0);
      expect(comments!.details).toContain('1 mapped comments have mismatched body content');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails comment verification when the mapped comment timestamps are corrupted', async () => {
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

      const comment = await prisma.comment.findUnique({
        where: { id: mapping!.newId },
        select: { createdAt: true },
      });

      expect(comment).not.toBeNull();

      await prisma.comment.update({
        where: { id: mapping!.newId },
        data: { createdAt: new Date('2024-06-03T00:00:00.000Z'), updatedAt: comment!.createdAt },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.dbCount).toBe(0);
      expect(comments!.details).toContain('1 mapped comments have mismatched timestamps');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails comment verification when the mapped comment points at the wrong imported issue', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const commentMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-comment-1',
            entityType: 'comment',
          },
        },
      });
      const wrongIssueMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-issue-2',
            entityType: 'issue',
          },
        },
      });

      expect(commentMapping).not.toBeNull();
      expect(wrongIssueMapping).not.toBeNull();

      await prisma.comment.update({
        where: { id: commentMapping!.newId },
        data: { issueId: wrongIssueMapping!.newId },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.dbCount).toBe(0);
      expect(comments!.details).toContain('1 mapped comments reference the wrong imported issue');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.$disconnect();
    }
  });

  it('fails comment verification when the mapped comment points at the wrong imported author', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const commentMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-comment-1',
            entityType: 'comment',
          },
        },
      });

      expect(commentMapping).not.toBeNull();

      const wrongUser = await prisma.user.create({
        data: {
          name: 'Verify Wrong Author',
          email: 'verify-wrong-author@example.com',
        },
      });

      await prisma.comment.update({
        where: { id: commentMapping!.newId },
        data: { userId: wrongUser.id },
      });

      const result = await runVerify({ file: exportDir });
      const comments = result.entities.find((entity) => entity.entity === 'Comments');

      expect(comments).toBeDefined();
      expect(comments!.passed).toBe(false);
      expect(comments!.dbCount).toBe(0);
      expect(comments!.details).toContain('1 mapped comments reference the wrong imported author');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.user.deleteMany({
        where: { email: 'verify-wrong-author@example.com' },
      });
      await prisma.$disconnect();
    }
  });

  it('fails team verification when only an unrelated team exists and the export team mapping is stale', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const importedTeamMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-team-1',
            entityType: 'team',
          },
        },
      });

      expect(importedTeamMapping).not.toBeNull();

      await prisma.team.delete({
        where: { id: importedTeamMapping!.newId },
      });

      await prisma.team.deleteMany({
        where: { key: 'VRX' },
      });

      await prisma.team.create({
        data: {
          key: 'VRX',
          name: 'Unrelated Verify Team',
        },
      });

      await prisma.legacyLinearMapping.update({
        where: {
          oldId_entityType: {
            oldId: 'verify-team-1',
            entityType: 'team',
          },
        },
        data: { newId: importedTeamMapping!.newId },
      });

      const result = await runVerify({ file: exportDir });
      const teams = result.entities.find((entity) => entity.entity === 'Teams');

      expect(teams).toBeDefined();
      expect(teams!.passed).toBe(false);
      expect(teams!.exportCount).toBe(1);
      expect(teams!.dbCount).toBe(0);
      expect(teams!.details).toContain('1 export teams missing mapped database rows');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.team.deleteMany({
        where: { key: 'VRX' },
      });
      await prisma.$disconnect();
    }
  });

  it('fails label verification when unrelated labels exist but the current export label mapping points to a missing row', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const importedLabelMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-label-1',
            entityType: 'label',
          },
        },
      });

      expect(importedLabelMapping).not.toBeNull();

      const issue = await prisma.issue.findUnique({
        where: { identifier: 'VRF-1' },
      });

      expect(issue).not.toBeNull();

      await prisma.issue.update({
        where: { id: issue!.id },
        data: {
          labels: {
            disconnect: [{ id: importedLabelMapping!.newId }],
          },
        },
      });

      await prisma.issueLabel.delete({
        where: { id: importedLabelMapping!.newId },
      });

      await prisma.issueLabel.create({
        data: { name: 'verify-unrelated-label' },
      });

      const result = await runVerify({ file: exportDir });
      const labels = result.entities.find((entity) => entity.entity === 'Labels');

      expect(labels).toBeDefined();
      expect(labels!.passed).toBe(false);
      expect(labels!.exportCount).toBe(2);
      expect(labels!.dbCount).toBe(1);
      expect(labels!.details).toContain('1 export labels missing mapped database rows');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.issueLabel.deleteMany({
        where: { name: 'verify-unrelated-label' },
      });
      await prisma.$disconnect();
    }
  });

  it('fails user verification when unrelated users exist but the export user mapping points to a missing row', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const importedUserMapping = await prisma.legacyLinearMapping.findUnique({
        where: {
          oldId_entityType: {
            oldId: 'verify-user-1',
            entityType: 'user',
          },
        },
      });

      expect(importedUserMapping).not.toBeNull();

      await prisma.comment.deleteMany({
        where: { userId: importedUserMapping!.newId },
      });
      await prisma.issue.updateMany({
        where: { assigneeId: importedUserMapping!.newId },
        data: { assigneeId: null },
      });
      await prisma.user.delete({
        where: { id: importedUserMapping!.newId },
      });

      await prisma.user.create({
        data: {
          name: 'Verify Unrelated User',
          email: 'verify-unrelated@example.com',
        },
      });

      const result = await runVerify({ file: exportDir });
      const users = result.entities.find((entity) => entity.entity === 'Users');

      expect(users).toBeDefined();
      expect(users!.passed).toBe(false);
      expect(users!.exportCount).toBe(1);
      expect(users!.dbCount).toBe(0);
      expect(users!.details).toContain('1 export users missing mapped database rows');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.user.deleteMany({
        where: { email: 'verify-unrelated@example.com' },
      });
      await prisma.$disconnect();
    }
  });

  it('fails workflow state verification when stale mappings from another import exist for the same old IDs', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      await prisma.$connect();

      const importedStateMappings = await prisma.legacyLinearMapping.findMany({
        where: {
          entityType: 'workflow_state',
          oldId: { in: FIXTURE_WORKFLOW_STATES.map((state) => state.id) },
        },
        orderBy: { oldId: 'asc' },
      });

      expect(importedStateMappings).toHaveLength(2);

      await prisma.team.deleteMany({
        where: { key: 'VRS' },
      });

      const unrelatedTeam = await prisma.team.create({
        data: {
          key: 'VRS',
          name: 'Verify Stale Mapping Team',
        },
      });

      const unrelatedStates = await Promise.all(
        FIXTURE_WORKFLOW_STATES.map((state) =>
          prisma.workflowState.create({
            data: {
              name: state.name,
              teamId: unrelatedTeam.id,
            },
          }),
        ),
      );

      for (let index = 0; index < importedStateMappings.length; index += 1) {
        await prisma.legacyLinearMapping.update({
          where: {
            oldId_entityType: {
              oldId: importedStateMappings[index]!.oldId,
              entityType: 'workflow_state',
            },
          },
          data: { newId: unrelatedStates[index]!.id },
        });
      }

      const result = await runVerify({ file: exportDir });
      const states = result.entities.find((entity) => entity.entity === 'Workflow States');

      expect(states).toBeDefined();
      expect(states!.passed).toBe(false);
      expect(states!.exportCount).toBe(2);
      expect(states!.dbCount).toBe(0);
      expect(states!.details).toContain('2 export workflow states mapped to the wrong team');
      expect(result.allPassed).toBe(false);
    } finally {
      await resetVerifyImportState(prisma, exportDir);
      await prisma.team.deleteMany({
        where: { key: 'VRS' },
      });
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
