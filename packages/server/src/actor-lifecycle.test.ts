import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { deactivateActor, transferActorOwner } from './actor-lifecycle.ts';
import { issueAgentCredential, resolveAgentPrincipal } from './agent-credentials.ts';
import { listAgentActors } from './agent-directory.ts';
import { createComment } from './issue-service.ts';
import { proposeWork } from './claim-service.ts';
import { provisionServiceActor } from './service-actors.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const DESCRIPTION = [
  '### 1. 目标与架构定位',
  '生命周期测试夹具。',
  '### 2. 核心功能与交付范围',
  '仅测试。',
  '### 3. 验收标准与验证方案',
  'vitest 通过。',
].join('\n');

describe('actor lifecycle (INV-586)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    // Leave no ActorAudit rows behind: they reference users with Restrict, and
    // test files that run after this one clear users with their own chains.
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
  });

  describe('ownership', () => {
    it('refuses to create an agent with no human owner', async () => {
      await expect(issueAgentCredential(prisma, {
        handle: 'orphan',
        name: 'Orphan',
        teamKey: DEFAULT_TEAM_KEY,
      })).rejects.toThrow(/human owner/i);
    });

    it('refuses an owner that is not an active human', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });

      await expect(issueAgentCredential(prisma, {
        handle: 'kai', name: 'Kai', ownerId: credential.userId, teamKey: DEFAULT_TEAM_KEY,
      })).rejects.toThrow(/active HUMAN/);
    });

    it('records an owner transfer, made by a human, in ActorAudit', async () => {
      const admin = await humanAdmin(prisma);
      const dana = await prisma.user.create({
        data: { actorKind: 'HUMAN', email: 'dana@test.local', name: 'Dana' },
      });
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });

      const updated = await transferActorOwner(prisma, {
        actorId: credential.userId,
        by: { actorId: admin.id, actorKind: 'HUMAN' },
        newOwnerId: dana.id,
        reason: 'Dana runs this box now.',
      });

      expect(updated.ownerId).toBe(dana.id);
      const audit = await prisma.actorAudit.findFirstOrThrow({ where: { subjectId: credential.userId } });
      expect(audit.action).toBe('owner-transferred');
      expect(audit.byActorId).toBe(admin.id);
      expect(audit.before).toEqual({ ownerId: admin.id });
      expect(audit.after).toEqual({ ownerId: dana.id });
    });

    it('does not let an agent transfer ownership', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });

      await expect(transferActorOwner(prisma, {
        actorId: credential.userId,
        by: { actorId: credential.userId, actorKind: 'AGENT' },
        newOwnerId: admin.id,
      })).rejects.toThrow(/Only a human/);
    });

    it('owning an actor grants no permission: the owner is not the assignee, requester or authorizer', async () => {
      // Structural check on the four fields staying separate.
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const work = await proposeWork(
        prisma,
        { description: DESCRIPTION, teamId: team.id, title: 'Owned but not assigned' },
        { actorId: credential.userId, actorKind: 'AGENT', surface: 'test' },
      );

      const actor = await prisma.user.findUniqueOrThrow({ where: { id: credential.userId } });
      expect(actor.ownerId).toBe(admin.id);
      expect(work.assigneeId).toBeNull();
    });
  });

  describe('deactivation instead of deletion', () => {
    it('refuses to delete an actor that has written history', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      await proposeWork(
        prisma,
        { description: DESCRIPTION, teamId: team.id, title: 'History' },
        { actorId: credential.userId, actorKind: 'AGENT', surface: 'test' },
      );

      // The database itself refuses (WorkAudit.actor is Restrict). This is
      // the orphan problem, closed at the lowest layer.
      await expect(prisma.user.delete({ where: { id: credential.userId } })).rejects.toThrow();
      await expect(prisma.workAudit.count({ where: { actorId: credential.userId } })).resolves.toBe(1);
    });

    it('deactivation keeps the id and history, revokes credentials, and ends the ability to act', async () => {
      const admin = await humanAdmin(prisma);
      const { credential, token } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const work = await proposeWork(
        prisma,
        { description: DESCRIPTION, teamId: team.id, title: 'Before deactivation' },
        { actorId: credential.userId, actorKind: 'AGENT', surface: 'test' },
      );

      await expect(resolveAgentPrincipal(prisma, token)).resolves.not.toBeNull();

      const deactivated = await deactivateActor(prisma, {
        actorId: credential.userId,
        by: { actorId: admin.id, actorKind: 'HUMAN' },
        reason: 'Retired.',
      });

      expect(deactivated.id).toBe(credential.userId);
      expect(deactivated.handle).toBe('mia');
      expect(deactivated.deactivatedAt).not.toBeNull();

      // History still points at the same, real row.
      const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: work.id, revision: 1 } });
      expect(audit.actorId).toBe(credential.userId);

      // It can no longer act.
      await expect(resolveAgentPrincipal(prisma, token)).resolves.toBeNull();
      const cred = await prisma.agentCredential.findUniqueOrThrow({ where: { id: credential.id } });
      expect(cred.revokedAt).not.toBeNull();

      // And it is recorded who did it.
      const lifecycle = await prisma.actorAudit.findFirstOrThrow({
        where: { action: 'deactivated', subjectId: credential.userId },
      });
      expect(lifecycle.byActorId).toBe(admin.id);
    });

    it('a deactivated actor is not mentionable and does not receive requests', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      await deactivateActor(prisma, { actorId: credential.userId, by: { actorId: admin.id, actorKind: 'HUMAN' } });

      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const state = await prisma.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
      const issue = await prisma.issue.create({
        data: { identifier: 'INV-910', stateId: state.id, teamId: team.id, title: 'Host' },
      });
      const comment = await createComment(prisma, { body: '@mia are you there?', issueId: issue.id }, admin.id);

      await expect(prisma.commentMention.count({ where: { commentId: comment.id } })).resolves.toBe(0);
      await expect(prisma.agentRequest.count({ where: { targetActorId: credential.userId } })).resolves.toBe(0);
    });

    it('refuses to issue a credential to a deactivated actor', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      await deactivateActor(prisma, { actorId: credential.userId, by: { actorId: admin.id, actorKind: 'HUMAN' } });

      await expect(issueAgentCredential(prisma, {
        email: 'mia@agents.test.local', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      })).rejects.toThrow(/deactivated/);
    });

    it('hides deactivated actors from the directory unless asked', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      await deactivateActor(prisma, { actorId: credential.userId, by: { actorId: admin.id, actorKind: 'HUMAN' } });

      const current = await listAgentActors(prisma, {});
      const all = await listAgentActors(prisma, { includeDeactivated: true });

      expect(current.map((a) => a.handle)).not.toContain('mia');
      expect(all.map((a) => a.handle)).toContain('mia');
    });
  });

  describe('SERVICE provisioning', () => {
    it('provisions a SERVICE actor with an owner, listed in the directory', async () => {
      const admin = await humanAdmin(prisma);

      const created = await provisionServiceActor(prisma, {
        byActorId: admin.id,
        description: 'Nightly reconciliation job.',
        handle: 'nightly-sync',
        name: 'Nightly Sync',
        ownerId: admin.id,
      });

      const actor = await prisma.user.findUniqueOrThrow({ where: { id: created.actorId } });
      expect(actor.actorKind).toBe('SERVICE');
      expect(actor.ownerId).toBe(admin.id);

      const directory = await listAgentActors(prisma, {});
      expect(directory.map((a) => a.handle)).toContain('nightly-sync');
    });

    it('refuses a SERVICE actor without an active human owner', async () => {
      const admin = await humanAdmin(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });

      await expect(provisionServiceActor(prisma, {
        byActorId: admin.id, handle: 'rogue', name: 'Rogue', ownerId: credential.userId,
      })).rejects.toThrow(/active HUMAN/);
    });
  });
});

async function humanAdmin(client: PrismaClient): Promise<User> {
  return client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
}
