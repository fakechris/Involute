import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, WorkflowState } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { getWorkContext, listReadyWork } from './context-service.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { createWorkLink } from './link-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('context service', () => {
  let team: Team;
  let backlog: WorkflowState;
  let ready: WorkflowState;
  let inProgress: WorkflowState;
  let done: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const states = await prisma.workflowState.findMany({ where: { teamId: team.id } });
    backlog = findState(states, 'Backlog');
    ready = findState(states, 'Ready');
    inProgress = findState(states, 'In Progress');
    done = findState(states, 'Done');
  });

  it('assembles ancestors, blockers, and audits for a work node', async () => {
    const root = await createIssue(prisma, { teamId: team.id, title: 'Epic', stateId: backlog.id });
    const parent = await createIssue(prisma, { teamId: team.id, title: 'Parent', stateId: ready.id });
    const child = await createIssue(prisma, { teamId: team.id, title: 'Child', stateId: ready.id });
    const blocker = await createIssue(prisma, { teamId: team.id, title: 'Blocker', stateId: ready.id });

    await updateIssue(prisma, parent.id, { parentId: root.id });
    await updateIssue(prisma, child.id, { parentId: parent.id });
    await createWorkLink(prisma, { fromId: blocker.id, toId: child.id, type: 'BLOCKS' });

    const context = await getWorkContext(prisma, child.identifier);

    expect(context.work.id).toBe(child.id);
    expect(context.ancestors.map((issue) => issue.id)).toEqual([root.id, parent.id]);
    expect(context.blockedBy.map((issue) => issue.id)).toEqual([blocker.id]);
    expect(context.blocks).toEqual([]);
    expect(context.audits.length).toBeGreaterThan(0);
    expect(context.audits[0]?.workId).toBe(child.id);
  });

  it('lists only committed, unblocked, unfinished work in urgency order', async () => {
    const urgent = await createIssue(prisma, {
      teamId: team.id,
      title: 'Urgent ready',
      stateId: ready.id,
      priority: 1,
    });
    const high = await createIssue(prisma, {
      teamId: team.id,
      title: 'High ready',
      stateId: ready.id,
      priority: 2,
    });
    const none = await createIssue(prisma, {
      teamId: team.id,
      title: 'No priority ready',
      stateId: ready.id,
      priority: 0,
    });
    const backlogItem = await createIssue(prisma, {
      teamId: team.id,
      title: 'Backlog item',
      stateId: backlog.id,
      priority: 1,
    });
    const started = await createIssue(prisma, {
      teamId: team.id,
      title: 'Already started',
      stateId: inProgress.id,
      priority: 1,
    });
    const finished = await createIssue(prisma, {
      teamId: team.id,
      title: 'Already done',
      stateId: done.id,
      priority: 1,
    });
    const candidate = await createIssue(prisma, {
      teamId: team.id,
      title: 'Candidate only',
      stateId: ready.id,
      priority: 1,
    });
    await prisma.issue.update({
      where: { id: candidate.id },
      data: { commitmentStatus: 'CANDIDATE' },
    });
    const blocked = await createIssue(prisma, {
      teamId: team.id,
      title: 'Blocked by link',
      stateId: ready.id,
      priority: 1,
    });
    await createWorkLink(prisma, { fromId: urgent.id, toId: blocked.id, type: 'BLOCKS' });
    const labeled = await createIssue(prisma, {
      teamId: team.id,
      title: 'Needs clarification',
      stateId: ready.id,
      priority: 1,
    });
    const needsClarification = await prisma.issueLabel.findUniqueOrThrow({
      where: { name: 'needs-clarification' },
    });
    await prisma.issue.update({
      where: { id: labeled.id },
      data: { labels: { set: [{ id: needsClarification.id }] } },
    });
    const otherRepo = await createIssue(prisma, {
      teamId: team.id,
      title: 'Other repo',
      stateId: ready.id,
      priority: 1,
    });
    await prisma.issue.update({
      where: { id: otherRepo.id },
      data: { repository: 'other/repo' },
    });

    await prisma.issue.update({
      where: { id: urgent.id },
      data: { updatedAt: new Date('2026-08-31T10:00:00.000Z') },
    });
    await prisma.issue.update({
      where: { id: backlogItem.id },
      data: { updatedAt: new Date('2026-08-31T09:00:00.000Z') },
    });
    await prisma.issue.update({
      where: { id: otherRepo.id },
      data: { repository: 'other/repo', updatedAt: new Date('2026-08-31T08:00:00.000Z') },
    });
    await prisma.issue.update({
      where: { id: high.id },
      data: { updatedAt: new Date('2026-08-31T12:00:00.000Z') },
    });
    await prisma.issue.update({
      where: { id: none.id },
      data: { updatedAt: new Date('2026-08-31T12:00:00.000Z') },
    });

    const readyQueue = await listReadyWork(prisma, { first: 20 });
    const identifiers = readyQueue.nodes.map((issue) => issue.identifier);

    expect(identifiers).toEqual([
      urgent.identifier,
      backlogItem.identifier,
      otherRepo.identifier,
      high.identifier,
      none.identifier,
    ]);
    expect(identifiers).not.toContain(started.identifier);
    expect(identifiers).not.toContain(finished.identifier);
    expect(identifiers).not.toContain(candidate.identifier);
    expect(identifiers).not.toContain(blocked.identifier);
    expect(identifiers).not.toContain(labeled.identifier);

    const filtered = await listReadyWork(prisma, { repository: 'other/repo' });
    expect(filtered.nodes.map((issue) => issue.identifier)).toEqual([otherRepo.identifier]);
  });
});

function findState(states: WorkflowState[], name: string): WorkflowState {
  const state = states.find((candidate) => candidate.name === name);

  if (!state) {
    throw new Error(`Missing state ${name}`);
  }

  return state;
}

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
