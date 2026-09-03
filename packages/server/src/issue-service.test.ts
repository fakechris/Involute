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
    const backlogState = states.find((state) => state.name === 'Backlog');
    const readyState = states.find((state) => state.name === 'Ready');

    if (!backlogState) {
      throw new Error("Missing seeded workflow state 'Backlog'");
    }

    if (!readyState) {
      throw new Error("Missing seeded workflow state 'Ready'");
    }

    const rootIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-1',
        title: 'Root issue',
        teamId: team.id,
        stateId: backlogState.id,
      },
    });
    const middleIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-2',
        title: 'Middle issue',
        teamId: team.id,
        stateId: readyState.id,
        parentId: rootIssue.id,
      },
    });
    const leafIssue = await prisma.issue.create({
      data: {
        identifier: 'INV-3',
        title: 'Leaf issue',
        teamId: team.id,
        stateId: readyState.id,
        parentId: middleIssue.id,
      },
    });
    await expect(
      updateIssue(prisma, rootIssue.id, {
        parentId: leafIssue.id,
      }),
    ).rejects.toThrow();

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

  it('projects parent updates onto contains links, bumps revision, and writes audit', async () => {
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
    const parent = await prisma.issue.create({
      data: {
        identifier: 'INV-10',
        title: 'Parent',
        teamId: team.id,
        stateId: backlogState.id,
      },
    });
    const child = await prisma.issue.create({
      data: {
        identifier: 'INV-11',
        title: 'Child',
        teamId: team.id,
        stateId: backlogState.id,
      },
    });

    const updated = await updateIssue(prisma, child.id, {
      parentId: parent.id,
      title: 'Child with parent',
    });

    expect(updated.revision).toBe(2);
    expect(updated.parentId).toBe(parent.id);

    const links = await prisma.workLink.findMany({
      where: {
        type: 'CONTAINS',
        toId: child.id,
      },
    });
    expect(links).toEqual([
      expect.objectContaining({
        fromId: parent.id,
        toId: child.id,
        type: 'CONTAINS',
      }),
    ]);

    const audits = await prisma.workAudit.findMany({
      where: {
        workId: child.id,
      },
      orderBy: {
        revision: 'asc',
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.revision).toBe(2);
    expect(audits[0]?.actorKind).toBe('SERVICE');
    expect(audits[0]?.surface).toBe('internal');
  });

  it('blocks agents from rewriting committed contract fields but allows notes', async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const backlogState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Backlog' },
    });
    const agent = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'agent.contract@test.local', name: 'Agent' },
    });
    const committed = await prisma.issue.create({
      data: {
        acceptance: 'human approved',
        commitmentStatus: 'COMMITTED',
        identifier: 'INV-20',
        stateId: backlogState.id,
        teamId: team.id,
        title: 'Committed contract',
      },
    });

    await expect(updateIssue(
      prisma,
      committed.id,
      { acceptance: 'agent rewrote it' },
      { actorId: agent.id, actorKind: 'AGENT', surface: 'test' },
    )).rejects.toThrow('Agents cannot rewrite committed contract fields');

    const updated = await updateIssue(
      prisma,
      committed.id,
      { description: 'agent progress note' },
      { actorId: agent.id, actorKind: 'AGENT', surface: 'test' },
    );
    expect(updated.description).toBe('agent progress note');
    expect(updated.acceptance).toBe('human approved');
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
