import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { snapshotContract } from './evidence-contract.ts';
import { createIssue, updateIssue } from './issue-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('acceptance through a state change is recorded (INV-790)', () => {
  let team: Team;
  let admin: User;
  const human = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });
  const state = (type: 'REVIEW' | 'COMPLETED' | 'UNSTARTED') =>
    prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type }, orderBy: { position: 'asc' } });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('writes an ACCEPTED decision bound to the latest completed run and emits work.accepted', async () => {
    const review = await state('REVIEW');
    const work = await createIssue(prisma, { teamId: team.id, title: 'Reviewed work', stateId: review.id });
    const run = await prisma.workRun.create({
      data: { workId: work.id, actorId: admin.id, status: 'COMPLETED', endedAt: new Date(), publicId: 'RUN-9001' },
    });
    const done = await state('COMPLETED');

    const updated = await updateIssue(prisma, work.id, { stateId: done.id }, human());

    const decisions = await prisma.workReviewDecision.findMany({ where: { workId: work.id } });
    expect(decisions).toEqual([
      expect.objectContaining({ decision: 'ACCEPTED', reviewerId: admin.id, runId: run.id, fromRevision: work.revision, toRevision: updated.revision }),
    ]);
    const event = await prisma.eventOutbox.findFirstOrThrow({ where: { type: 'work.accepted' } });
    expect((event.payload as { data: { viaStateChange: boolean; decisionId: string } }).data).toMatchObject({
      viaStateChange: true,
      decisionId: decisions[0]!.id,
    });
  });

  it('records nothing for moves that are not into Done', async () => {
    const work = await createIssue(prisma, { teamId: team.id, title: 'Moving around', stateId: (await state('UNSTARTED')).id });
    await updateIssue(prisma, work.id, { stateId: (await state('REVIEW')).id }, human());
    const done = await state('COMPLETED');
    await updateIssue(prisma, work.id, { stateId: done.id }, human());
    await updateIssue(prisma, work.id, { title: 'Renamed while done' }, human());
    expect(await prisma.workReviewDecision.count({ where: { workId: work.id } })).toBe(1);
  });

  it('exposes the current contract digest so a run on an older contract can be flagged', async () => {
    const work = await createIssue(prisma, { teamId: team.id, title: 'Contract', acceptance: 'A', repository: 'acme/app' });
    const before = snapshotContract(work).contractRevision;
    const changed = await updateIssue(prisma, work.id, { acceptance: 'B' }, human());
    expect(snapshotContract(changed).contractRevision).not.toBe(before);
  });
});
