import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { restoreSonValidationDataset } from './son-validation-restore.js';

loadProjectEnvironment();

const prisma = new PrismaClient();

describe('restoreSonValidationDataset', () => {
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
  });

  it('restores SON import data and preserves repeatable validation teams', async () => {
    const summary = await restoreSonValidationDataset(prisma);

    expect(summary.sonIssueCount).toBe(404);
    expect(summary.importResult.counts.issues).toBe(404);
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
    expect(teams.find((team) => team.key === 'SON')?._count.issues).toBe(404);
    expect(teams.find((team) => team.key === 'VAL')?._count.issues).toBe(0);
    expect(teams.find((team) => team.key === 'INV')?._count.issues).toBeGreaterThanOrEqual(66);
  });

  it('is idempotent across repeated restore runs', async () => {
    await restoreSonValidationDataset(prisma);
    const second = await restoreSonValidationDataset(prisma);

    expect(second.sonIssueCount).toBe(404);
    expect(second.importResult.skipped.issues).toBe(404);
    expect(second.importResult.skipped.comments).toBe(89);
    expect(second.setupSummary.sonTeamPresent).toBe(true);
  });
});
