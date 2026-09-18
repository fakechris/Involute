import { PrismaClient, type WorkKind } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.js';
import { createIssue } from './issue-service.js';
import { createWorkLink } from './link-service.js';
import { migrateRepository } from './repo-migration-service.js';

describe('repo-migration-service', () => {
  const prisma = new PrismaClient();
  const fromRepo = 'test-owner/old-project';
  const toRepo = 'test-owner/new-project';
  let teamId: string;

  beforeEach(async () => {
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    // ActorAudit references users with Restrict (INV-586/604): it goes first.
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);
    teamId = (await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createNode(kind: WorkKind, repo = fromRepo, parentId?: string) {
    return createIssue(prisma, {
      kind,
      repository: repo,
      teamId,
      title: `${kind} node`,
      ...(parentId ? { parentId } : {}),
    });
  }

  it('validates fromRepo and toRepo arguments', async () => {
    await expect(migrateRepository(prisma, { fromRepo: '', toRepo: 'a/b' })).rejects.toThrow(
      'Both fromRepo and toRepo must be provided.',
    );
    await expect(migrateRepository(prisma, { fromRepo: 'a/b', toRepo: 'a/b' })).rejects.toThrow(
      'fromRepo and toRepo must be different.',
    );
    await expect(migrateRepository(prisma, { fromRepo: ' a/b ', toRepo: 'c/d' })).rejects.toThrow(
      'Repository values must not have surrounding whitespace.',
    );
  });

  it('supports dry-run without modifying database', async () => {
    const project = await createNode('PROJECT');
    const milestone = await createNode('MILESTONE', fromRepo, project.id);
    await createWorkLink(prisma, { fromId: project.id, toId: milestone.id, type: 'CONTAINS' });

    const result = await migrateRepository(prisma, {
      dryRun: true,
      fromRepo,
      toRepo,
    });

    expect(result.dryRun).toBe(true);
    expect(result.migratedIssuesCount).toBe(2);
    expect(result.affectedIssueIdentifiers).toContain(project.identifier);
    expect(result.affectedIssueIdentifiers).toContain(milestone.identifier);

    // Database should be unchanged
    const unchangedProject = await prisma.issue.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchangedProject.repository).toBe(fromRepo);
  });

  it('atomically migrates issues and associated work runs, and verifies hierarchy', async () => {
    const project = await createNode('PROJECT');
    const milestone = await createNode('MILESTONE', fromRepo, project.id);
    await createWorkLink(prisma, { fromId: project.id, toId: milestone.id, type: 'CONTAINS' });
    const issue = await createNode('ISSUE', fromRepo, milestone.id);
    await createWorkLink(prisma, { fromId: milestone.id, toId: issue.id, type: 'CONTAINS' });

    const run = await prisma.workRun.create({
      data: {
        publicId: 'RUN-TEST-MIGRATE',
        repository: fromRepo,
        status: 'COMPLETED',
        workId: issue.id,
      },
    });

    const result = await migrateRepository(prisma, {
      fromRepo,
      toRepo,
    });

    expect(result.dryRun).toBe(false);
    expect(result.migratedIssuesCount).toBe(3);
    expect(result.migratedRunsCount).toBe(1);

    const updatedProject = await prisma.issue.findUniqueOrThrow({ where: { id: project.id } });
    const updatedMilestone = await prisma.issue.findUniqueOrThrow({ where: { id: milestone.id } });
    const updatedIssue = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    const updatedRun = await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } });

    expect(updatedProject.repository).toBe(toRepo);
    expect(updatedMilestone.repository).toBe(toRepo);
    expect(updatedIssue.repository).toBe(toRepo);
    expect(updatedRun.repository).toBe(toRepo);

    // Audits recorded
    const audits = await prisma.workAudit.findMany({ where: { workId: issue.id } });
    expect(audits.some((a) => (a.after as { repository?: string })?.repository === toRepo)).toBe(true);
  });
});
