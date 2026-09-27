import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { OPS_ADMIN_ONLY_MESSAGE } from './errors.ts';
import { startServer, type StartedServer } from './index.ts';
import { attachEvidence } from './run-service-evidence.ts';
import { createSession } from './session.ts';
import { createIssue } from './issue-service.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('the ops page (INV-796)', () => {
  let admin: User;
  let person: User;
  let server: StartedServer;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.opsAudit.deleteMany();
    await prisma.syncDeadLetter.deleteMany();
    await prisma.syncWatermark.deleteMany();
    await prisma.inboundGitHubDelivery.deleteMany();
    await prisma.webhookSubscription.deleteMany();
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    person = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'person@test.local', name: 'Person' } });
    server = await startServer({ authToken: 'test-auth-token', port: 0, prisma });
  });

  afterEach(async () => {
    await server.stop();
  });

  afterAll(async () => {
    // Nothing here is reset by resetAndSeed; other suites count these rows.
    await prisma.webhookSubscription.deleteMany();
    await prisma.opsAudit.deleteMany();
    await prisma.syncDeadLetter.deleteMany();
    await prisma.syncWatermark.deleteMany();
    await prisma.inboundGitHubDelivery.deleteMany();
    await prisma.$disconnect();
  });

  // Signed in as a person with a session cookie, the way the web app calls the API.
  const run = async (viewer: User, query: string, variables: Record<string, unknown> = {}) => {
    const { token } = await createSession(prisma, viewer.id);
    const response = await fetch(`${server.url}/graphql`, {
      body: JSON.stringify({ query, variables }),
      headers: { 'content-type': 'application/json', cookie: `involute_session=${token}`, origin: server.url },
      method: 'POST',
    });
    return (await response.json()) as { data?: any; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };
  };

  it('shows admins the sync watermarks, dead letters, inbound queue and failed outbox events', async () => {
    await prisma.syncWatermark.create({ data: { key: 'github_sync_acme/app', watermark: new Date('2026-09-20T00:00:00Z') } });
    await prisma.syncDeadLetter.create({ data: { repository: 'acme/app', itemRef: 'pr#20', error: 'deadlock', attempts: 3 } });
    await prisma.inboundGitHubDelivery.create({
      data: { deliveryId: 'd-1', payloadHash: 'h', eventType: 'pull_request', repository: 'acme/app', payload: {}, status: 'DEAD', attempts: 3 },
    });
    await prisma.eventOutbox.create({ data: { type: 'work.committed', payload: {}, attempts: 5, lastError: 'HTTP 500', deadLetteredAt: new Date() } });

    const result = await run(admin, `{ opsOverview {
      watermarks { repository watermark }
      syncDeadLetters { repository itemRef attempts }
      inbound { counts { status count } dead { deliveryId replayable } }
      outboxFailures { type lastError }
      webhooks { id }
    } }`);
    expect(result.errors).toBeUndefined();
    const overview = (result.data as { opsOverview: Record<string, unknown> }).opsOverview;
    expect(overview).toMatchObject({
      watermarks: [{ repository: 'acme/app', watermark: '2026-09-20T00:00:00.000Z' }],
      syncDeadLetters: [{ repository: 'acme/app', itemRef: 'pr#20', attempts: 3 }],
      inbound: { counts: [{ status: 'DEAD', count: 1 }], dead: [{ deliveryId: 'd-1', replayable: true }] },
      outboxFailures: [{ type: 'work.committed', lastError: 'HTTP 500' }],
    });
  });

  it('refuses anyone who is not an admin', async () => {
    const read = await run(person, '{ opsOverview { watermarks { key } } }');
    expect(read.errors?.[0]).toMatchObject({ message: OPS_ADMIN_ONLY_MESSAGE, extensions: { code: 'FORBIDDEN' } });
    const clear = await run(person, 'mutation { opsSyncDeadLetterClear(id: "x", reason: "y") { success } }');
    expect(clear.errors?.[0]?.message).toBe(OPS_ADMIN_ONLY_MESSAGE);
  });

  it('clears a dead letter with a reason, on the audit, so the next sync retries it', async () => {
    const row = await prisma.syncDeadLetter.create({ data: { repository: 'acme/app', itemRef: 'pr#21', error: 'boom', attempts: 3 } });
    const mutation = 'mutation($id: String!, $reason: String!) { opsSyncDeadLetterClear(id: $id, reason: $reason) { success message } }';

    const noReason = await run(admin, mutation, { id: row.id, reason: '  ' });
    expect(noReason.data).toMatchObject({ opsSyncDeadLetterClear: { success: false, message: expect.stringMatching(/Say why/) } });

    const cleared = await run(admin, mutation, { id: row.id, reason: 'Deadlock fixed in #140' });
    expect(cleared.data).toMatchObject({ opsSyncDeadLetterClear: { success: true, message: null } });
    expect(await prisma.syncDeadLetter.count()).toBe(0);
    expect(await prisma.opsAudit.findFirstOrThrow()).toMatchObject({
      action: 'sync-dead-letter-cleared',
      subject: 'acme/app pr#21',
      byActorId: admin.id,
      reason: 'Deadlock fixed in #140',
    });

    const again = await run(admin, mutation, { id: row.id, reason: 'twice' });
    expect(again.data).toMatchObject({ opsSyncDeadLetterClear: { success: false, message: expect.stringMatching(/no longer exists/) } });
  });

  it('replays a dead inbound delivery once, from the attempt count the page saw', async () => {
    const dead = await prisma.inboundGitHubDelivery.create({
      data: { deliveryId: 'd-2', payloadHash: 'h', eventType: 'push', repository: 'acme/app', payload: { ref: 'main' }, status: 'DEAD', attempts: 4 },
    });
    const mutation =
      'mutation($id: String!, $n: Int!) { opsInboundReplay(id: $id, reason: "Upstream fixed", expectedAttempts: $n) { success message } }';

    const stale = await run(admin, mutation, { id: dead.id, n: 3 });
    expect(stale.data).toMatchObject({ opsInboundReplay: { success: false, message: expect.stringMatching(/refresh and try again/) } });

    const replayed = await run(admin, mutation, { id: dead.id, n: 4 });
    expect(replayed.data).toMatchObject({ opsInboundReplay: { success: true } });
    expect(await prisma.inboundGitHubDelivery.findUniqueOrThrow({ where: { id: dead.id } })).toMatchObject({ status: 'PENDING' });
    expect(await prisma.inboundGitHubReplay.findFirstOrThrow({ where: { deliveryId: dead.id } })).toMatchObject({ source: 'ops-page' });
    expect(await prisma.opsAudit.findFirstOrThrow()).toMatchObject({ action: 'inbound-replayed', byActorId: admin.id });
  });

  it('puts webhook changes on the audit without the secret', async () => {
    const created = await run(admin, 'mutation { webhookCreate(input: { url: "https://hooks.example.com/x", label: "CI" }) { success secret subscription { id } } }');
    const { secret, subscription } = (created.data as { webhookCreate: { secret: string; subscription: { id: string } } }).webhookCreate;
    await run(admin, `mutation { webhookUpdate(id: "${subscription.id}", input: { enabled: false }) { success } }`);
    await run(admin, `mutation { webhookRotateSecret(id: "${subscription.id}") { success } }`);
    const audits = await prisma.opsAudit.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audits.map((audit) => audit.action)).toEqual(['webhook-created', 'webhook-updated', 'webhook-secret-rotated']);
    expect(JSON.stringify(audits)).not.toContain(secret);
  });

  it('lets a person record a merged PR as evidence without a run; an agent still needs its run', async () => {
    const team = await prisma.team.findFirstOrThrow();
    const work = await createIssue(prisma, { teamId: team.id, title: 'Merged without a record', repository: 'test/placement', parentId: await testParentId(prisma, team.id) });
    const recorded = await attachEvidence(
      prisma,
      { workId: work.id, kind: 'pr', url: 'https://github.com/acme/app/pull/64', summary: 'Found by the traceability audit' },
      { actorId: admin.id, actorKind: 'HUMAN', surface: 'graphql' },
    );
    expect(recorded.evidence).toMatchObject({ runId: null, actorId: admin.id, kind: 'PR' });

    const bot = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'bot@agents.test.local', handle: 'bot', name: 'Bot' } });
    await expect(
      attachEvidence(prisma, { workId: work.id, kind: 'pr', url: 'https://github.com/acme/app/pull/65' }, { actorId: bot.id, actorKind: 'AGENT', surface: 'mcp' }),
    ).rejects.toThrow(/must reference a work run/);
  });
});
