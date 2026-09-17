import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  CLAIM_SUPERSEDED_MESSAGE,
  REQUEST_CLAIM_LEASE_MS,
  answerAgentRequest,
  cancelAgentRequest,
  claimAgentRequest,
  readAgentInbox,
} from './agent-request-service.ts';
import {
  DEADLINE_FAILURE_REASON,
  expireOverdueAgentRequests,
} from './agent-request-expiry.ts';
import { A2A_REQUEST_STATES, fromWireState, toWireState } from './agent-request-state.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('agent request ledger (INV-560)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('A2A state names', () => {
    it('uses A2A spellings on the wire, with no invented states', () => {
      expect([...A2A_REQUEST_STATES]).toEqual([
        'submitted',
        'working',
        'input-required',
        'completed',
        'failed',
        'canceled',
      ]);
    });

    it('round-trips every wire state through storage', () => {
      for (const wire of A2A_REQUEST_STATES) {
        const stored = fromWireState(wire);
        expect(stored).not.toBeNull();
        expect(toWireState(stored!)).toBe(wire);
      }
      expect(fromWireState('in_progress')).toBeNull();
    });
  });

  describe('opening a request', () => {
    it('opens a submitted request when a human mentions an agent', async () => {
      const mia = await createAgent(prisma, 'Mia', 'mia');
      const issue = await createIssue(prisma);
      const human = await humanAuthor(prisma);

      const comment = await createComment(
        prisma,
        { body: '@mia what was your reasoning?', issueId: issue.id },
        human.id,
      );

      const requests = await prisma.agentRequest.findMany();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.state).toBe('SUBMITTED');
      expect(requests[0]?.targetActorId).toBe(mia.id);
      expect(requests[0]?.requestedByActorId).toBe(human.id);
      expect(requests[0]?.rootCommentId).toBe(comment.id);
      expect(requests[0]?.deadlineAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('does not open a request when an agent mentions an agent', async () => {
      await createAgent(prisma, 'Mia', 'mia');
      const codex = await createAgent(prisma, 'Codex', 'codex');
      const issue = await createIssue(prisma);

      await createComment(prisma, { body: '@mia over to you', issueId: issue.id }, codex.id);

      await expect(prisma.agentRequest.count()).resolves.toBe(0);
    });

    it('is idempotent per (comment, target): a replayed write lands one request', async () => {
      const mia = await createAgent(prisma, 'Mia', 'mia');
      const issue = await createIssue(prisma);
      const human = await humanAuthor(prisma);

      const comment = await createComment(prisma, { body: '@mia ?', issueId: issue.id }, human.id);

      await expect(prisma.agentRequest.count()).resolves.toBe(1);

      const { openAgentRequestsForMentions } = await import('./agent-request-from-mention.ts');
      await openAgentRequestsForMentions(prisma, {
        comment,
        mentions: [{ actorId: mia.id, handle: 'mia' }],
        workId: issue.id,
      });

      await expect(prisma.agentRequest.count()).resolves.toBe(1);
    });
  });

  describe('A3 — exactly one consumer holds a request', () => {
    it('lets only one of two concurrent consumers claim it', async () => {
      const { mia, request } = await openRequest(prisma);
      const rival = await createAgent(prisma, 'Rival', 'rival');

      const outcomes = await Promise.allSettled([
        claimAgentRequest(prisma, { actorId: mia.id, id: request.id }),
        claimAgentRequest(prisma, { actorId: rival.id, id: request.id }),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');

      // The rival is not even the addressee, so it can never win.
      expect(fulfilled).toHaveLength(1);
      const held = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(held.claimedBy).toBe(mia.id);
      expect(held.state).toBe('WORKING');
    });

    it('lets only one of two consumers of the same actor claim it', async () => {
      const { mia, request } = await openRequest(prisma);

      // Two sidecars carrying credentials for the same actor. The claim is
      // server-side, so only the first take wins the right to answer.
      const first = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });
      expect(first.request.state).toBe('WORKING');

      const before = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
      const impostor = await createAgent(prisma, 'Other Sidecar', 'other');

      await expect(claimAgentRequest(prisma, { actorId: impostor.id, id: request.id }))
        .rejects.toThrow('not claimable');

      const after = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(after.claimedBy).toBe(before.claimedBy);
    });

    it('lets the holding execution renew with its token, keeping the same generation', async () => {
      const { mia, request } = await openRequest(prisma);
      const start = new Date();

      const taken = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, start);
      const renewed = await claimAgentRequest(
        prisma,
        { actorId: mia.id, claimToken: taken.claimToken, id: request.id },
        new Date(start.getTime() + 1_000),
      );

      expect(renewed.claimToken).toBe(taken.claimToken);
      expect(renewed.request.claimGeneration).toBe(taken.request.claimGeneration);
      expect(renewed.request.claimExpiresAt?.getTime())
        .toBe(start.getTime() + 1_000 + REQUEST_CLAIM_LEASE_MS);
    });

    it('does not let a second execution of the same actor take a live claim just by being the same actor', async () => {
      // This was the hole: "claimedBy === actorId" counted as holding it.
      const { mia, request } = await openRequest(prisma);
      const start = new Date();

      await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, start);

      await expect(claimAgentRequest(
        prisma,
        { actorId: mia.id, id: request.id },
        new Date(start.getTime() + 1_000),
      )).rejects.toThrow('not claimable');
    });

    it('rejects an answer from a stalled execution after a fresh one re-claimed (the P1 counterexample)', async () => {
      const { mia, request } = await openRequest(prisma);
      const t0 = new Date();

      // Session A claims, then stalls past its lease.
      const sessionA = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, t0);
      const afterLapse = new Date(t0.getTime() + REQUEST_CLAIM_LEASE_MS + 1);

      // Session B, same actor credential, takes a new generation.
      const sessionB = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, afterLapse);
      expect(sessionB.request.claimGeneration).toBe(sessionA.request.claimGeneration + 1);
      expect(sessionB.claimToken).not.toBe(sessionA.claimToken);

      // A wakes up and submits its old answer. Same actor, live lease (B's) —
      // the old check would have let this through.
      await expect(answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'stale answer from A',
        claimToken: sessionA.claimToken,
        id: request.id,
      }, new Date(afterLapse.getTime() + 1_000))).rejects.toThrow(CLAIM_SUPERSEDED_MESSAGE);

      // B answers fine.
      const answered = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'current answer from B',
        claimToken: sessionB.claimToken,
        id: request.id,
      }, new Date(afterLapse.getTime() + 2_000));

      expect(answered.request.state).toBe('COMPLETED');
      const comments = await prisma.comment.findMany({ where: { userId: mia.id } });
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toBe('current answer from B');
    });

    it('rejects an answer from a consumer that does not hold the claim', async () => {
      const { mia, request } = await openRequest(prisma);
      const other = await createAgent(prisma, 'Other', 'other');

      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });

      await expect(answerAgentRequest(prisma, {
        actorId: other.id,
        body: 'not mine to answer',
        claimToken: held.claimToken,
        id: request.id,
      })).rejects.toThrow('not held by this actor');
    });

    it('does not reach completed when the answer fails', async () => {
      const { mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });

      await expect(answerAgentRequest(prisma, {
        actorId: mia.id,
        body: '   ',
        claimToken: held.claimToken,
        id: request.id,
      })).rejects.toThrow('must have a body');

      const after = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });

      expect(after.state).toBe('WORKING');
      expect(after.answeredCommentId).toBeNull();
      await expect(prisma.comment.count({ where: { userId: mia.id } })).resolves.toBe(0);
    });
  });

  describe('A4 — a restart between receiving and answering', () => {
    it('leaves the request claimable after its lease lapses and answerable exactly once', async () => {
      const { mia, request } = await openRequest(prisma);
      const t0 = new Date();
      await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, t0);

      // "Restart": the process is gone and so is its claim token. The ledger
      // is not. The consumer comes back, re-reads its inbox, and — because it
      // cannot prove it is the same execution — waits for its own lease to
      // lapse, then takes a new generation like any other consumer.
      const inbox = await readAgentInbox(prisma, { actorId: mia.id });
      expect(inbox.items.map((item) => item.id)).toContain(request.id);
      expect(inbox.items.find((item) => item.id === request.id)?.state).toBe('working');

      const afterLapse = new Date(t0.getTime() + REQUEST_CLAIM_LEASE_MS + 1);
      const retaken = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, afterLapse);
      const answered = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'Because PR #77 already covered it.',
        claimToken: retaken.claimToken,
        id: request.id,
      }, new Date(afterLapse.getTime() + 1_000));

      expect(answered.request.state).toBe('COMPLETED');
      expect(answered.request.answeredCommentId).toBe(answered.commentId);

      // A second delivery of the same answer must not double-post.
      await expect(answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'Because PR #77 already covered it.',
        claimToken: retaken.claimToken,
        id: request.id,
      }, new Date(afterLapse.getTime() + 2_000))).rejects.toThrow('terminal state');

      await expect(prisma.comment.count({ where: { userId: mia.id } })).resolves.toBe(1);
    });
  });

  describe('answering', () => {
    it('posts the answer as the answering actor, not as whoever carried the token', async () => {
      const { issue, mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });

      const answered = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'I weighed the code-block case first.',
        claimToken: held.claimToken,
        id: request.id,
      });

      const comment = await prisma.comment.findUniqueOrThrow({
        where: { id: answered.commentId },
      });

      expect(comment.userId).toBe(mia.id);
      expect(comment.issueId).toBe(issue.id);
    });

    it('records evidence attached to the answer', async () => {
      const { issue, mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });

      await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'See the PR.',
        claimToken: held.claimToken,
        evidence: [{ kind: 'PR', summary: 'B1', url: 'https://example.test/pr/77' }],
        id: request.id,
      });

      const evidence = await prisma.workEvidence.findMany({ where: { workId: issue.id } });

      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.url).toBe('https://example.test/pr/77');
      expect(evidence[0]?.actorId).toBe(mia.id);
    });

    it('treats asking back as input-required and hands the claim back', async () => {
      const { mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });

      const answered = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'Which revision do you mean?',
        claimToken: held.claimToken,
        id: request.id,
        state: 'input-required',
      });

      expect(answered.request.state).toBe('INPUT_REQUIRED');
      expect(answered.request.claimedBy).toBeNull();
      expect(answered.request.claimTokenHash).toBeNull();

      // Not terminal: the consumer can pick it back up once the human replies,
      // as a new generation with a new token.
      const resumed = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });
      expect(resumed.request.state).toBe('WORKING');
      expect(resumed.claimToken).not.toBe(held.claimToken);
    });

    it('records an explicit failure without pretending the request was answered', async () => {
      const { mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });

      const answered = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'I no longer have the run logs for that decision.',
        claimToken: held.claimToken,
        id: request.id,
        state: 'failed',
      });

      expect(answered.request.state).toBe('FAILED');
    });
  });

  describe('deadlines', () => {
    it('fails an overdue request server-side', async () => {
      const { request } = await openRequest(prisma);
      await prisma.agentRequest.update({
        where: { id: request.id },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });

      await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(1);

      const after = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(after.state).toBe('FAILED');
    });

    it('says only that no answer arrived, never that the agent was not running', async () => {
      const copy = DEADLINE_FAILURE_REASON.toLowerCase();

      expect(copy).toContain('no answer within the deadline');

      // The server knows the deadline passed. It does not know why, and the
      // copy must not pretend otherwise (docs/54 §D3).
      for (const forbidden of [
        /\bnot running\b/,
        /\boffline\b/,
        /\bunavailable\b/,
        /\bdead\b/,
        /\bcrashed\b/,
        /\bunresponsive\b/,
      ]) {
        expect(copy).not.toMatch(forbidden);
      }
    });

    it('leaves a completed request alone when its deadline passes', async () => {
      const { mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });
      await answerAgentRequest(prisma, { actorId: mia.id, body: 'done', claimToken: held.claimToken, id: request.id });

      await prisma.agentRequest.update({
        where: { id: request.id },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });

      await expect(expireOverdueAgentRequests(prisma)).resolves.toBe(0);
      const after = await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(after.state).toBe('COMPLETED');
    });
  });

  describe('inbox', () => {
    it('returns only requests addressed to the reading actor', async () => {
      const { mia } = await openRequest(prisma);
      const bob = await createAgent(prisma, 'Bob', 'bob');

      const inboxMia = await readAgentInbox(prisma, { actorId: mia.id });
      const inboxBob = await readAgentInbox(prisma, { actorId: bob.id });

      expect(inboxMia.items).toHaveLength(1);
      expect(inboxBob.items).toHaveLength(0);
    });

    it('hides terminal requests and pages with a cursor', async () => {
      const { issue, mia } = await openRequest(prisma);
      const human = await humanAuthor(prisma);

      for (let index = 0; index < 3; index += 1) {
        await createComment(prisma, { body: `@mia q${index}`, issueId: issue.id }, human.id);
      }

      const firstPage = await readAgentInbox(prisma, { actorId: mia.id, first: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.cursor).not.toBeNull();

      const secondPage = await readAgentInbox(prisma, {
        actorId: mia.id,
        cursor: firstPage.cursor,
        first: 2,
      });
      expect(secondPage.items).toHaveLength(2);

      const all = [...firstPage.items, ...secondPage.items].map((item) => item.id);
      expect(new Set(all).size).toBe(4);

      await cancelAgentRequest(prisma, { by: { actorId: human.id, actorKind: 'HUMAN' }, id: all[0]! });
      const afterCancel = await readAgentInbox(prisma, { actorId: mia.id, first: 50 });
      expect(afterCancel.items.map((item) => item.id)).not.toContain(all[0]);
    });

    it('reports state in A2A wire spelling', async () => {
      const { mia } = await openRequest(prisma);
      const inbox = await readAgentInbox(prisma, { actorId: mia.id });

      expect(inbox.items[0]?.state).toBe('submitted');
    });
  });
});

async function openRequest(prismaClient: PrismaClient): Promise<{
  issue: Issue;
  mia: User;
  request: { id: string };
}> {
  const mia = await createAgent(prismaClient, 'Mia', 'mia');
  const issue = await createIssue(prismaClient);
  const human = await humanAuthor(prismaClient);

  await createComment(prismaClient, { body: '@mia why?', issueId: issue.id }, human.id);
  const request = await prismaClient.agentRequest.findFirstOrThrow({
    where: { targetActorId: mia.id },
  });

  return { issue, mia, request };
}

async function humanAuthor(prismaClient: PrismaClient): Promise<User> {
  return prismaClient.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
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
      identifier: 'INV-902',
      stateId: state.id,
      teamId: team.id,
      title: 'Request host',
    },
  });
}

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await resetAndSeed(prismaClient);
}
