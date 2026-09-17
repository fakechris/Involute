import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  assertCanManageTeam,
  assertCanReadTeam,
  assertCanWriteTeam,
  buildReadableTeamWhere,
  buildVisibleUsersWhere,
} from './access-control.ts';
import { listAgentActors } from './agent-directory.ts';
import { issueAgentCredential, resolveAgentPrincipal } from './agent-credentials.ts';
import { expireOverdueAgentRequests } from './agent-request-expiry.ts';
import type { GraphQLContext } from './auth.ts';
import { TEAM_MANAGE_FORBIDDEN_MESSAGE, TEAM_NOT_FOUND_MESSAGE, TEAM_WRITE_FORBIDDEN_MESSAGE } from './errors.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * INV-592. An agent's access is its credential's binding — the team it was
 * issued for, and its scopes — not a TeamMembership. Until now every agent
 * was upserted onto the human roster as an EDITOR so that the
 * membership-based write check would let it through; the roster then showed
 * "Enzo · EDITOR · USER" next to real people.
 */
describe('agent access comes from the credential binding (INV-592)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('issuing a credential no longer puts the agent on the team roster', async () => {
    const { mia, team } = await boundAgent(prisma);
    await expect(prisma.teamMembership.count({ where: { userId: mia.id } })).resolves.toBe(0);
    const credential = await prisma.agentCredential.findFirstOrThrow({ where: { userId: mia.id } });
    expect(credential.teamId).toBe(team.id);
  });

  it('the principal carries the binding, and the request context is built from it', async () => {
    const { token, team } = await boundAgent(prisma);
    const principal = await resolveAgentPrincipal(prisma, token);
    expect(principal?.teamId).toBe(team.id);
  });

  describe('with no membership at all', () => {
    it('can read and write its bound team', async () => {
      const { context, team } = await boundAgent(prisma);
      await expect(assertCanReadTeam(prisma, context, team.id)).resolves.toBeUndefined();
      await expect(assertCanWriteTeam(prisma, context, team.id)).resolves.toBeUndefined();
    });

    it('cannot write another team, even one it can read because it is public', async () => {
      const { context } = await boundAgent(prisma);
      const other = await prisma.team.create({ data: { key: 'PUB', name: 'Public', visibility: 'PUBLIC' } });

      await expect(assertCanReadTeam(prisma, context, other.id)).resolves.toBeUndefined();
      await expect(assertCanWriteTeam(prisma, context, other.id)).rejects.toThrow(TEAM_WRITE_FORBIDDEN_MESSAGE);
    });

    it('cannot see a private team it is not bound to', async () => {
      const { context } = await boundAgent(prisma);
      const secret = await prisma.team.create({ data: { key: 'SEC', name: 'Secret', visibility: 'PRIVATE' } });

      await expect(assertCanReadTeam(prisma, context, secret.id)).rejects.toThrow(TEAM_NOT_FOUND_MESSAGE);
      const visible = await prisma.team.findMany({ where: buildReadableTeamWhere(context) });
      expect(visible.map((t) => t.key)).not.toContain('SEC');
    });

    it('can never manage a team', async () => {
      const { context, team } = await boundAgent(prisma);
      await expect(assertCanManageTeam(prisma, context, team.id)).rejects.toThrow(TEAM_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('a membership row, if one still existed, would grant an agent nothing extra', async () => {
      const { context, mia } = await boundAgent(prisma);
      const other = await prisma.team.create({ data: { key: 'OTH', name: 'Other', visibility: 'PRIVATE' } });
      await prisma.teamMembership.create({ data: { role: 'OWNER', teamId: other.id, userId: mia.id } });

      await expect(assertCanWriteTeam(prisma, context, other.id)).rejects.toThrow(TEAM_WRITE_FORBIDDEN_MESSAGE);
      await expect(assertCanManageTeam(prisma, context, other.id)).rejects.toThrow(TEAM_MANAGE_FORBIDDEN_MESSAGE);
    });
  });

  describe('the binding is what makes an agent part of a team elsewhere', () => {
    it('the team directory lists agents by binding', async () => {
      const { mia } = await boundAgent(prisma);
      const listed = await listAgentActors(prisma, { teamKey: DEFAULT_TEAM_KEY });
      expect(listed.map((a) => a.id)).toContain(mia.id);
    });

    it('humans on the team can see its bound agents (mention suggestions, assignees)', async () => {
      const { admin, mia, team } = await boundAgent(prisma);
      const member = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'm@humans.test.local', name: 'M' } });
      await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: member.id } });
      const context: GraphQLContext = { authMode: 'session', isTrustedSystem: false, prisma, viewer: member };

      const visible = await prisma.user.findMany({ where: buildVisibleUsersWhere(context) });
      expect(visible.map((u) => u.id)).toEqual(expect.arrayContaining([member.id, mia.id, admin.id]));
    });

    it('a successor bound by credential, with no membership, receives a hand-off', async () => {
      const { admin, mia, team } = await boundAgent(prisma);
      const { credential } = await issueAgentCredential(prisma, {
        handle: 'kai', name: 'Kai', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
      });
      await prisma.user.update({ where: { id: mia.id }, data: { successorActorId: credential.userId } });

      const state = await prisma.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
      const issue = await prisma.issue.create({ data: { identifier: 'INV-950', stateId: state.id, teamId: team.id, title: 'Bound' } });
      await createComment(prisma, { body: '@mia why?', issueId: issue.id }, admin.id);
      const request = await prisma.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
      await prisma.agentRequest.update({ where: { id: request.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });

      await expireOverdueAgentRequests(prisma);

      const next = await prisma.agentRequest.findFirstOrThrow({ where: { handedOffFromId: request.id } });
      expect(next.targetActorId).toBe(credential.userId);
    });
  });
});

async function boundAgent(client: PrismaClient): Promise<{
  admin: User; context: GraphQLContext; mia: User; team: { id: string }; token: string;
}> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const { credential, token } = await issueAgentCredential(client, {
    handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY,
  });
  const mia = await client.user.findUniqueOrThrow({ where: { id: credential.userId } });
  const principal = await resolveAgentPrincipal(client, token);
  const context: GraphQLContext = {
    agentScopes: principal!.scopes,
    agentTeamId: principal!.teamId,
    authMode: 'agent-token',
    isTrustedSystem: false,
    prisma: client,
    viewer: mia,
  };
  return { admin, context, mia, team, token };
}
