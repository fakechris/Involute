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

async function seedCommittedClaimedWork(team: Team, human: User, executor: User = human) {
  const candidate = await proposeWork(
    prisma,
    { teamId: team.id, title: 'Auto-accept target' },
    { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
  );
  const committed = await commitWork(
    prisma,
    candidate.id,
    {
      acceptance: 'self-reported evidence requires human review',
      assigneeId: human.id,
      expectedRevision: candidate.revision,
    },
    { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
  );
  await claimWork(
    prisma,
    committed.id,
    {},
    { actorId: executor.id, actorKind: executor.actorKind, surface: 'test' },
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

  it.each([
    { kind: 'pr', summary: 'merged: true; checks: green', attachFirst: false },
    { kind: 'pr', summary: 'merged: true; checks: green', attachFirst: true },
    { kind: 'test', summary: 'exit:0; status:pass', attachFirst: false },
    { kind: 'test', summary: 'exit:0; status:pass', attachFirst: true },
  ] as const)(
    'keeps self-reported $kind in Review (attachFirst=$attachFirst)',
    async ({ kind, summary, attachFirst }) => {
      const agent = await prisma.user.create({
        data: { actorKind: 'AGENT', email: 'executor@example.test', name: 'Executor' },
      });
      const actor = { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'test' };
      const committed = await seedCommittedClaimedWork(team, human, agent);
      const started = await reportRun(
        prisma,
        { status: 'running', workId: committed.id },
        actor,
      );
      const attach = () =>
        attachEvidence(
          prisma,
          {
            kind,
            summary,
            runId: started.run.publicId,
            workId: committed.id,
            url: 'https://github.com/fakechris/Involute/pull/99',
          },
          actor,
        );
      if (attachFirst) await attach();
      await reportRun(
        prisma,
        { runId: started.run.publicId, status: 'completed', workId: committed.id },
        actor,
      );
      if (!attachFirst) await attach();

      const work = await prisma.issue.findUniqueOrThrow({
        where: { id: committed.id },
        include: { state: true },
      });
      expect(work.state.type).toBe('REVIEW');
      const evaluations = await prisma.workAutoAcceptEvaluation.findMany({
        where: { workId: work.id },
      });
      expect(evaluations.length).toBeGreaterThan(0);
      expect(evaluations.every((row) => row.outcome === 'SKIPPED')).toBe(true);
      expect(evaluations.some((row) => row.tier === 'LIKELY')).toBe(true);
      expect(await prisma.workReviewDecision.count({ where: { workId: work.id } })).toBe(0);
      const events = await prisma.eventOutbox.findMany();
      expect(events.map((event) => event.type)).toContain('work.auto_accept_evaluated');
      expect(events.map((event) => event.type)).not.toContain('work.accepted');
    },
  );

  it.each(['ACCEPTED', 'REJECTED'] as const)(
    'allows a human to submit %s after unverified evidence',
    async (decision) => {
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
      const attached = await attachEvidence(
        prisma,
        {
          kind: 'test',
          runId: started.run.publicId,
          summary: 'exit:0',
          url: 'https://example.test/test-results',
          workId: committed.id,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      );
      expect(
        (await prisma.workflowState.findUniqueOrThrow({ where: { id: attached.work.stateId } })).type,
      ).toBe('REVIEW');

      const skipped = await prisma.workAutoAcceptEvaluation.findMany({
        where: { workId: committed.id, outcome: 'SKIPPED' },
      });
      expect(skipped.length).toBeGreaterThan(0);
      expect(skipped.some((row) => row.tier === 'LIKELY' || row.tier === 'INSUFFICIENT')).toBe(
        true,
      );

      const reviewed = await reviewWork(
        prisma,
        attached.work.id,
        { decision, expectedRevision: attached.work.revision },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      );
      expect(
        (await prisma.workflowState.findUniqueOrThrow({ where: { id: reviewed.work.stateId } }))
          .type,
      ).toBe(decision === 'ACCEPTED' ? 'COMPLETED' : 'UNSTARTED');
    },
  );

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
