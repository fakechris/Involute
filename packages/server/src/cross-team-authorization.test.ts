import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  assertCanManageActor,
  assertCanRepresentActor,
  assertCanRevokeCredential,
} from './access-control.ts';
import { issueAgentCredential } from './agent-credentials.ts';
import type { GraphQLContext } from './auth.ts';
import { ACTOR_MANAGE_FORBIDDEN_MESSAGE, TEAM_MANAGE_FORBIDDEN_MESSAGE } from './errors.ts';
import { startServer, type StartedServer } from './index.ts';
import { createComment } from './issue-service.ts';
import { SESSION_COOKIE_NAME, createSession } from './session.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

/**
 * INV-594: the cross-team matrix. One actor, two credentials (A and B), two
 * private requests (one per team), two team OWNERs. Every credential sees and
 * handles only its own team's requests; a team OWNER manages only their
 * team's credential and can neither obtain nor stop the whole actor.
 */
describe('cross-team authorization (INV-594)', () => {
  let server: StartedServer;
  let f: Fixture;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    f = await fixture(prisma);
    server = await startServer({ allowAdminFallback: true, authToken: TEST_AUTH_TOKEN, port: 0, prisma });
  });
  afterEach(async () => { await server.stop(); });

  async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ error?: { message: string }; result?: any }> {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }),
    });
    return response.json() as Promise<{ error?: { message: string }; result?: any }>;
  }

  function unwrap(result: any): any {
    const text = result?.content?.[0]?.text;
    return text ? JSON.parse(text) : result;
  }

  describe('a credential sees and handles only its own team', () => {
    it('inbox: B sees only B\'s request, A only A\'s', async () => {
      const inboxB = unwrap((await mcp(f.tokenB, 'agent_inbox', {})).result);
      expect(inboxB.requests.map((r: { id: string }) => r.id)).toEqual([f.requestB.id]);

      const inboxA = unwrap((await mcp(f.tokenA, 'agent_inbox', {})).result);
      expect(inboxA.requests.map((r: { id: string }) => r.id)).toEqual([f.requestA.id]);
    });

    it('claim: B cannot claim A\'s request; A can', async () => {
      const denied = await mcp(f.tokenB, 'agent_request_claim', { id: f.requestA.id });
      expect(denied.error?.message).toMatch(/access/i);

      const allowed = await mcp(f.tokenA, 'agent_request_claim', { id: f.requestA.id });
      expect(allowed.error).toBeUndefined();
      expect(unwrap(allowed.result).claim_token).toBeTruthy();
    });

    it('answer: B cannot answer A\'s request even with A\'s claim token', async () => {
      const held = unwrap((await mcp(f.tokenA, 'agent_request_claim', { id: f.requestA.id })).result);
      const denied = await mcp(f.tokenB, 'agent_request_answer', { body: 'from B', claim_token: held.claim_token, id: f.requestA.id });
      expect(denied.error?.message).toMatch(/access/i);

      const fresh = await prisma.agentRequest.findUniqueOrThrow({ where: { id: f.requestA.id } });
      expect(fresh.state).toBe('WORKING');
      expect(fresh.answeredCommentId).toBeNull();
    });
  });

  describe('a team OWNER manages their team\'s credential and nothing more', () => {
    it('B\'s OWNER cannot represent the actor: no new credential, no lifecycle', async () => {
      await expect(assertCanRepresentActor(prisma, ctx(f.ownerB), f.shared.id)).rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
      await expect(assertCanManageActor(prisma, ctx(f.ownerB), f.shared.id)).rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('B\'s OWNER cannot mint a B credential for the actor through GraphQL, even with manage rights on B', async () => {
      const cookie = await sessionCookie(prisma, f.ownerB);
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          query: `mutation($i: AgentCredentialCreateInput!) { agentCredentialCreate(input: $i) { success token } }`,
          variables: { i: { email: f.shared.email, name: 'takeover', team: f.teamB.key } },
        }),
      });
      const body = await response.json() as { data?: any; errors?: Array<{ message: string }> };
      expect(body.data?.agentCredentialCreate?.token ?? null).toBeNull();
      expect(JSON.stringify(body)).toContain('manage this actor');
    });

    it('B\'s OWNER may revoke B\'s credential, not A\'s', async () => {
      await expect(assertCanRevokeCredential(prisma, ctx(f.ownerB), f.credB)).resolves.toBeUndefined();
      await expect(assertCanRevokeCredential(prisma, ctx(f.ownerB), f.credA)).rejects.toThrow(TEAM_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('the actor\'s owner and an ADMIN may do all of it', async () => {
      for (const who of [f.ownerA, f.admin]) {
        await expect(assertCanRepresentActor(prisma, ctx(who), f.shared.id)).resolves.toBeUndefined();
        await expect(assertCanManageActor(prisma, ctx(who), f.shared.id)).resolves.toBeUndefined();
        await expect(assertCanRevokeCredential(prisma, ctx(who), f.credA)).resolves.toBeUndefined();
        await expect(assertCanRevokeCredential(prisma, ctx(who), f.credB)).resolves.toBeUndefined();
      }
    });

    it('an unbound legacy credential is revocable only by the owner or an ADMIN', async () => {
      const legacy = { teamId: null, userId: f.shared.id };
      await expect(assertCanRevokeCredential(prisma, ctx(f.ownerB), legacy)).rejects.toThrow(TEAM_MANAGE_FORBIDDEN_MESSAGE);
      await expect(assertCanRevokeCredential(prisma, ctx(f.ownerA), legacy)).resolves.toBeUndefined();
    });
  });
});

function ctx(viewer: User): GraphQLContext {
  return { authMode: 'session', isTrustedSystem: false, prisma, viewer };
}

async function sessionCookie(client: PrismaClient, user: User): Promise<string> {
  const { token } = await createSession(client, user.id);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

interface Fixture {
  admin: User; ownerA: User; ownerB: User; shared: User;
  teamA: Team; teamB: Team;
  credA: { teamId: string | null; userId: string }; credB: { teamId: string | null; userId: string };
  tokenA: string; tokenB: string;
  requestA: { id: string }; requestB: { id: string };
}

async function fixture(client: PrismaClient): Promise<Fixture> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const teamA = await client.team.update({ where: { key: DEFAULT_TEAM_KEY }, data: { visibility: 'PRIVATE' } });
  const teamB = await client.team.create({ data: { key: 'TMB', name: 'Team B', visibility: 'PRIVATE' } });
  const readyB = await client.workflowState.create({ data: { name: 'Ready', position: 0, teamId: teamB.id, type: 'UNSTARTED' } });
  const readyA = await client.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: teamA.id } });

  const ownerA = await client.user.create({ data: { actorKind: 'HUMAN', email: 'owner-a@humans.test.local', name: 'Owner A' } });
  const ownerB = await client.user.create({ data: { actorKind: 'HUMAN', email: 'owner-b@humans.test.local', name: 'Owner B' } });
  await client.teamMembership.create({ data: { role: 'OWNER', teamId: teamA.id, userId: ownerA.id } });
  await client.teamMembership.create({ data: { role: 'OWNER', teamId: teamB.id, userId: ownerB.id } });

  // One actor, owned by A's owner, with a credential on each team.
  const a = await issueAgentCredential(client, { handle: 'shared', name: 'Shared', ownerId: ownerA.id, teamKey: teamA.key });
  const shared = await client.user.findUniqueOrThrow({ where: { id: a.credential.userId } });
  const b = await issueAgentCredential(client, { email: shared.email, name: 'Shared', teamKey: teamB.key });

  const workA = await client.issue.create({ data: { identifier: 'INV-960', stateId: readyA.id, teamId: teamA.id, title: 'Private A' } });
  const workB = await client.issue.create({ data: { identifier: 'TMB-1', stateId: readyB.id, teamId: teamB.id, title: 'Private B' } });
  await createComment(client, { body: '@shared question on A', issueId: workA.id }, ownerA.id);
  await createComment(client, { body: '@shared question on B', issueId: workB.id }, ownerB.id);
  const requestA = await client.agentRequest.findFirstOrThrow({ where: { workId: workA.id } });
  const requestB = await client.agentRequest.findFirstOrThrow({ where: { workId: workB.id } });

  return {
    admin, ownerA, ownerB, shared, teamA, teamB,
    credA: { teamId: a.credential.teamId, userId: shared.id },
    credB: { teamId: b.credential.teamId, userId: shared.id },
    tokenA: a.token, tokenB: b.token,
    requestA, requestB,
  };
}
