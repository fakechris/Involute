import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { updateIssue } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('issue service', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('rejects parent updates that would create a cycle across multiple issues', async () => {
    const team = await prisma.team.findUniqueOrThrow({
      where: {
        key: DEFAULT_TEAM_KEY,
      },
    });
    const states = await prisma.workflowState.findMany({
      where: {
        teamId: team.id,
      },
    });
    const backlogStateId = states.find((state) => state.name === 'Backlog')!.id;
    const readyStateId = states.find((state) => state.name === 'Ready')!.id;

    const rootIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-1',
        title: 'Root issue',
        teamId: team.id,
        stateId: backlogStateId,
      },
    });
    const middleIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-2',
        title: 'Middle issue',
        teamId: team.id,
        stateId: readyStateId,
        parentId: rootIssue.id,
      },
    });
    const leafIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-3',
        title: 'Leaf issue',
        teamId: team.id,
        stateId: readyStateId,
        parentId: middleIssue.id,
      },
    });

    let didReject = false;

    try {
      await updateIssue(prisma, rootIssue.id, {
        parentId: leafIssue.id,
      });
    } catch {
      didReject = true;
    }

    expect(didReject).toBe(true);

    const persistedRoot = await prisma.issue.findUniqueOrThrow({
      where: {
        id: rootIssue.id,
      },
      select: {
        parentId: true,
      },
    });

    expect(persistedRoot.parentId).toBeNull();
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
  await seedDatabase(prismaClient);
}
