import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { loadProjectEnvironment } from './env.ts';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_LABEL_NAMES,
  DEFAULT_TEAM_KEY,
  DEFAULT_WORKFLOW_STATE_NAMES,
  seedDatabase,
} from './seed-helpers.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

describe('seedDatabase', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany({
      where: {
        key: DEFAULT_TEAM_KEY,
      },
    });
    await prisma.issueLabel.deleteMany({
      where: {
        name: {
          in: [...DEFAULT_LABEL_NAMES],
        },
      },
    });
    await prisma.user.deleteMany({
      where: {
        email: DEFAULT_ADMIN_EMAIL,
      },
    });
    await prisma.legacyLinearMapping.deleteMany();
  });

  it('creates the default team, workflow states, labels, and admin user idempotently', async () => {
    await seedDatabase(prisma);
    await seedDatabase(prisma);

    const team = await prisma.team.findUnique({
      where: { key: DEFAULT_TEAM_KEY },
      include: {
        states: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    expect(team).not.toBeNull();
    expect(team?.name).toBe('Involute');
    expect(team?.nextIssueNumber).toBe(1);
    expect(team?.states.map((state) => state.name).sort()).toEqual(
      [...DEFAULT_WORKFLOW_STATE_NAMES].sort(),
    );

    const labels = await prisma.issueLabel.findMany({
      where: {
        name: {
          in: [...DEFAULT_LABEL_NAMES],
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    expect(labels.map((label) => label.name)).toEqual([...DEFAULT_LABEL_NAMES].sort());

    const adminUsers = await prisma.user.findMany({
      where: {
        email: DEFAULT_ADMIN_EMAIL,
      },
    });

    expect(adminUsers).toHaveLength(1);
    expect(adminUsers[0]?.name).toBe('Admin');
  });

  it('auto-generates team-scoped identifiers and advances the sequence for imported identifiers', async () => {
    await seedDatabase(prisma);

    const team = await prisma.team.findUniqueOrThrow({
      where: {
        key: DEFAULT_TEAM_KEY,
      },
    });

    const backlogState = await prisma.workflowState.findFirstOrThrow({
      where: {
        teamId: team.id,
        name: 'Backlog',
      },
    });

    const firstIssue = await prisma.issue.create({
      data: {
        teamId: team.id,
        stateId: backlogState.id,
        title: 'First generated issue',
      },
    });

    const importedIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-42',
        teamId: team.id,
        stateId: backlogState.id,
        title: 'Imported issue',
      },
    });

    const nextIssue = await prisma.issue.create({
      data: {
        teamId: team.id,
        stateId: backlogState.id,
        title: 'Second generated issue',
      },
    });

    const updatedTeam = await prisma.team.findUniqueOrThrow({
      where: {
        id: team.id,
      },
    });

    expect(firstIssue.identifier).toBe('INV-1');
    expect(importedIssue.identifier).toBe('INV-42');
    expect(nextIssue.identifier).toBe('INV-43');
    expect(updatedTeam.nextIssueNumber).toBe(44);
  });
});
