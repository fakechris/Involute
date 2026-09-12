import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient, Prisma, type Issue } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import {
  acceptGitHubDelivery, claimGitHubDelivery, compactGitHubReceipts, drainGitHubDeliveries,
  getGitHubInboundStatus, processClaimedGitHubDelivery, replayGitHubDelivery,
} from './github-inbound.ts';
import { deliverOpsAlert } from './ops-alerts.ts';
import { handleGitHubWebhook, processStoredGitHubEvent } from './github-webhook-handler.ts';

const prisma = new PrismaClient();
const secret = 'inbound-test-secret';
let issue: Issue;
const children = new Set<ChildProcess>();

function branchPayload() {
  return { ref: `feat/${issue.identifier}-work`, ref_type: 'branch', repository: { full_name: 'fakechris/Involute' } };
}
async function accept(deliveryId = randomUUID(), payload = branchPayload()) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return acceptGitHubDelivery(prisma, { deliveryId, payload, rawBody, eventType: 'create', repository: payload.repository.full_name });
}
function request(body: string, eventType = 'create', deliveryId: string | undefined = randomUUID(), signature?: string) {
  const req = new EventEmitter() as IncomingMessage;
  req.method = 'POST'; req.url = '/api/webhooks/github';
  req.headers = {
    'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    'x-github-event': eventType,
    ...(deliveryId === undefined ? {} : { 'x-github-delivery': deliveryId }),
  };
  process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}
function response() {
  const end = vi.fn();
  const res = { statusCode: 0, headersSent: false, setHeader: vi.fn(), end } as unknown as ServerResponse;
  return { res, end };
}
async function state() { return (await prisma.issue.findUniqueOrThrow({ where: { id: issue.id }, include: { state: true } })).state.type; }

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.inboundGitHubDelivery.deleteMany(); await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.inboundGitHubDelivery.deleteMany();
  await prisma.eventOutbox.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.workflowState.deleteMany();
  await prisma.team.deleteMany();
  await prisma.issueLabel.deleteMany();
  await prisma.user.deleteMany();
  await prisma.legacyLinearMapping.deleteMany();
  await seedDatabase(prisma);
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
  issue = await prisma.issue.create({ data: {
    identifier: 'INV-9001', title: 'Receipt target', teamId: team.id, stateId: ready.id,
    assigneeId: owner.id, acceptance: 'reviewed contract', repository: 'fakechris/Involute',
  } });
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  children.clear(); vi.restoreAllMocks();
});

describe('durable GitHub intake', () => {
  it('commits a receipt before acknowledging and does not apply the event in the HTTP handler', async () => {
    const { res, end } = response();
    await handleGitHubWebhook({ prisma, webhookSecret: secret }, request(JSON.stringify(branchPayload())), res);
    expect(res.statusCode).toBe(200);
    const output = JSON.parse(end.mock.calls[0]![0]);
    expect(await prisma.inboundGitHubDelivery.findUnique({ where: { id: output.receipt_id } })).toMatchObject({ status: 'PENDING' });
    expect(await state()).toBe('UNSTARTED');
  });

  it('does not acknowledge while the receipt transaction is held before commit', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const original = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (action: any) => {
      return original(async tx => { const value = await action(tx); entered(); await gate; return value; });
    });
    const { res, end } = response();
    const pending = handleGitHubWebhook({ prisma, webhookSecret: secret }, request(JSON.stringify(branchPayload())), res);
    await entry;
    expect(end).not.toHaveBeenCalled();
    expect(await prisma.inboundGitHubDelivery.count()).toBe(0);
    release(); await pending;
    expect(res.statusCode).toBe(200);
    expect(await prisma.inboundGitHubDelivery.count()).toBe(1);
  });

  it('returns 503 on durable storage failure without exposing the exception text', async () => {
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('private-token-should-not-appear'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, end } = response();
    await handleGitHubWebhook({ prisma, webhookSecret: secret }, request(JSON.stringify(branchPayload())), res);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(end.mock.calls)).not.toContain('private-token');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
    expect(await prisma.inboundGitHubDelivery.count()).toBe(0);
  });

  it('deduplicates retries and rejects a changed payload without overwriting the receipt', async () => {
    const first = await accept('same-delivery');
    expect((await accept('same-delivery')).id).toBe(first.id);
    await expect(accept('same-delivery', { ...branchPayload(), ref: 'changed' })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.inboundGitHubDelivery.count()).toBe(1);
    expect((await prisma.inboundGitHubDelivery.findUniqueOrThrow({ where: { id: first.id } })).payloadHash).toBe(first.payloadHash);
  });

  it('does not log alert credentials or raw network exceptions', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error('private-network-credential'));
    await deliverOpsAlert({ kind: 'github_inbound.dead_letter', summary: 'Failed', details: {} },
      'https://alerts.example.test/secret-path?token=private-alert-token', fetchImpl);
    expect(log).toHaveBeenCalled();
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain('private-');
    expect(output).not.toContain('secret-path');
  });

  it('rejects invalid signatures, envelopes and oversized bodies before storing work', async () => {
    for (const [body, signature, expected] of [
      [JSON.stringify(branchPayload()), 'sha256=invalid', 401],
      ['{}', undefined, 400],
      ['x'.repeat(5 * 1024 * 1024 + 1), undefined, 413],
    ] as const) {
      const { res } = response();
      await handleGitHubWebhook({ prisma, webhookSecret: secret }, request(body, 'create', randomUUID(), signature), res);
      expect(res.statusCode).toBe(expected);
    }
    expect(await prisma.inboundGitHubDelivery.count()).toBe(0);
  });
});

describe('leased processing and replay', () => {
  it('applies a branch-only event and outbox exactly once across concurrent consumers', async () => {
    const receipt = await accept();
    await Promise.all([drainGitHubDeliveries(prisma, processStoredGitHubEvent), drainGitHubDeliveries(prisma, processStoredGitHubEvent)]);
    expect(await state()).toBe('STARTED');
    expect(await prisma.webhookEventLog.count({ where: { issueId: issue.id } })).toBe(1);
    expect(await prisma.eventOutbox.count({ where: { type: 'work.state_changed' } })).toBe(1);
    expect(await prisma.inboundGitHubDelivery.findUnique({ where: { id: receipt.id } })).toMatchObject({ status: 'PROCESSED', attempts: 1 });
    await drainGitHubDeliveries(prisma, processStoredGitHubEvent);
    expect(await prisma.eventOutbox.count({ where: { type: 'work.state_changed' } })).toBe(1);
  });

  it('replays an old branch followed by a PR without replacing provider time with consumer time', async () => {
    await accept('delayed-branch');
    const payload = {
      action: 'opened', repository: { full_name: 'fakechris/Involute' },
      pull_request: { id: 12345, number: 99, title: 'Review delivery', merged: false,
        html_url: 'https://github.com/fakechris/Involute/pull/99',
        head: { ref: `feat/${issue.identifier}-work` }, updated_at: '2026-01-01T00:00:00.000Z' },
    };
    await acceptGitHubDelivery(prisma, { deliveryId: 'delayed-pr', eventType: 'pull_request',
      repository: payload.repository.full_name, payload, rawBody: Buffer.from(JSON.stringify(payload)) });
    await drainGitHubDeliveries(prisma, processStoredGitHubEvent);
    expect(await state()).toBe('REVIEW');
    expect(await prisma.eventOutbox.count({ where: { type: 'work.state_changed' } })).toBe(2);
  });

  it('keeps a notification SQL failure outside the receipt transaction', async () => {
    await accept('unknown-ref', { ...branchPayload(), ref: 'feat/INV-999999-work' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const database = prisma.$extends({ query: { notification: {
      async createMany({ args, query }) {
        // Real foreign-key failure; inside a business transaction this aborts it.
        args.data = [{ userId: randomUUID(), type: 'ops.test' }];
        return query(args);
      },
    } } });
    const result = await drainGitHubDeliveries(database as unknown as PrismaClient, processStoredGitHubEvent);
    expect(result.processed).toBe(1);
    expect(log).toHaveBeenCalled();
    expect(await prisma.inboundGitHubDelivery.findFirst()).toMatchObject({ status: 'PROCESSED' });
  });

  it('rolls back business effects, dedupe and outbox together when processing fails', async () => {
    await accept();
    const result = await drainGitHubDeliveries(prisma, async (tx, receipt) => {
      await processStoredGitHubEvent(tx, receipt);
      throw new Error('fault after business writes');
    });
    expect(result.retry).toBe(1);
    expect(await state()).toBe('UNSTARTED');
    expect(await prisma.webhookEventLog.count({ where: { issueId: issue.id } })).toBe(0);
    expect(await prisma.eventOutbox.count({ where: { type: 'work.state_changed' } })).toBe(0);
    const receipt = await prisma.inboundGitHubDelivery.findFirstOrThrow();
    expect(receipt.status).toBe('RETRY');
    expect(receipt.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an expired lease holder after another consumer takes over', async () => {
    await accept();
    const old = await claimGitHubDelivery(prisma);
    await prisma.inboundGitHubDelivery.update({ where: { id: old!.id }, data: { leaseUntil: new Date(0) } });
    const current = await claimGitHubDelivery(prisma);
    expect(current!.leaseOwner).not.toBe(old!.leaseOwner);
    expect(await processClaimedGitHubDelivery(prisma, old!, processStoredGitHubEvent)).toBe('stale');
    expect(await state()).toBe('UNSTARTED');
    expect(await processClaimedGitHubDelivery(prisma, current!, processStoredGitHubEvent)).toBe('processed');
    expect(await prisma.inboundGitHubAttempt.findMany({ orderBy: { number: 'asc' } })).toMatchObject([
      { outcome: 'EXPIRED' }, { outcome: 'PROCESSED' },
    ]);
  });

  it('quarantines poison messages, continues other receipts, and audits an explicit replay', async () => {
    const poison = await accept('poison');
    const processor = async (tx: Prisma.TransactionClient, receipt: Awaited<ReturnType<typeof accept>>) => {
      if (receipt.id === poison.id) throw new Error('bad downstream state');
      return processStoredGitHubEvent(tx, receipt);
    };
    for (let i = 0; i < 3; i += 1) {
      await prisma.inboundGitHubDelivery.update({ where: { id: poison.id }, data: { availableAt: new Date(0) } });
      await drainGitHubDeliveries(prisma, processor);
    }
    const good = await accept('good');
    await drainGitHubDeliveries(prisma, processor);
    expect(await prisma.inboundGitHubDelivery.findUnique({ where: { id: good.id } })).toMatchObject({ status: 'PROCESSED' });
    expect((await getGitHubInboundStatus(prisma)).dead).toHaveLength(1);
    await expect(replayGitHubDelivery(prisma, poison.id, 'fixed', 2)).rejects.toThrow('Replay conflict');
    await replayGitHubDelivery(prisma, poison.id, 'configuration repaired', 3);
    await drainGitHubDeliveries(prisma, processStoredGitHubEvent);
    expect(await prisma.inboundGitHubAttempt.count({ where: { deliveryId: poison.id } })).toBe(4);
    expect(await prisma.inboundGitHubReplay.findFirst({ where: { deliveryId: poison.id } })).toMatchObject({ reason: 'configuration repaired', previousAttempts: 3 });
  });

  it('compacts completed payloads while preserving dedupe and unprocessed payloads', async () => {
    const receipt = await accept('compact');
    await drainGitHubDeliveries(prisma, processStoredGitHubEvent);
    await prisma.inboundGitHubDelivery.update({ where: { id: receipt.id }, data: { processedAt: new Date(0) } });
    const pending = await accept('pending');
    await compactGitHubReceipts(prisma, 1);
    expect((await prisma.inboundGitHubDelivery.findUniqueOrThrow({ where: { id: receipt.id } })).payload).toBeNull();
    expect((await prisma.inboundGitHubDelivery.findUniqueOrThrow({ where: { id: pending.id } })).payload).not.toBeNull();
    expect((await accept('compact')).id).toBe(receipt.id);
    expect(await prisma.inboundGitHubDelivery.count()).toBe(2);
  });

  it.each(['before-commit', 'after-commit'])('survives HTTP process death %s without an early ACK', async stage => {
    const child = fork(fileURLToPath(new URL('./__fixtures__/github-inbound-crash.ts', import.meta.url)),
      [stage, JSON.stringify(branchPayload())], { execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL } });
    children.add(child);
    const messages: unknown[] = [];
    child.on('message', message => messages.push(message));
    const message = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('HTTP fixture exited before checkpoint'); }),
    ]);
    expect(message[0]).toEqual({ stage });
    expect(await prisma.inboundGitHubDelivery.count()).toBe(stage === 'before-commit' ? 0 : 1);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(messages).toEqual([{ stage }]);
    const { res } = response();
    await handleGitHubWebhook({ prisma, webhookSecret: secret }, request(JSON.stringify(branchPayload()), 'create', 'crash-intake'), res);
    expect(res.statusCode).toBe(200);
    expect(await prisma.inboundGitHubDelivery.count()).toBe(1);
    await drainGitHubDeliveries(prisma, processStoredGitHubEvent);
    expect(await state()).toBe('STARTED');
    expect(await prisma.webhookEventLog.count({ where: { issueId: issue.id } })).toBe(1);
  }, 15_000);

  it.each(['claimed', 'applied'])('recovers after SIGKILL at the %s boundary', async stage => {
    const receipt = await accept();
    const child = fork(fileURLToPath(new URL('./__fixtures__/github-inbound-crash.ts', import.meta.url)), [stage], {
      execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL },
    });
    children.add(child);
    const message = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('Crash fixture exited before checkpoint'); }),
    ]);
    expect(message[0]).toMatchObject({ stage, id: receipt.id });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(await state()).toBe('UNSTARTED');
    expect(await prisma.webhookEventLog.count({ where: { issueId: issue.id } })).toBe(0);
    await prisma.inboundGitHubDelivery.update({ where: { id: receipt.id }, data: { leaseUntil: new Date(0) } });
    await drainGitHubDeliveries(prisma, processStoredGitHubEvent);
    expect(await state()).toBe('STARTED');
    expect(await prisma.webhookEventLog.count({ where: { issueId: issue.id } })).toBe(1);
    expect(await prisma.eventOutbox.count({ where: { type: 'work.state_changed' } })).toBe(1);
  }, 15_000);
});
