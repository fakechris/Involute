import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { attachEvidence, reportRun, reviewWork } from './run-service.ts';
import { WORK_ACCEPT_FORBIDDEN_MESSAGE } from './errors.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

async function seedCommittedClaimedWork(team: Team, human: User) {
  const candidate = await proposeWork(
    prisma,
    { teamId: team.id, title: 'Auto-accept target' },
    { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
  );
  const committed = await commitWork(
    prisma,
    candidate.id,
    {
      acceptance: 'objective evidence can auto-done',
      assigneeId: human.id,
      expectedRevision: candidate.revision,
    },
    { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
  );
  await claimWork(
    prisma,
    committed.id,
    {},
    { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
  );
  return committed;
}

describe('graded auto-accept gate', () => {
  let team: Team;
  let human: User;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.webhookSubscription.deleteMany();
    await prisma.workAutoAcceptEvaluation.deleteMany();
    await prisma.workReviewDecision.deleteMany();
    await prisma.workEvidence.deleteMany();
    await prisma.workRun.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  it('auto-Dones CLEAR evidence (merged PR) and writes an ACCEPTED evaluation', async () => {
    const committed = await seedCommittedClaimedWork(team, human);
    const started = await reportRun(
      prisma,
      { phase: 'implementing', status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const completed = await reportRun(
      prisma,
      {
        runId: started.run.publicId,
        status: 'completed',
        summary: 'shipped',
        workId: committed.id,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(
      (await prisma.workflowState.findUniqueOrThrow({ where: { id: completed.work.stateId } })).name,
    ).toBe('In Review');

    const accepted = await attachEvidence(
      prisma,
      {
        kind: 'pr',
        runId: started.run.publicId,
        summary: 'merged: true; checks: green',
        url: 'https://github.com/fakechris/Involute/pull/99',
        workId: committed.id,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const state = await prisma.workflowState.findUniqueOrThrow({
      where: { id: accepted.work.stateId },
    });
    expect(state.type).toBe('COMPLETED');

    const evaluations = await prisma.workAutoAcceptEvaluation.findMany({
      where: { workId: committed.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(evaluations.some((row) => row.outcome === 'ACCEPTED' && row.tier === 'CLEAR')).toBe(
      true,
    );
    expect(await prisma.workReviewDecision.count({ where: { workId: committed.id } })).toBe(1);

    const events = await prisma.eventOutbox.findMany({ orderBy: { createdAt: 'asc' } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['work.auto_accept_evaluated', 'work.accepted']),
    );
  });

  it('does not auto-Done AMBIGUOUS / LIKELY work; human review still works', async () => {
    const committed = await seedCommittedClaimedWork(team, human);
    const started = await reportRun(
      prisma,
      { status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await reportRun(
      prisma,
      { runId: started.run.publicId, status: 'completed', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const ambiguous = await attachEvidence(
      prisma,
      {
        kind: 'screenshot',
        runId: started.run.publicId,
        summary: 'looks fine',
        url: 'https://example.test/shot.png',
        workId: committed.id,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(
      (await prisma.workflowState.findUniqueOrThrow({ where: { id: ambiguous.work.stateId } })).type,
    ).toBe('REVIEW');

    const skipped = await prisma.workAutoAcceptEvaluation.findMany({
      where: { workId: committed.id, outcome: 'SKIPPED' },
    });
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((row) => row.tier === 'AMBIGUOUS' || row.tier === 'INSUFFICIENT')).toBe(
      true,
    );

    const humanAccepted = await reviewWork(
      prisma,
      ambiguous.work.id,
      { decision: 'ACCEPTED', expectedRevision: ambiguous.work.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(
      (await prisma.workflowState.findUniqueOrThrow({ where: { id: humanAccepted.work.stateId } }))
        .type,
    ).toBe('COMPLETED');
  });

  it('keeps agents forbidden from free Done via reviewWork', async () => {
    const committed = await seedCommittedClaimedWork(team, human);
    const agent = await prisma.user.create({
      data: {
        actorKind: 'AGENT',
        email: 'agent-auto-accept@example.test',
        name: 'Agent',
      },
    });
    const started = await reportRun(
      prisma,
      { status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const completed = await reportRun(
      prisma,
      { runId: started.run.publicId, status: 'completed', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    await expect(
      reviewWork(
        prisma,
        completed.work.id,
        { decision: 'ACCEPTED', expectedRevision: completed.work.revision },
        { actorId: agent.id, actorKind: 'AGENT', surface: 'test' },
      ),
    ).rejects.toThrow(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  });
});
