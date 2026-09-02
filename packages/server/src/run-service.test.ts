import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { flushEventOutbox } from './event-outbox.ts';
import { attachEvidence, reportRun, reviewWork } from './run-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('run and evidence', () => {
  let team: Team;
  let human: User;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.eventOutbox.deleteMany();
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

  it('completes a run into In Review, never Done, and emits signed webhook events', async () => {
    const candidate = await proposeWork(
      prisma,
      { teamId: team.id, title: 'Ship run kernel' },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const committed = await commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'run complete is not done',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const claimed = await claimWork(
      prisma,
      committed.id,
      {},
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const started = await reportRun(
      prisma,
      { phase: 'implementing', status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(started.run.publicId).toMatch(/^RUN-/);
    expect(started.run.status).toBe('RUNNING');
    expect(started.run.claimId).toBe(claimed.claim.id);
    expect(started.run.baseRevision).toBe(committed.revision);

    const completed = await reportRun(
      prisma,
      {
        runId: started.run.publicId,
        status: 'completed',
        summary: 'parser migrated',
        workId: committed.id,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const state = await prisma.workflowState.findUniqueOrThrow({
      where: { id: completed.work.stateId },
    });
    expect(state.name).toBe('In Review');
    expect(state.name).not.toBe('Done');

    const evidence = await attachEvidence(
      prisma,
      {
        kind: 'pr',
        runId: started.run.publicId,
        url: 'https://github.com/fakechris/involute/pull/1',
        workId: committed.id,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    expect(evidence.evidence.kind).toBe('PR');

    const afterEvidence = await prisma.workflowState.findUniqueOrThrow({
      where: { id: evidence.work.stateId },
    });
    expect(afterEvidence.name).toBe('In Review');
    expect(evidence.evidence.actorId).toBe(human.id);

    await expect(reportRun(
      prisma,
      { runId: started.run.publicId, status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    )).rejects.toThrow('Completed or failed runs cannot be changed.');

    const accepted = await reviewWork(
      prisma,
      completed.work.id,
      { decision: 'ACCEPTED', expectedRevision: completed.work.revision, runId: started.run.publicId },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const acceptedState = await prisma.workflowState.findUniqueOrThrow({
      where: { id: accepted.work.stateId },
    });
    expect(acceptedState.type).toBe('COMPLETED');
    expect(accepted.decision.runId).toBe(started.run.id);

    const events = await prisma.eventOutbox.findMany({ orderBy: { createdAt: 'asc' } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['work.proposed', 'work.committed', 'run.started', 'run.completed', 'artifact.attached', 'work.review_submitted', 'work.accepted']),
    );

    const delivered: Array<{ body: string; headers: Headers; url: string }> = [];
    const secret = 'webhook-secret';
    await flushEventOutbox(
      prisma,
      [{ url: 'https://example.test/hooks', secret }],
      async (url, init) => {
        delivered.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return new Response('ok', { status: 200 });
      },
    );

    expect(delivered.length).toBeGreaterThan(0);
    const completedDelivery = delivered.find((item) => item.body.includes('run.completed'));
    expect(completedDelivery).toBeTruthy();
    const signature = completedDelivery?.headers.get('involute-signature') ?? '';
    const digest = createHmac('sha256', secret).update(completedDelivery?.body ?? '').digest('hex');
    expect(signature).toBe(`sha256=${digest}`);
    expect(completedDelivery?.headers.get('involute-delivery')).toBeTruthy();
    const committedDelivery = delivered.find((item) => item.body.includes('work.committed'));
    expect(committedDelivery?.body).toContain('updatedFrom');
  });

  it('retries only failed webhook targets', async () => {
    const event = await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    const attempts = new Map<string, number>();
    const targets = [
      { secret: 'shared-secret', url: 'https://one.example.test/hook' },
      { secret: 'shared-secret', url: 'https://two.example.test/hook' },
    ];
    const deliver = async (url: string | URL | Request): Promise<Response> => {
      const key = String(url);
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (key === targets[1]!.url && count === 1) {
        return new Response('temporary failure', { status: 503 });
      }
      return new Response('ok', { status: 200 });
    };

    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch)).toEqual({ delivered: 0, failed: 1 });
    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch)).toEqual({ delivered: 1, failed: 0 });
    expect(attempts.get(targets[0]!.url)).toBe(1);
    expect(attempts.get(targets[1]!.url)).toBe(2);
    expect((await prisma.eventOutbox.findUniqueOrThrow({ where: { id: event.id } })).deliveredAt).not.toBeNull();
  });
});
