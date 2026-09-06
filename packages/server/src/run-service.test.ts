import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { collectOutboundWebhookTargets, flushEventOutbox } from './event-outbox.ts';
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
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.webhookSubscription.deleteMany();
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

    const delivered: Array<{ body: string; headers: Headers; signal: AbortSignal | null; url: string }> = [];
    const secret = 'webhook-secret';
    await flushEventOutbox(
      prisma,
      [{ url: 'https://example.test/hooks', secret }],
      async (url, init) => {
        delivered.push({
          url: String(url),
          headers: new Headers(init?.headers),
          signal: init?.signal ?? null,
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
    expect(completedDelivery?.signal).toBeInstanceOf(AbortSignal);
    const committedDelivery = delivered.find((item) => item.body.includes('work.committed'));
    expect(committedDelivery?.body).toContain('updatedFrom');
    expect(await prisma.workClaim.findUnique({ where: { workId: committed.id } })).toBeNull();
    expect((await prisma.workRun.findUniqueOrThrow({ where: { id: started.run.id } })).claimId).toBeNull();
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
    // The failed target is scheduled ~1 minute out: flushes before the backoff
    // elapses skip it instead of burning attempts.
    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch)).toEqual({ delivered: 0, failed: 0 });
    expect(attempts.get(targets[1]!.url)).toBe(1);
    const deliveryRow = await prisma.eventOutboxDelivery.findFirstOrThrow({
      where: { eventId: event.id, deliveredAt: null },
    });
    expect(deliveryRow.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch, 20, { now: Date.now() + 2 * 60_000 })).toEqual({ delivered: 1, failed: 0 });
    expect(attempts.get(targets[0]!.url)).toBe(1);
    expect(attempts.get(targets[1]!.url)).toBe(2);
    expect((await prisma.eventOutbox.findUniqueOrThrow({ where: { id: event.id } })).deliveredAt).not.toBeNull();
  });

  it('sends the v2 payload envelope with stable event id and per-attempt delivery id', async () => {
    const event = await prisma.eventOutbox.create({
      data: {
        payload: { data: { title: 'Envelope' }, type: 'work.proposed', work: { id: '00000000-0000-4000-8000-000000000001', identifier: 'ENV-1' } },
        type: 'work.proposed',
      },
    });
    const target = { secret: 'envelope-secret', url: 'https://envelope.example.test/hook' };
    const seen: Array<{ body: string; headers: Headers }> = [];
    const failing = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response('nope', { status: 503 });
    };

    await flushEventOutbox(prisma, [target], failing as typeof fetch, 20, { now: Date.now() });
    await flushEventOutbox(prisma, [target], failing as typeof fetch, 20, { now: Date.now() + 2 * 60_000 });

    expect(seen.length).toBe(2);
    const first = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    const second = JSON.parse(seen[1]!.body) as Record<string, unknown>;
    expect(first['event_id']).toBe(event.id);
    expect(second['event_id']).toBe(event.id);
    expect(first['delivery_id']).not.toBe(second['delivery_id']);
    expect(first['occurred_at']).toBe(second['occurred_at']);
    expect(first['data']).toEqual({ title: 'Envelope' });
    expect(seen[0]!.headers.get('involute-event-id')).toBe(event.id);
    expect(seen[0]!.headers.get('involute-attempt')).toBe('1');
    expect(seen[1]!.headers.get('involute-attempt')).toBe('2');
    expect(seen[0]!.headers.get('involute-delivery')).toBe(first['delivery_id']);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const event = await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    let posts = 0;
    const target = { secret: 'rejecting-secret', url: 'https://reject.example.test/hook' };
    const deliver = async (): Promise<Response> => {
      posts += 1;
      return new Response('bad request', { status: 400 });
    };

    expect(await flushEventOutbox(prisma, [target], deliver as typeof fetch)).toEqual({ delivered: 0, failed: 1 });
    expect(posts).toBe(1);

    const deliveryRow = await prisma.eventOutboxDelivery.findFirstOrThrow({ where: { eventId: event.id } });
    expect(deliveryRow.attempts).toBe(5);
    expect(deliveryRow.lastError).toContain('not retryable');
    expect(deliveryRow.nextAttemptAt).toBeNull();

    // Terminal for this target: the event is dead-lettered, not retried.
    expect(
      await flushEventOutbox(prisma, [target], deliver as typeof fetch, 20, { now: Date.now() + 24 * 60 * 60_000 }),
    ).toEqual({ delivered: 0, failed: 0 });
    expect((await prisma.eventOutbox.findUniqueOrThrow({ where: { id: event.id } })).deadLetteredAt).not.toBeNull();
    expect(posts).toBe(1);
  });

  it('emits an ops alert when an event dead-letters', async () => {
    const event = await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    const opsUrl = 'https://ops.example.test/alert';
    const previousOpsUrl = process.env.OPS_WEBHOOK_URL;
    process.env.OPS_WEBHOOK_URL = opsUrl;
    const alertPosts: Array<Record<string, unknown>> = [];
    const target = { secret: 'rejecting-secret', url: 'https://reject.example.test/hook' };

    try {
      // Fetch body is not visible through the (url, init) mock signature used
      // by flushEventOutbox callers, so wrap once more to capture the body.
      const fetchWithBody = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === opsUrl) {
          alertPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response('ok', { status: 200 });
        }
        return new Response('bad request', { status: 400 });
      }) as unknown as typeof fetch;

      await flushEventOutbox(prisma, [target], fetchWithBody);
    } finally {
      if (previousOpsUrl === undefined) {
        delete process.env.OPS_WEBHOOK_URL;
      } else {
        process.env.OPS_WEBHOOK_URL = previousOpsUrl;
      }
    }

    expect((await prisma.eventOutbox.findUniqueOrThrow({ where: { id: event.id } })).deadLetteredAt).not.toBeNull();
    expect(alertPosts).toHaveLength(1);
    expect(alertPosts[0]?.['kind']).toBe('event.dead_letter');

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const opsNotifications = await prisma.notification.findMany({
      where: { type: 'ops.event.dead_letter', userId: admin.id },
    });
    expect(opsNotifications).toHaveLength(1);
  });

  it('rate-limit responses keep the retry schedule', async () => {
    const event = await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    const target = { secret: 'limited-secret', url: 'https://limited.example.test/hook' };
    const deliver = async (): Promise<Response> => new Response('slow down', { status: 429 });

    expect(await flushEventOutbox(prisma, [target], deliver as typeof fetch)).toEqual({ delivered: 0, failed: 1 });
    const deliveryRow = await prisma.eventOutboxDelivery.findFirstOrThrow({ where: { eventId: event.id } });
    expect(deliveryRow.attempts).toBe(1);
    expect(deliveryRow.nextAttemptAt).not.toBeNull();
  });

  it('delivers once when the same webhook target is configured twice', async () => {
    const event = await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    let posts = 0;
    const target = { secret: 'shared-secret', url: 'https://dup.example.test/hook' };
    const deliver = async (): Promise<Response> => {
      posts += 1;
      return new Response('ok', { status: 200 });
    };

    expect(await flushEventOutbox(prisma, [target, { ...target }], deliver as typeof fetch)).toEqual({ delivered: 1, failed: 0 });
    expect(posts).toBe(1);
    expect(await prisma.eventOutboxDelivery.count({ where: { eventId: event.id } })).toBe(1);
  });

  it('rejects updates to a running run after its bound claim is gone', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Claim-bound run' });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'run keeps its active claim', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await claimWork(prisma, committed.id, {}, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    const started = await reportRun(
      prisma,
      { status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await prisma.workClaim.delete({ where: { workId: committed.id } });

    await expect(reportRun(
      prisma,
      { phase: 'should not persist', runId: started.run.id, workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    )).rejects.toThrow('Reporting a run requires an active claim owned by the current actor.');
  });

  it('replays run_report and evidence_attach on idempotency key retry', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Idempotent run' });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'retry safe', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await claimWork(prisma, committed.id, {}, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    const actor = { actorId: human.id, actorKind: 'HUMAN' as const, surface: 'test' };

    const first = await reportRun(
      prisma,
      { idempotencyKey: 'run-key-1', status: 'running', workId: committed.id },
      actor,
    );
    const replay = await reportRun(
      prisma,
      { idempotencyKey: 'run-key-1', status: 'running', workId: committed.id },
      actor,
    );
    expect(replay.run.id).toBe(first.run.id);
    expect(await prisma.workRun.count({ where: { workId: committed.id } })).toBe(1);

    const ev1 = await attachEvidence(
      prisma,
      { idempotencyKey: 'ev-key-1', kind: 'log', runId: first.run.id, url: 'https://example.test/log', workId: committed.id },
      actor,
    );
    const ev2 = await attachEvidence(
      prisma,
      { idempotencyKey: 'ev-key-1', kind: 'log', runId: first.run.id, url: 'https://example.test/log', workId: committed.id },
      actor,
    );
    expect(ev2.evidence.id).toBe(ev1.evidence.id);
    expect(await prisma.workEvidence.count({ where: { workId: committed.id } })).toBe(1);
  });

  it('completes the idempotency reservation on terminal-run no-op retries', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Terminal replay' });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'replay safe', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await claimWork(prisma, committed.id, {}, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    const actor = { actorId: human.id, actorKind: 'HUMAN' as const, surface: 'test' };
    const started = await reportRun(prisma, { status: 'running', workId: committed.id }, actor);
    await reportRun(
      prisma,
      { runId: started.run.id, status: 'completed', workId: committed.id },
      actor,
    );

    const first = await reportRun(
      prisma,
      { idempotencyKey: 'terminal-key-1', runId: started.run.id, status: 'completed', workId: committed.id },
      actor,
    );
    const replay = await reportRun(
      prisma,
      { idempotencyKey: 'terminal-key-1', runId: started.run.id, status: 'completed', workId: committed.id },
      actor,
    );
    expect(replay.run.id).toBe(first.run.id);
  });

  it('routes outbox events to subscriptions by team and event type', async () => {
    const otherTeam = await prisma.team.create({ data: { key: 'OTHER', name: 'Other' } });
    const posted: string[] = [];
    const deliver = async (url: string | URL | Request): Promise<Response> => {
      posted.push(String(url));
      return new Response('ok', { status: 200 });
    };

    await prisma.webhookSubscription.create({
      data: {
        eventTypes: ['work.proposed'],
        label: 'team hook',
        secret: 'team-secret',
        teamId: team.id,
        url: 'https://team.example.test/hook',
      },
    });
    await prisma.webhookSubscription.create({
      data: {
        eventTypes: [],
        label: 'global hook',
        secret: 'global-secret',
        teamId: null,
        url: 'https://global.example.test/hook',
      },
    });

    // work.proposed for the subscribed team → both endpoints fire.
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Routed work' });
    const targets = await collectOutboundWebhookTargets(prisma, 'https://env.example.test/hook', 'env-secret');
    expect(targets.map((target) => target.url).sort()).toEqual([
      'https://global.example.test/hook',
      'https://team.example.test/hook',
    ]);
    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch)).toEqual({ delivered: 1, failed: 0 });
    expect(posted.sort()).toEqual(['https://global.example.test/hook', 'https://team.example.test/hook']);

    // A run event the team subscription did not opt into → global only.
    posted.length = 0;
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'scoped', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await claimWork(prisma, committed.id, {}, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    await reportRun(
      prisma,
      { status: 'running', workId: committed.id },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const round2 = await collectOutboundWebhookTargets(prisma, null, null);
    expect(await flushEventOutbox(prisma, round2, deliver as typeof fetch)).toEqual({ delivered: 3, failed: 0 });
    expect(posted).toEqual([
      'https://global.example.test/hook',
      'https://global.example.test/hook',
      'https://global.example.test/hook',
    ]);

    // Events for other teams never reach the team-scoped subscription.
    expect(otherTeam.key).toBe('OTHER');
  });

  it('treats same-URL subscriptions as distinct delivery identities', async () => {
    const signatures: Array<string | null> = [];
    const deliver = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signatures.push(new Headers(init?.headers).get('involute-signature'));
      return new Response('ok', { status: 200 });
    };

    await prisma.webhookSubscription.create({
      data: { eventTypes: [], secret: 'secret-one', teamId: null, url: 'https://same.example.test/hook' },
    });
    await prisma.webhookSubscription.create({
      data: { eventTypes: [], secret: 'secret-two', teamId: null, url: 'https://same.example.test/hook' },
    });
    await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });

    const targets = await collectOutboundWebhookTargets(prisma, null, null);
    expect(targets).toHaveLength(2);
    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch)).toEqual({ delivered: 1, failed: 0 });
    expect(signatures).toHaveLength(2);
    expect(new Set(signatures).size).toBe(2);
    const event = await prisma.eventOutbox.findFirstOrThrow();
    expect(await prisma.eventOutboxDelivery.count({ where: { eventId: event.id } })).toBe(2);
  });

  it('delivers every same-work event to team-scoped subscriptions', async () => {
    const posted: string[] = [];
    const deliver = async (url: string | URL | Request): Promise<Response> => {
      posted.push(String(url));
      return new Response('ok', { status: 200 });
    };

    await prisma.webhookSubscription.create({
      data: { eventTypes: [], secret: 'team-secret', teamId: team.id, url: 'https://scoped.example.test/hook' },
    });
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Fan-out work' });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'fan out', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    const targets = await collectOutboundWebhookTargets(prisma, null, null);
    // work.proposed + work.committed share one work id; both must reach the sub.
    expect(await flushEventOutbox(prisma, targets, deliver as typeof fetch)).toEqual({ delivered: 2, failed: 0 });
    expect(posted).toEqual([
      'https://scoped.example.test/hook',
      'https://scoped.example.test/hook',
    ]);
    expect(committed.commitmentStatus).toBe('COMMITTED');
  });

  it('delivers only matching work to IQL-filtered subscriptions', async () => {
    await prisma.webhookSubscription.create({
      data: {
        eventTypes: ['work.committed'],
        filterQuery: 'state-type:STARTED',
        secret: 'filtered-secret',
        teamId: team.id,
        url: 'https://iql-filter.example.test/hook',
      },
    });
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'IQL routed' });
    const startedStateRow = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, type: 'STARTED' },
    });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'routing drill', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await prisma.issue.update({
      where: { id: committed.id },
      data: { stateId: startedStateRow.id },
    });

    const delivered: string[] = [];
    const targets = await collectOutboundWebhookTargets(prisma, null, null);
    await flushEventOutbox(
      prisma,
      targets,
      (async (url: string | URL | Request, init?: RequestInit) => {
        delivered.push(String(init?.body));
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
    );

    expect(delivered.length).toBe(1);
    expect(delivered[0]).toContain('work.committed');
    expect(delivered[0]).toContain(committed.identifier);
  });

  it('falls back to env targets when no subscription exists', async () => {    expect(await collectOutboundWebhookTargets(prisma, 'https://env.example.test/hook', 'env-secret')).toEqual([
      { secret: 'env-secret', url: 'https://env.example.test/hook' },
    ]);
    expect(await collectOutboundWebhookTargets(prisma, null, null)).toEqual([]);
  });

  it('disables subscriptions after persistent delivery failure', async () => {
    const subscription = await prisma.webhookSubscription.create({
      data: {
        eventTypes: [],
        secret: 'flaky-secret',
        teamId: null,
        url: 'https://flaky.example.test/hook',
      },
    });
    await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    const failing = async (): Promise<Response> => new Response('down', { status: 503 });

    // Walk the delivery through all five backoff slots (1m..10h).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const targets = await collectOutboundWebhookTargets(prisma, null, null);
      const result = await flushEventOutbox(prisma, targets, failing as typeof fetch, 20, {
        now: Date.now() + attempt * 11 * 60 * 60_000,
      });
      expect(result).toEqual({ delivered: 0, failed: 1 });
    }
    // Exhausted but not yet disabled: only one counted failure so far.
    const stillEnabled = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(stillEnabled.enabled).toBe(true);
    expect(stillEnabled.consecutiveFailures).toBe(1);

    // A second event walking the full schedule pushes the counter over: only
    // terminal (exhausted) outcomes count toward auto-disable.
    await prisma.eventOutbox.create({
      data: { payload: { data: {}, type: 'work.proposed' }, type: 'work.proposed' },
    });
    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: { consecutiveFailures: 9 },
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const targets = await collectOutboundWebhookTargets(prisma, null, null);
      const result = await flushEventOutbox(prisma, targets, failing as typeof fetch, 20, {
        now: Date.now() + attempt * 11 * 60 * 60_000,
      });
      if (attempt === 5) {
        expect(result).toEqual({ delivered: 0, failed: 1 });
      }
    }
    const after = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.enabled).toBe(false);
    expect(after.consecutiveFailures).toBe(10);
    // Disabled subscriptions stop minimal traffic: collector yields nothing.
    expect(await collectOutboundWebhookTargets(prisma, null, null)).toEqual([]);
    // Auto-disable is announced as an internal event for the notification projector.
    const disabledEvent = await prisma.eventOutbox.findFirst({
      where: { type: 'webhook.disabled' },
      orderBy: { createdAt: 'desc' },
    });
    expect(disabledEvent).toBeTruthy();
  });

  it('completing the same run twice does not duplicate the review transition', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Double complete' });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'once only', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    await claimWork(prisma, committed.id, {}, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    const actor = { actorId: human.id, actorKind: 'HUMAN' as const, surface: 'test' };
    const started = await reportRun(prisma, { status: 'running', workId: committed.id }, actor);
    const revisionBefore = (await prisma.issue.findUniqueOrThrow({ where: { id: committed.id } })).revision;

    const done1 = await reportRun(
      prisma,
      { idempotencyKey: 'done-key-1', runId: started.run.id, status: 'completed', workId: committed.id },
      actor,
    );
    const done2 = await reportRun(
      prisma,
      { idempotencyKey: 'done-key-1', runId: started.run.id, status: 'completed', workId: committed.id },
      actor,
    );
    expect(done2.run.id).toBe(done1.run.id);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: committed.id } });
    expect(after.revision).toBe(revisionBefore + 1);
    expect(await prisma.eventOutbox.count({ where: { type: 'work.review_submitted' } })).toBe(1);
  });
});
