import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { answerAgentRequest, claimAgentRequest } from './agent-request-service.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('comment threads (INV-561 / A5)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('A5 — two parallel threads on one work item do not cross', () => {
    it('keeps two questions, their requests and their answers on separate threads', async () => {
      const mia = await createAgent(prisma, 'Mia', 'mia');
      const issue = await createIssue(prisma);
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');
      const evan = await createHuman(prisma, 'Evan', 'evan@test.local');

      // Two humans ask two different questions of the same agent, on the same
      // work item, at the same time.
      const danaQuestion = await createComment(
        prisma,
        { body: '@mia why did you pick the code-block rule?', issueId: issue.id },
        dana.id,
      );
      const evanQuestion = await createComment(
        prisma,
        { body: '@mia why is the handle capped at 32 chars?', issueId: issue.id },
        evan.id,
      );

      const requests = await prisma.agentRequest.findMany({ orderBy: { createdAt: 'asc' } });
      expect(requests).toHaveLength(2);

      const danaRequest = requests.find((request) => request.rootCommentId === danaQuestion.id);
      const evanRequest = requests.find((request) => request.rootCommentId === evanQuestion.id);

      // Each request is anchored to its own thread, not to the work item.
      expect(danaRequest).toBeDefined();
      expect(evanRequest).toBeDefined();
      expect(danaRequest?.id).not.toBe(evanRequest?.id);
      expect(danaRequest?.requestedByActorId).toBe(dana.id);
      expect(evanRequest?.requestedByActorId).toBe(evan.id);

      // Answer each one. Answering the second must not touch the first.
      await claimAgentRequest(prisma, { actorId: mia.id, id: danaRequest!.id });
      const danaAnswer = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'Because a pasted snippet is not a request.',
        id: danaRequest!.id,
      });

      await claimAgentRequest(prisma, { actorId: mia.id, id: evanRequest!.id });
      const evanAnswer = await answerAgentRequest(prisma, {
        actorId: mia.id,
        body: 'So an over-long run cannot truncate onto a real handle.',
        id: evanRequest!.id,
      });

      const danaThread = await prisma.comment.findMany({
        where: { parentCommentId: danaQuestion.id },
      });
      const evanThread = await prisma.comment.findMany({
        where: { parentCommentId: evanQuestion.id },
      });

      expect(danaThread.map((comment) => comment.id)).toEqual([danaAnswer.commentId]);
      expect(evanThread.map((comment) => comment.id)).toEqual([evanAnswer.commentId]);
      expect(danaThread[0]?.body).toContain('pasted snippet');
      expect(evanThread[0]?.body).toContain('truncate');
    });

    it('lists the two threads as two roots', async () => {
      await createAgent(prisma, 'Mia', 'mia');
      const issue = await createIssue(prisma);
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');

      const first = await createComment(prisma, { body: '@mia q1', issueId: issue.id }, dana.id);
      const second = await createComment(prisma, { body: '@mia q2', issueId: issue.id }, dana.id);
      await createComment(
        prisma,
        { body: 'following up on q1', issueId: issue.id, parentCommentId: first.id },
        dana.id,
      );

      const roots = await prisma.comment.findMany({
        where: { issueId: issue.id, parentCommentId: null },
        orderBy: { createdAt: 'asc' },
      });

      expect(roots.map((comment) => comment.id)).toEqual([first.id, second.id]);
      await expect(prisma.comment.count({ where: { issueId: issue.id } })).resolves.toBe(3);
    });
  });

  describe('thread shape', () => {
    it('flattens a reply to a reply onto the same root', async () => {
      const issue = await createIssue(prisma);
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');

      const root = await createComment(prisma, { body: 'question', issueId: issue.id }, dana.id);
      const reply = await createComment(
        prisma,
        { body: 'answer', issueId: issue.id, parentCommentId: root.id },
        dana.id,
      );
      const replyToReply = await createComment(
        prisma,
        { body: 'follow-up', issueId: issue.id, parentCommentId: reply.id },
        dana.id,
      );

      // Depth stays at one, so every comment has exactly one unambiguous root.
      expect(reply.parentCommentId).toBe(root.id);
      expect(replyToReply.parentCommentId).toBe(root.id);
    });

    it('refuses a parent that belongs to a different work item', async () => {
      const issue = await createIssue(prisma);
      const other = await createIssue(prisma, 'INV-904');
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');

      const foreign = await createComment(prisma, { body: 'elsewhere', issueId: other.id }, dana.id);

      await expect(createComment(
        prisma,
        { body: 'crossing over', issueId: issue.id, parentCommentId: foreign.id },
        dana.id,
      )).rejects.toThrow('different work item');
    });

    it('refuses a parent that does not exist', async () => {
      const issue = await createIssue(prisma);
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');

      await expect(createComment(
        prisma,
        {
          body: 'orphan',
          issueId: issue.id,
          parentCommentId: '00000000-0000-0000-0000-000000000000',
        },
        dana.id,
      )).rejects.toThrow('Comment not found');
    });

    it('cascades: deleting the root removes its replies', async () => {
      const issue = await createIssue(prisma);
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');

      const root = await createComment(prisma, { body: 'question', issueId: issue.id }, dana.id);
      await createComment(
        prisma,
        { body: 'reply', issueId: issue.id, parentCommentId: root.id },
        dana.id,
      );

      await prisma.comment.delete({ where: { id: root.id } });

      await expect(prisma.comment.count({ where: { issueId: issue.id } })).resolves.toBe(0);
    });
  });

  describe('events carry the real thread root', () => {
    it('reports the parent as rootCommentId for a reply', async () => {
      await createAgent(prisma, 'Mia', 'mia');
      const issue = await createIssue(prisma);
      const dana = await createHuman(prisma, 'Dana', 'dana@test.local');

      const root = await createComment(prisma, { body: 'opening', issueId: issue.id }, dana.id);
      const reply = await createComment(
        prisma,
        { body: '@mia thoughts?', issueId: issue.id, parentCommentId: root.id },
        dana.id,
      );

      const events = await prisma.eventOutbox.findMany({
        where: { type: 'agent.mentioned' },
      });
      const payload = events[0]?.payload as unknown as {
        data: { comment: { id: string; rootCommentId: string }; requestId: string | null };
      };

      expect(payload.data.comment.id).toBe(reply.id);
      expect(payload.data.comment.rootCommentId).toBe(root.id);
      expect(payload.data.requestId).not.toBeNull();

      // And the ledger row anchors to the same root.
      const request = await prisma.agentRequest.findFirstOrThrow();
      expect(request.rootCommentId).toBe(root.id);
    });
  });
});

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

async function createIssue(
  prismaClient: PrismaClient,
  identifier = 'INV-903',
): Promise<Issue> {
  const team = await prismaClient.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await prismaClient.workflowState.findFirstOrThrow({
    where: { name: 'Ready', teamId: team.id },
  });

  return prismaClient.issue.create({
    data: {
      identifier,
      stateId: state.id,
      teamId: team.id,
      title: 'Thread host',
    },
  });
}

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await resetAndSeed(prismaClient);
}
