import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, WorkflowState } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  WORK_LINK_CYCLE_MESSAGE,
  WORK_LINK_SELF_REFERENCE_MESSAGE,
  WORK_LINK_TEAM_MISMATCH_MESSAGE,
} from './errors.ts';
import { createWorkLink, deleteWorkLink, listIncidentLinks } from './link-service.ts';
import { createIssue } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('link service', () => {
  let team: Team;
  let otherTeam: Team;
  let backlog: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({
      where: { key: DEFAULT_TEAM_KEY },
    });
    backlog = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Backlog' },
    });
    otherTeam = await prisma.team.create({
      data: {
        key: 'OPS',
        name: 'Operations',
        states: {
          create: { name: 'Backlog' },
        },
      },
    });
  });

  it('creates a contains link, projects it onto parentId, and is idempotent', async () => {
    const parent = await createIssue(prisma, { teamId: team.id, title: 'Parent', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const child = await createIssue(prisma, { teamId: team.id, title: 'Child', stateId: backlog.id, repository: "fakechris/Involute" });

    const first = await createWorkLink(prisma, {
      fromId: parent.id,
      toId: child.id,
      type: 'CONTAINS',
    });
    const second = await createWorkLink(prisma, {
      fromId: parent.id,
      toId: child.id,
      type: 'CONTAINS',
    });

    expect(second.id).toBe(first.id);
    await expect(
      prisma.issue.findUniqueOrThrow({ where: { id: child.id }, select: { parentId: true } }),
    ).resolves.toEqual({ parentId: parent.id });
  });

  it('rejects a second contains parent without changing the first', async () => {
    const firstParent = await createIssue(prisma, { teamId: team.id, title: 'A', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const secondParent = await createIssue(prisma, { teamId: team.id, title: 'B', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const child = await createIssue(prisma, { teamId: team.id, title: 'C', stateId: backlog.id, repository: "fakechris/Involute" });

    await createWorkLink(prisma, { fromId: firstParent.id, toId: child.id, type: 'CONTAINS' });
    await expect(createWorkLink(prisma, { fromId: secondParent.id, toId: child.id, type: 'CONTAINS' })).rejects.toThrow('existing parent');

    const links = await prisma.workLink.findMany({
      where: { toId: child.id, type: 'CONTAINS' },
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.fromId).toBe(firstParent.id);
    await expect(
      prisma.issue.findUniqueOrThrow({ where: { id: child.id }, select: { parentId: true } }),
    ).resolves.toEqual({ parentId: firstParent.id });
  });

  it('rejects self links, cross-team links, and multi-hop contains cycles', async () => {
    const root = await createIssue(prisma, { teamId: team.id, title: 'Root', kind: 'PROJECT', stateId: backlog.id, repository: "fakechris/Involute" });
    const middle = await createIssue(prisma, { teamId: team.id, title: 'Middle', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const leaf = await createIssue(prisma, { teamId: team.id, title: 'Leaf', stateId: backlog.id, repository: "fakechris/Involute" });
    const foreignState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: otherTeam.id },
    });
    const foreign = await createIssue(prisma, {
      teamId: otherTeam.id,
      title: 'Foreign',
      stateId: foreignState.id,
    });

    await expect(
      createWorkLink(prisma, { fromId: root.id, toId: root.id, type: 'RELATED_TO' }),
    ).rejects.toThrow(WORK_LINK_SELF_REFERENCE_MESSAGE);

    await expect(
      createWorkLink(prisma, { fromId: root.id, toId: foreign.id, type: 'RELATED_TO' }),
    ).rejects.toThrow(WORK_LINK_TEAM_MISMATCH_MESSAGE);

    await createWorkLink(prisma, { fromId: root.id, toId: middle.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: middle.id, toId: leaf.id, type: 'CONTAINS' });

    await expect(
      createWorkLink(prisma, { fromId: leaf.id, toId: root.id, type: 'CONTAINS' }),
    ).rejects.toThrow(WORK_LINK_CYCLE_MESSAGE);
  });

  it('rejects multi-hop blocks cycles while allowing related_to cycles', async () => {
    const a = await createIssue(prisma, { teamId: team.id, title: 'A', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const b = await createIssue(prisma, { teamId: team.id, title: 'B', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const c = await createIssue(prisma, { teamId: team.id, title: 'C', stateId: backlog.id, repository: "fakechris/Involute" });

    await createWorkLink(prisma, { fromId: a.id, toId: b.id, type: 'BLOCKS' });
    await createWorkLink(prisma, { fromId: b.id, toId: c.id, type: 'BLOCKS' });

    await expect(
      createWorkLink(prisma, { fromId: c.id, toId: a.id, type: 'BLOCKS' }),
    ).rejects.toThrow(WORK_LINK_CYCLE_MESSAGE);

    await createWorkLink(prisma, { fromId: a.id, toId: b.id, type: 'RELATED_TO' });
    await createWorkLink(prisma, { fromId: b.id, toId: a.id, type: 'RELATED_TO' });

    const related = await listIncidentLinks(prisma, a.id, 'RELATED_TO');
    expect(related).toHaveLength(2);
  });

  it('serializes concurrent opposite blocking edges so a cycle cannot commit', async () => {
    const a = await createIssue(prisma, { teamId: team.id, title: 'Concurrent A', stateId: backlog.id, repository: "fakechris/Involute" });
    const b = await createIssue(prisma, { teamId: team.id, title: 'Concurrent B', stateId: backlog.id, repository: "fakechris/Involute" });
    const results = await Promise.allSettled([
      createWorkLink(prisma, { fromId: a.id, toId: b.id, type: 'BLOCKS' }),
      createWorkLink(prisma, { fromId: b.id, toId: a.id, type: 'BLOCKS' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.workLink.count({
      where: { type: 'BLOCKS', OR: [{ fromId: a.id, toId: b.id }, { fromId: b.id, toId: a.id }] },
    })).toBe(1);
  });

  it('clears parentId when a contains link is deleted', async () => {
    const parent = await createIssue(prisma, { teamId: team.id, title: 'Parent', kind: 'MILESTONE', stateId: backlog.id, repository: "fakechris/Involute" });
    const child = await createIssue(prisma, { teamId: team.id, title: 'Child', stateId: backlog.id, repository: "fakechris/Involute" });
    const link = await createWorkLink(prisma, {
      fromId: parent.id,
      toId: child.id,
      type: 'CONTAINS',
    });

    await deleteWorkLink(prisma, link.id);

    await expect(
      prisma.issue.findUniqueOrThrow({ where: { id: child.id }, select: { parentId: true } }),
    ).resolves.toEqual({ parentId: null });
    await expect(prisma.workLink.findMany({ where: { toId: child.id } })).resolves.toEqual([]);
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  // ActorAudit references users with Restrict (INV-586/604): it goes first.
  await prismaClient.actorAudit.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
  await seedDatabase(prismaClient);
}
