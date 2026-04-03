import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { runImportPipeline } from './import-pipeline.js';
import { CANONICAL_WORKFLOW_STATE_NAMES } from './validation-data-constants.js';
import { runValidationDataSetup } from './validation-data-setup.js';

loadProjectEnvironment();

const prisma = new PrismaClient();

describe('runValidationDataSetup', () => {
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

  it('creates INV, APP, and VAL teams with canonical states, seeded labels, and repeatable board issues', async () => {
    const summary = await runValidationDataSetup(prisma);

    expect(summary.labelsCount).toBeGreaterThanOrEqual(10);
    expect(summary.manyIssueCount).toBeGreaterThanOrEqual(60);

    const invTeam = await prisma.team.findUnique({
      where: { key: 'INV' },
      include: {
        states: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });
    const appTeam = await prisma.team.findUnique({
      where: { key: 'APP' },
      include: { states: true },
    });
    const valTeam = await prisma.team.findUnique({
      where: { key: 'VAL' },
      include: { states: true },
    });

    expect(invTeam).not.toBeNull();
    expect(appTeam).not.toBeNull();
    expect(valTeam).not.toBeNull();
    expect(invTeam!.states.map((state) => state.name).sort()).toEqual(
      [...CANONICAL_WORKFLOW_STATE_NAMES].sort(),
    );
    expect(appTeam!.states).toHaveLength(6);
    expect(valTeam!.states).toHaveLength(6);

    const invValidationIssues = await prisma.issue.findMany({
      where: {
        teamId: invTeam!.id,
        title: {
          startsWith: 'web-ui-validation: ',
        },
      },
      include: { state: true },
      orderBy: {
        title: 'asc',
      },
    });

    expect(invValidationIssues.length).toBeGreaterThanOrEqual(66);
    expect(
      invValidationIssues.filter((issue) =>
        issue.title.startsWith('web-ui-validation: Many issues '),
      ),
    ).toHaveLength(60);

    const uniqueStateIssues = invValidationIssues.filter((issue) =>
      issue.title.includes('validation card'),
    );
    expect(uniqueStateIssues.map((issue) => issue.state.name).sort()).toEqual(
      [...CANONICAL_WORKFLOW_STATE_NAMES].sort(),
    );
  });

  it('is idempotent and backfills canonical states onto imported team data', async () => {
    const exportDir = fileURLToPath(
      new URL('../../../.factory/validation/import/user-testing/tmp/val-imp-fixture', import.meta.url),
    );

    await runImportPipeline(prisma, exportDir);

    const first = await runValidationDataSetup(prisma);
    const second = await runValidationDataSetup(prisma);

    expect(second.invIssueIdentifiers).toEqual(first.invIssueIdentifiers);
    expect(second.manyIssueCount).toBe(first.manyIssueCount);
    expect(second.sonTeamPresent).toBe(false);

    const importedTeam = await prisma.team.findUnique({
      where: { key: 'TST' },
      include: { states: true },
    });

    expect(importedTeam).not.toBeNull();
    expect(importedTeam!.states.map((state) => state.name).sort()).toEqual(
      [...CANONICAL_WORKFLOW_STATE_NAMES].sort(),
    );
  });
});
