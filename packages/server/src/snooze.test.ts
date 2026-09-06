import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { proposeWork } from './claim-service.js';
import { SNOOZE_REQUIRES_CANDIDATE_MESSAGE } from './errors.js';
import { updateIssue } from './issue-service.js';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('candidate snooze', () => {
  let team: Team;
  let human: User;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  it('snoozes and wakes candidate work', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Snooze target' });
    const until = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const snoozed = await updateIssue(
      prisma,
      candidate.id,
      { expectedRevision: candidate.revision, snoozedUntil: until },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(snoozed.snoozedUntil?.getTime()).toBe(until.getTime());

    const woken = await updateIssue(
      prisma,
      candidate.id,
      { expectedRevision: snoozed.revision, snoozedUntil: null },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(woken.snoozedUntil).toBeNull();
  });

  it('rejects snoozing committed work', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Committed snooze' });
    const { commitWork } = await import('./claim-service.js');
    const committed = await commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'no snooze for committed work',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    await expect(
      updateIssue(
        prisma,
        committed.id,
        { expectedRevision: committed.revision, snoozedUntil: new Date() },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      ),
    ).rejects.toThrow(SNOOZE_REQUIRES_CANDIDATE_MESSAGE);
  });
});
