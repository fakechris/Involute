import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimAgentRequest } from './agent-request-service.ts';
import {
  DEADLINE_FAILURE_REASON,
  SYSTEM_ACTOR_EMAIL,
  buildExpiryNotice,
  expireOverdueAgentRequests,
} from './agent-request-expiry.ts';
import {
  PRESENCE_COPY,
  STALE_AFTER_MS,
  UNRESPONSIVE_AFTER_MS,
  agentRequestPresence,
} from './agent-request-presence.ts';
import { createComment } from './issue-service.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

// Wording that asserts *why* nobody answered. The server cannot know any of
// this, and a person who believes it chases the wrong problem (docs/54 §D3).
const FORBIDDEN_CLAIMS = [
  /\bnot running\b/,
  /\bisn't running\b/,
  /\boffline\b/,
  /\bunavailable\b/,
  /\bdown\b/,
  /\bdead\b/,
  /\bcrashed\b/,
  /\bfailed to start\b/,
  /\bbroken\b/,
];

describe('agent request expiry (INV-562 / A6)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
  });

  describe('A6 — an unanswered question says so, in the thread', () => {
    it('posts a notice on the thread naming who to ask instead', async () => {
      const { issue, mia, request, rootCommentId } = await openOverdueRequest(prisma);
      const kai = await createAgent(prisma, 'Kai', 'kai');
      await prisma.user.update({
        where: { id: mia.id },
        data: { successorActorId: kai.id },
      });

      await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(1);

      const replies = await prisma.comment.findMany({
        where: { parentCommentId: rootCommentId },
      });

      expect(replies).toHaveLength(1);
      const notice = replies[0]!;
      expect(notice.body).toContain('@mia');
      expect(notice.body).toContain('has not replied within the deadline');
      expect(notice.body).toContain('@kai');
      expect(notice.issueId).toBe(issue.id);

      // Posted by the system, not by a person and not by the agent that did
      // not answer — impersonating either would be a lie in the audit trail.
      const author = await prisma.user.findUniqueOrThrow({ where: { id: notice.userId } });
      expect(author.email).toBe(SYSTEM_ACTOR_EMAIL);
      expect(author.actorKind).toBe('SERVICE');

      const settled = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(settled.state).toBe('FAILED');
      expect(settled.failureReason).toBe(DEADLINE_FAILURE_REASON);
    });

    it('falls back to the team humans when no successor is declared', async () => {
      const { rootCommentId } = await openOverdueRequest(prisma);

      await expireOverdueAgentRequests(prisma);

      const notice = await prisma.comment.findFirstOrThrow({
        where: { parentCommentId: rootCommentId },
      });

      expect(notice.body).toContain('No successor is declared');
      expect(notice.body).toContain('Admin');
    });

    it('never claims to know why the answer did not come', async () => {
      const { rootCommentId } = await openOverdueRequest(prisma);

      await expireOverdueAgentRequests(prisma);

      const notice = await prisma.comment.findFirstOrThrow({
        where: { parentCommentId: rootCommentId },
      });
      const body = notice.body.toLowerCase();

      expect(body).toContain('not that the agent is unavailable');
      for (const claim of FORBIDDEN_CLAIMS) {
        // The one permitted mention is the explicit disclaimer above.
        const withoutDisclaimer = body.replace('not that the agent is unavailable', '');
        expect(withoutDisclaimer).not.toMatch(claim);
      }
      expect(DEADLINE_FAILURE_REASON.toLowerCase()).not.toMatch(/\bnot running\b/);
    });

    it('notifies the person who asked, not the team owners by default', async () => {
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');
      const { request } = await openOverdueRequest(prisma, dana);

      await expireOverdueAgentRequests(prisma);

      const notifications = await prisma.notification.findMany({
        where: { type: 'agent.request_expired' },
      });

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.userId).toBe(dana.id);
      const payload = notifications[0]?.payload as { advice: string; requestId: string };
      expect(payload.requestId).toBe(request.id);
      expect(payload.advice).toContain('@mia');
    });

    it('emits agent.request_expired so consumers hear about it too', async () => {
      await openOverdueRequest(prisma);

      await expireOverdueAgentRequests(prisma);

      const events = await prisma.eventOutbox.findMany({
        where: { type: 'agent.request_expired' },
      });

      expect(events).toHaveLength(1);
      const payload = events[0]?.payload as { data: { reason: string; targetActorId: string } };
      expect(payload.data.reason).toBe(DEADLINE_FAILURE_REASON);
    });

    it('is idempotent: a second sweep does not post a second notice', async () => {
      const { rootCommentId } = await openOverdueRequest(prisma);

      await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(1);
      await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(0);

      await expect(prisma.comment.count({ where: { parentCommentId: rootCommentId } }))
        .resolves.toBe(1);
      await expect(prisma.notification.count({ where: { type: 'agent.request_expired' } }))
        .resolves.toBe(1);
    });

    it('leaves an answered request alone', async () => {
      const { mia, request, rootCommentId } = await openOverdueRequest(prisma);
      await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });
      const { answerAgentRequest } = await import('./agent-request-service.ts');
      await answerAgentRequest(prisma, { actorId: mia.id, body: 'answered in time', id: request.id });

      await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(0);

      const replies = await prisma.comment.findMany({ where: { parentCommentId: rootCommentId } });
      expect(replies).toHaveLength(1);
      expect(replies[0]?.body).toBe('answered in time');
    });
  });

  describe('honest presence, alongside the A2A state', () => {
    const base = {
      claimExpiresAt: null,
      claimedAt: null,
      claimedBy: null,
      state: 'SUBMITTED' as const,
      updatedAt: new Date('2026-09-15T00:00:00Z'),
    };
    const now = new Date('2026-09-15T00:00:00Z');

    it('reports waiting while nobody has picked it up', () => {
      expect(agentRequestPresence(base, now)).toBe('waiting');
    });

    it('reports live right after a claim', () => {
      expect(agentRequestPresence(
        { ...base, claimedAt: now, claimedBy: 'a', state: 'WORKING' },
        now,
      )).toBe('live');
    });

    it('reports unresponsive after ten silent seconds', () => {
      expect(agentRequestPresence(
        { ...base, claimedAt: now, claimedBy: 'a', state: 'WORKING' },
        new Date(now.getTime() + UNRESPONSIVE_AFTER_MS),
      )).toBe('unresponsive');
    });

    it('reports stale after thirty silent minutes, and stale is recoverable', () => {
      expect(agentRequestPresence(
        { ...base, claimedAt: now, claimedBy: 'a', state: 'WORKING' },
        new Date(now.getTime() + STALE_AFTER_MS),
      )).toBe('stale');
    });

    it('reports settled once terminal', () => {
      for (const state of ['COMPLETED', 'FAILED', 'CANCELED'] as const) {
        expect(agentRequestPresence({ ...base, state }, now)).toBe('settled');
      }
    });

    it('describes presence without asserting why', () => {
      for (const copy of Object.values(PRESENCE_COPY)) {
        for (const claim of FORBIDDEN_CLAIMS) {
          expect(copy.toLowerCase()).not.toMatch(claim);
        }
      }
      expect(PRESENCE_COPY.unresponsive).toContain('no activity');
    });
  });

  // Over HTTP like the repo's other GraphQL tests: constructing the schema
  // in-process and calling graphql() directly hits a module-realm mismatch,
  // because @graphql-tools/schema resolves its own copy of `graphql`.
  describe('GraphQL surface', () => {
    const TEST_AUTH_TOKEN = 'test-auth-token';
    let server: StartedServer;

    beforeEach(async () => {
      server = await startServer({
        allowAdminFallback: true,
        prisma,
        authToken: TEST_AUTH_TOKEN,
        port: 0,
      });
    });

    afterEach(async () => {
      await server.stop();
    });

    async function query(source: string): Promise<{ data: any; errors?: unknown[] }> {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        },
        body: JSON.stringify({ query: source }),
      });
      return response.json() as Promise<{ data: any; errors?: unknown[] }>;
    }

    it('serves agentRequests with A2A state and derived presence', async () => {
      // Regression: the SDL field and its resolver live in two different
      // places, and a field declared with no resolver fails only at query
      // time — the type checker cannot see it. That shipped once.
      const { issue } = await openOverdueRequest(prisma);

      const result = await query(`{ issue(id: "${issue.id}") {
        agentRequests(first: 5) {
          id state presence presenceDetail rootCommentId
          targetActor { handle } requestedByActor { name }
        }
      } }`);

      expect(result.errors).toBeUndefined();
      const requests = result.data.issue.agentRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0].state).toBe('submitted');
      expect(requests[0].presence).toBe('waiting');
      expect(requests[0].presenceDetail).toBe(PRESENCE_COPY.waiting);
      expect(requests[0].targetActor.handle).toBe('mia');
    });

    it('exposes a declared successor on the request', async () => {
      const { issue, mia } = await openOverdueRequest(prisma);
      const kai = await createAgent(prisma, 'Kai', 'kai');
      await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: kai.id } });

      const result = await query(
        `{ issue(id: "${issue.id}") { agentRequests(first: 1) { successorActor { handle } } } }`,
      );

      expect(result.errors).toBeUndefined();
      expect(result.data.issue.agentRequests[0].successorActor.handle).toBe('kai');
    });
  });

  describe('notice copy', () => {
    it('names the successor when there is one', () => {
      const notice = buildExpiryNotice({
        askedHandle: 'mia',
        askedName: 'Mia',
        successorHandle: 'kai',
        successorName: 'Kai',
        teamContacts: [],
      });
      expect(notice.fallbackAdvice).toContain('@kai');
    });

    it('says so plainly when there is nobody to hand off to', () => {
      const notice = buildExpiryNotice({
        askedHandle: 'mia',
        askedName: 'Mia',
        successorHandle: null,
        successorName: null,
        teamContacts: [],
      });
      expect(notice.fallbackAdvice).toContain('no human contact is recorded');
    });
  });
});

async function openOverdueRequest(
  prismaClient: PrismaClient,
  asker?: User,
): Promise<{ issue: Issue; mia: User; request: { id: string }; rootCommentId: string }> {
  const mia = await createAgent(prismaClient, 'Mia', 'mia');
  const issue = await createIssue(prismaClient);
  const human = asker
    ?? await prismaClient.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

  const comment = await createComment(
    prismaClient,
    { body: '@mia why did you decide that?', issueId: issue.id },
    human.id,
  );

  const request = await prismaClient.agentRequest.findFirstOrThrow({
    where: { targetActorId: mia.id },
  });
  await prismaClient.agentRequest.update({
    where: { id: request.id },
    data: { deadlineAt: new Date(Date.now() - 1_000) },
  });

  return { issue, mia, request, rootCommentId: comment.id };
}

async function createHuman(
  prismaClient: PrismaClient,
  name: string,
  email: string,
): Promise<User> {
  return prismaClient.user.create({ data: { actorKind: 'HUMAN', email, name } });
}

async function createAgent(
  prismaClient: PrismaClient,
  name: string,
  handle: string,
): Promise<User> {
  return prismaClient.user.create({
    data: { actorKind: 'AGENT', email: `${handle}@agents.test.local`, handle, name },
  });
}

async function createIssue(prismaClient: PrismaClient): Promise<Issue> {
  const team = await prismaClient.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await prismaClient.workflowState.findFirstOrThrow({
    where: { name: 'Ready', teamId: team.id },
  });

  return prismaClient.issue.create({
    data: {
      identifier: 'INV-905',
      stateId: state.id,
      teamId: team.id,
      title: 'Expiry host',
    },
  });
}
