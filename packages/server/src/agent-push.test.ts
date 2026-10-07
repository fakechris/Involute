import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { collectOutboundWebhookTargets, flushEventOutbox } from './event-outbox.ts';
import { proposeWork } from './claim-service.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

// INV-992: a webhook bound to one agent is its push channel — it hears what
// reached its inbox and the dispatches addressed to it, nothing else.
describe('agent push channel', () => {
  let team: Team;
  let human: User;
  let agent: User;
  let otherAgent: User;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.executorDispatch.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.webhookSubscription.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { email: 'push-agent@example.test', name: 'Push agent', handle: 'push-agent', actorKind: 'AGENT' } });
    otherAgent = await prisma.user.create({ data: { email: 'other-agent@example.test', name: 'Other agent', handle: 'other-agent', actorKind: 'AGENT' } });
  });

  function fakeFetch(delivered: Array<{ url: string; body: Record<string, unknown> }>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      delivered.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
  }

  it('delivers to an agent only the events that reached its inbox', async () => {
    const proposed = await proposeWork(
      prisma,
      { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Push me' },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const proposedEvent = await prisma.eventOutbox.findFirstOrThrow({ where: { type: 'work.proposed' } });
    // The human's inbox got the proposal; the agent's did not.
    await prisma.notification.create({ data: { userId: human.id, type: 'work.proposed', workId: proposed.id, sourceEventId: proposedEvent.id } });
    const decided = await prisma.eventOutbox.create({ data: { type: 'work.committed', payload: { type: 'work.committed', data: { workId: proposed.id } } } });
    await prisma.notification.create({ data: { userId: agent.id, type: 'work.committed', workId: proposed.id, sourceEventId: decided.id } });
    await prisma.notification.create({ data: { userId: otherAgent.id, type: 'work.committed', workId: proposed.id, sourceEventId: decided.id } });

    await prisma.webhookSubscription.create({
      data: { createdById: human.id, secret: 'agent-secret', url: 'https://agent.example.test/wake', actorId: agent.id, label: 'push' },
    });
    await prisma.webhookSubscription.create({
      data: { createdById: human.id, secret: 'ci-secret', url: 'https://ci.example.test/hook', label: 'everything' },
    });
    const targets = await collectOutboundWebhookTargets(prisma, null, null);
    expect(targets.find((target) => target.url.startsWith('https://agent.'))?.actorId).toBe(agent.id);

    const delivered: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await flushEventOutbox(prisma, targets, fakeFetch(delivered));
    expect(result.failed).toBe(0);

    const toAgent = delivered.filter((item) => item.url.startsWith('https://agent.'));
    expect(toAgent.map((item) => item.body.type)).toEqual(['work.committed']);
    expect(toAgent[0]!.body.actor_id).toBe(agent.id);
    expect(toAgent[0]!.body.wake).toContain('agent_inbox');
    // The unbound subscription still hears everything.
    expect(delivered.filter((item) => item.url.startsWith('https://ci.')).map((item) => item.body.type)).toEqual(
      expect.arrayContaining(['work.proposed', 'work.committed']),
    );
    // Events the agent must not hear are settled, not left pending for it.
    const pending = await prisma.eventOutboxDelivery.count({ where: { deliveredAt: null } });
    expect(pending).toBe(0);
  });

  it('routes a dispatch to the executor it names', async () => {
    const work = await proposeWork(
      prisma,
      { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Execute me' },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const dispatch = await prisma.executorDispatch.create({
      data: { workId: work.id, rootId: work.id, grantRevision: 1, executorActorId: agent.id },
    });
    await prisma.eventOutbox.create({
      data: { type: 'executor.dispatched', payload: { type: 'executor.dispatched', data: { dispatchId: dispatch.id, generation: 1, actorId: agent.id } } },
    });
    await prisma.webhookSubscription.create({
      data: { createdById: human.id, secret: 'a', url: 'https://agent.example.test/wake', actorId: agent.id },
    });
    await prisma.webhookSubscription.create({
      data: { createdById: human.id, secret: 'b', url: 'https://other.example.test/wake', actorId: otherAgent.id },
    });

    const delivered: Array<{ url: string; body: Record<string, unknown> }> = [];
    await flushEventOutbox(prisma, await collectOutboundWebhookTargets(prisma, null, null), fakeFetch(delivered));

    const dispatched = delivered.filter((item) => item.body.type === 'executor.dispatched');
    expect(dispatched.map((item) => item.url)).toEqual(['https://agent.example.test/wake']);
  });
});
