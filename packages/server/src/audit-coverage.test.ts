import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { getAgentProfile } from './agent-directory.ts';
import { expireOverdueAgentRequests } from './agent-request-expiry.ts';
import { answerAgentRequest, cancelAgentRequest, claimAgentRequest } from './agent-request-service.ts';
import { applyMonotonicForward, applyProvenanceRollback } from './github-webhook-state-machine.ts';
import { createComment } from './issue-service.ts';
import { proposeWork } from './claim-service.ts';
import { GITHUB_WEBHOOK_ACTOR, EXPIRY_SWEEPER_ACTOR } from './service-actors.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const DESCRIPTION = [
  '### 1. 目标与架构定位', '审计覆盖测试夹具。',
  '### 2. 核心功能与交付范围', '仅测试。',
  '### 3. 验收标准与验证方案', 'vitest 通过。',
].join('\n');

/**
 * INV-587. Before this, two whole classes of write left no WorkAudit: every
 * GitHub-driven state transition, and every request event (claim, answer,
 * expiry). A receipt cannot attach to an event that was never recorded, and a
 * work item could move Backlog → Done with no row saying what did it.
 */
describe('audit coverage (INV-587)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  describe('GitHub state machine', () => {
    it('a webhook state transition writes a WorkAudit naming @github-webhook', async () => {
      const { issue, team } = await seededIssue(prisma, 'Ready');

      const result = await prisma.$transaction((tx) => applyMonotonicForward(tx, {
        eventSourceKey: 'create:feat/inv-1',
        eventType: 'create.branch',
        issueId: issue.id,
        targetStateType: 'STARTED',
        teamId: team.id,
      }));
      expect(result.applied).toBe(true);

      const audits = await prisma.workAudit.findMany({
        where: { workId: issue.id },
        include: { actor: true },
        orderBy: { createdAt: 'asc' },
      });
      const transition = audits.find((a) => a.surface === GITHUB_WEBHOOK_ACTOR.surface);

      expect(transition).toBeDefined();
      expect(transition!.actorKind).toBe('SERVICE');
      expect(transition!.actor?.handle).toBe('github-webhook');
      expect(transition!.sourceMessageId).toBe('create:feat/inv-1');
      expect(transition!.reason).toBe('create.branch');
      expect((transition!.before as { stateId?: string } | null)?.stateId).toBe(issue.stateId);
      expect((transition!.after as { stateId?: string }).stateId).not.toBe(issue.stateId);
    });

    it('commits the audit with the move: a duplicate event produces no second audit', async () => {
      const { issue, team } = await seededIssue(prisma, 'Ready');
      const input = {
        eventSourceKey: 'create:feat/inv-1',
        eventType: 'create.branch',
        issueId: issue.id,
        targetStateType: 'STARTED' as const,
        teamId: team.id,
      };

      await prisma.$transaction((tx) => applyMonotonicForward(tx, input));
      const second = await prisma.$transaction((tx) => applyMonotonicForward(tx, input));
      expect(second.duplicate).toBe(true);

      await expect(prisma.workAudit.count({
        where: { surface: GITHUB_WEBHOOK_ACTOR.surface, workId: issue.id },
      })).resolves.toBe(1);
    });

    it('a rejected transition (nothing moved) writes no audit', async () => {
      const { issue, team } = await seededIssue(prisma, 'Done');

      const result = await prisma.$transaction((tx) => applyMonotonicForward(tx, {
        eventSourceKey: 'pr:1:opened',
        eventType: 'pull_request.opened',
        issueId: issue.id,
        targetStateType: 'REVIEW',
        teamId: team.id,
      }));
      expect(result.applied).toBe(false);

      await expect(prisma.workAudit.count({
        where: { surface: GITHUB_WEBHOOK_ACTOR.surface, workId: issue.id },
      })).resolves.toBe(0);
    });

    it('a provenance rollback is audited too', async () => {
      const { issue, team } = await seededIssue(prisma, 'In Review');
      await prisma.issue.update({ where: { id: issue.id }, data: { stateSourcePrId: 'pr-7' } });

      const result = await prisma.$transaction((tx) => applyProvenanceRollback(tx, {
        eventSourceKey: 'pr:7:closed',
        eventType: 'pull_request.closed',
        issueId: issue.id,
        prId: 'pr-7',
        teamId: team.id,
      }));
      expect(result.applied).toBe(true);

      const audit = await prisma.workAudit.findFirstOrThrow({
        where: { surface: GITHUB_WEBHOOK_ACTOR.surface, workId: issue.id },
        include: { actor: true },
      });
      expect(audit.actor?.handle).toBe('github-webhook');
      expect(audit.reason).toBe('pull_request.closed');
    });
  });

  describe('request events', () => {
    it('claim, answer: each writes a WorkAudit naming the agent, carrying the claim generation', async () => {
      const { mia, request } = await openRequest(prisma);

      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id, sessionId: 'sess-A' });
      await answerAgentRequest(prisma, {
        actorId: mia.id, body: 'Because.', claimToken: held.claimToken, id: request.id, sessionId: 'sess-A',
      });

      const audits = await prisma.workAudit.findMany({
        where: { sourceMessageId: request.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(audits.map((a) => a.surface)).toEqual(['agent_request.claimed', 'agent_request.answered']);
      for (const audit of audits) {
        expect(audit.actorId).toBe(mia.id);
        expect(audit.actorKind).toBe('AGENT');
        expect(audit.claimGeneration).toBe(held.request.claimGeneration);
        expect(audit.sessionId).toBe('sess-A');
      }
    });

    it('a renewal is audited as the same generation; a re-take after lapse as the next', async () => {
      const { mia, request } = await openRequest(prisma);
      const t0 = new Date();

      const a = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, t0);
      await claimAgentRequest(prisma, { actorId: mia.id, claimToken: a.claimToken, id: request.id }, new Date(t0.getTime() + 1000));
      // The renewal at +1s moved the lease to +61s; a re-take must be strictly after it.
      const b = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id }, new Date(t0.getTime() + 62_000));

      const audits = await prisma.workAudit.findMany({
        where: { sourceMessageId: request.id }, orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((x) => [x.surface, x.claimGeneration])).toEqual([
        ['agent_request.claimed', a.request.claimGeneration],
        ['agent_request.renewed', a.request.claimGeneration],
        ['agent_request.claimed', b.request.claimGeneration],
      ]);
      expect(b.request.claimGeneration).toBe(a.request.claimGeneration + 1);
    });

    it('expiry writes a WorkAudit naming @expiry-sweeper, and the notice is authored by the same actor', async () => {
      const { request, rootCommentId } = await openRequest(prisma);
      await prisma.agentRequest.update({ where: { id: request.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });

      await expireOverdueAgentRequests(prisma);

      const audit = await prisma.workAudit.findFirstOrThrow({
        where: { sourceMessageId: request.id, surface: 'agent_request.expired' },
        include: { actor: true },
      });
      expect(audit.actorKind).toBe('SERVICE');
      expect(audit.actor?.handle).toBe(EXPIRY_SWEEPER_ACTOR.handle);

      const notice = await prisma.comment.findFirstOrThrow({ where: { parentCommentId: rootCommentId } });
      expect(notice.userId).toBe(audit.actorId);
    });

    it('cancel is attributed to whoever canceled', async () => {
      const { request } = await openRequest(prisma);
      const human = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

      await cancelAgentRequest(prisma, { by: { actorId: human.id, actorKind: 'HUMAN' }, id: request.id });

      const audit = await prisma.workAudit.findFirstOrThrow({
        where: { sourceMessageId: request.id, surface: 'agent_request.canceled' },
      });
      expect(audit.actorId).toBe(human.id);
    });

    it('request-event audits do not count as proposing the work', async () => {
      const { mia, request } = await openRequest(prisma);
      const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });
      await answerAgentRequest(prisma, { actorId: mia.id, body: 'ok', claimToken: held.claimToken, id: request.id });

      const profile = await getAgentProfile(prisma, 'mia');

      expect(profile!.counts.proposedWork).toBe(0);
      expect(profile!.counts.answeredRequests).toBe(1);
    });

    it('a real proposal still counts as one', async () => {
      const admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
      const mia = await prisma.user.create({
        data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: admin.id },
      });
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      await proposeWork(prisma, { description: DESCRIPTION, teamId: team.id, title: 'Mine' },
        { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });

      const profile = await getAgentProfile(prisma, 'mia');
      expect(profile!.counts.proposedWork).toBe(1);
    });
  });
});

async function seededIssue(client: PrismaClient, stateName: string): Promise<{ issue: Issue; team: { id: string } }> {
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await client.workflowState.findFirstOrThrow({ where: { name: stateName, teamId: team.id } });
  const issue = await client.issue.create({
    data: { identifier: 'INV-920', stateId: state.id, teamId: team.id, title: 'Audit host' },
  });
  return { issue, team };
}

async function openRequest(client: PrismaClient): Promise<{ mia: User; request: { id: string; workId: string }; rootCommentId: string }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
  const mia = await client.user.create({
    data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: admin.id },
  });
  const { issue } = await seededIssue(client, 'Ready');
  const comment = await createComment(client, { body: '@mia why?', issueId: issue.id }, admin.id);
  const request = await client.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
  return { mia, request, rootCommentId: comment.id };
}
