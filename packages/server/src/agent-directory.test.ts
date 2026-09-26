import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  ACTOR_PRESENCE_COPY,
  ACTIVE_WITHIN_MS,
  IDLE_WITHIN_MS,
  actorPresence,
} from './actor-presence.ts';
import {
  findWorkProvenance,
  getAgentProfile,
  listAgentActors,
} from './agent-directory.ts';
import { issueAgentCredential, resolveAgentPrincipal } from './agent-credentials.ts';
import { answerAgentRequest, claimAgentRequest } from './agent-request-service.ts';
import { createComment } from './issue-service.ts';
import { proposeWork } from './claim-service.ts';
import { startServer, type StartedServer } from './index.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

// Agent proposals must carry the structured description the repo requires
// (AGENTS.md §5.2, enforced in claim-service).
const AGENT_DESCRIPTION = [
  '### 1. 目标与架构定位',
  '验证 proposedByActor 能指回提案的 agent。',
  '### 2. 核心功能与交付范围',
  '仅测试夹具，不交付产品代码。',
  '### 3. 验收标准与验证方案',
  'vitest src/agent-directory.test.ts 通过，exit 0。',
].join('\n');

describe('agent profile is bounded by what the viewer may read (INV-597 follow-up)', () => {
  // Start from a known database rather than whatever the previous test file
  // left behind; this case needs the seeded admin to exist.
  beforeEach(async () => {
    await resetAndSeed(prisma);
  });

  it('a viewer outside a private team sees none of the agent\'s work, receipts or credentials there', async () => {
    const { buildReadableIssueWhere, buildReadableTeamWhere } = await import('./access-control.ts');
    const { proposeWork } = await import('./claim-service.ts');
    const admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
    const team = await prisma.team.update({ where: { key: DEFAULT_TEAM_KEY }, data: { visibility: 'PRIVATE' } });
    const { credential } = await issueAgentCredential(prisma, { handle: 'mia', name: 'Mia', ownerId: admin.id, teamKey: DEFAULT_TEAM_KEY });
    await proposeWork(prisma, { parentId: await testParentId(prisma, team.id), description: ['### 1. 目标与架构定位', 'x', '### 2. 核心功能与交付范围', 'x', '### 3. 验收标准与验证方案', 'x'].join('\n'),
      receipt: { reasoning: 'private reasoning' }, teamId: team.id, title: 'Private work',
    }, { actorId: credential.userId, actorKind: 'AGENT', surface: 'test' });

    const outsider = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'outsider@humans.test.local', name: 'Outsider' } });
    const context = { authMode: 'session' as const, isTrustedSystem: false, prisma, viewer: outsider };
    const scope = { readableTeam: buildReadableTeamWhere(context), readableWork: buildReadableIssueWhere(context) };

    const bounded = (await getAgentProfile(prisma, 'mia', scope))!;
    expect(bounded.receipts).toHaveLength(0);
    // Lifecycle rows (created / credential-issued) are about the actor, not
    // the team's work, so they stay; nothing work-bound leaks.
    expect(bounded.timeline.filter((entry) => entry.workIdentifier !== null)).toHaveLength(0);
    expect(bounded.timeline.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['created', 'credential-issued']));
    expect(bounded.credentials).toHaveLength(0);
    expect(bounded.counts.proposedWork).toBe(0);

    const unrestricted = (await getAgentProfile(prisma, 'mia'))!;
    expect(unrestricted.receipts).toHaveLength(1);
    expect(unrestricted.counts.proposedWork).toBe(1);
  });
});

describe('agent directory and profile (INV-573)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
  });

  describe('actor presence', () => {
    const now = new Date('2026-09-16T00:00:00Z');

    it('says never-seen rather than guessing, when the actor has never connected', () => {
      expect(actorPresence(null, now)).toBe('never-seen');
    });

    it('reports active, idle and away from lastSeenAt', () => {
      expect(actorPresence(now, now)).toBe('active');
      expect(actorPresence(new Date(now.getTime() - ACTIVE_WITHIN_MS - 1), now)).toBe('idle');
      expect(actorPresence(new Date(now.getTime() - IDLE_WITHIN_MS - 1), now)).toBe('away');
    });

    it('describes what was observed, never why', () => {
      for (const copy of Object.values(ACTOR_PRESENCE_COPY)) {
        for (const forbidden of [/\boffline\b/, /\bdown\b/, /\bcrashed\b/, /\bnot running\b/]) {
          expect(copy.toLowerCase()).not.toMatch(forbidden);
        }
      }
      expect(ACTOR_PRESENCE_COPY.away).toContain('credential');
    });
  });

  describe('lastSeenAt', () => {
    it('records that an agent is around when it authenticates', async () => {
      const { token, credential } = await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma),
        name: 'Mia',
        handle: 'mia',
        teamKey: DEFAULT_TEAM_KEY,
      });

      const before = await prisma.user.findUniqueOrThrow({ where: { id: credential.userId } });
      expect(before.lastSeenAt).toBeNull();

      await resolveAgentPrincipal(prisma, token);

      await expect.poll(async () => {
        const after = await prisma.user.findUnique({ where: { id: credential.userId } });
        return after?.lastSeenAt !== null;
      }).toBe(true);
    });
  });

  describe('directory', () => {
    it('lists agent actors and leaves humans out', async () => {
      await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma), name: 'Mia', handle: 'mia', teamKey: DEFAULT_TEAM_KEY });
      await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma), name: 'Kai', handle: 'kai', teamKey: DEFAULT_TEAM_KEY });

      const agents = await listAgentActors(prisma, { teamKey: DEFAULT_TEAM_KEY });

      expect(agents.map((agent) => agent.handle).sort()).toEqual(['kai', 'mia']);
      expect(agents.every((agent) => agent.actorKind === 'AGENT')).toBe(true);
    });

    it('carries the self-declared runtime, so a reader can tell what it is', async () => {
      const { credential } = await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma),
        description: 'Answers questions about decisions it made.',
        handle: 'mia',
        name: 'Mia',
        runtime: 'lumenbox',
        teamKey: DEFAULT_TEAM_KEY,
      });

      const actor = await prisma.user.findUniqueOrThrow({ where: { id: credential.userId } });

      expect(actor.runtime).toBe('lumenbox');
      expect(actor.description).toBe('Answers questions about decisions it made.');
    });
  });

  describe('profile', () => {
    it('reports what the agent has actually done, from edges that already existed', async () => {
      const { mia, issue } = await withAgentActivity(prisma);

      const profile = await getAgentProfile(prisma, 'mia');

      expect(profile).not.toBeNull();
      expect(profile!.actor.id).toBe(mia.id);
      expect(profile!.counts.answeredRequests).toBe(1);
      expect(profile!.counts.openRequests).toBe(0);
      expect(profile!.timeline.length).toBeGreaterThan(0);
      expect(profile!.timeline.some((entry) => entry.workIdentifier === issue.identifier)).toBe(true);
      expect(profile!.timeline.some((entry) => entry.kind === 'answered')).toBe(true);
    });

    it('reports the credentials that brought the actor into existence', async () => {
      // Without this, "what is this thing and who made it" is unanswerable
      // from the UI — a credential is the only record of an agent's creation.
      await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma),
        handle: 'mia',
        name: 'Mia',
        runtime: 'lumenbox',
        teamKey: DEFAULT_TEAM_KEY,
      });

      const profile = await getAgentProfile(prisma, 'mia');

      expect(profile!.credentials).toHaveLength(1);
      expect(profile!.credentials[0]!.name).toBe('Mia');
      expect(profile!.credentials[0]!.teamKey).toBe(DEFAULT_TEAM_KEY);
      expect(profile!.credentials[0]!.scopes).toContain('answer');
      expect(profile!.credentials[0]!.revokedAt).toBeNull();
      expect(profile!.credentials[0]!.createdAt).toBeInstanceOf(Date);
    });

    it('is addressable by handle with or without the @', async () => {
      await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma), name: 'Mia', handle: 'mia', teamKey: DEFAULT_TEAM_KEY });

      await expect(getAgentProfile(prisma, '@mia')).resolves.not.toBeNull();
      await expect(getAgentProfile(prisma, 'MIA')).resolves.not.toBeNull();
      await expect(getAgentProfile(prisma, 'nobody')).resolves.toBeNull();
    });

    it('orders the timeline newest first', async () => {
      await withAgentActivity(prisma);

      const profile = await getAgentProfile(prisma, 'mia');
      const times = profile!.timeline.map((entry) => entry.at.getTime());

      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  describe('provenance', () => {
    it('names the actor that proposed the work', async () => {
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const { credential } = await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma),
        handle: 'proposer',
        name: 'Proposer',
        teamKey: DEFAULT_TEAM_KEY,
      });

      const created = await proposeWork(
        prisma,
        { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Proposed by an agent', description: AGENT_DESCRIPTION },
        { actorId: credential.userId, actorKind: 'AGENT', surface: 'test' },
      );

      const provenance = await findWorkProvenance(prisma, created.id);

      expect(provenance.actor?.id).toBe(credential.userId);
      expect(provenance.actor?.handle).toBe('proposer');
      expect(provenance.actorKind).toBe('AGENT');
    });

    it('still says what happened when the creating path recorded no actor', async () => {
      // The hotfix reflex and other internal writes record SERVICE with no
      // actor row. Returning only the actor left the UI blank there, which
      // reads as a bug rather than as "nothing identified itself".
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const state = await prisma.workflowState.findFirstOrThrow({
        where: { name: 'Ready', teamId: team.id },
      });
      const issue = await prisma.issue.create({
        data: { identifier: 'INV-907', stateId: state.id, teamId: team.id, title: 'Internal' },
      });
      await prisma.workAudit.create({
        data: {
          actorKind: 'SERVICE',
          after: {},
          revision: 1,
          surface: 'internal',
          workId: issue.id,
        },
      });

      const provenance = await findWorkProvenance(prisma, issue.id);

      expect(provenance.actor).toBeNull();
      expect(provenance.actorKind).toBe('SERVICE');
      expect(provenance.surface).toBe('internal');
    });
  });

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

    it('serves the directory with presence', async () => {
      await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma),
        handle: 'mia',
        name: 'Mia',
        runtime: 'lumenbox',
        teamKey: DEFAULT_TEAM_KEY,
      });

      const result = await query(
        `{ agents(teamKey: "${DEFAULT_TEAM_KEY}") { handle runtime presence presenceDetail actorKind } }`,
      );

      expect(result.errors).toBeUndefined();
      expect(result.data.agents).toHaveLength(1);
      expect(result.data.agents[0].handle).toBe('mia');
      expect(result.data.agents[0].runtime).toBe('lumenbox');
      expect(result.data.agents[0].presence).toBe('never-seen');
      expect(result.data.agents[0].actorKind).toBe('AGENT');
    });

    it('serves a profile with counts and timeline', async () => {
      await withAgentActivity(prisma);

      const result = await query(`{
        agentProfile(handle: "mia") {
          actor { handle presence }
          counts { answeredRequests openRequests runs evidence proposedWork }
          timeline { kind workIdentifier detail }
        }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data.agentProfile.actor.handle).toBe('mia');
      expect(result.data.agentProfile.counts.answeredRequests).toBe(1);
      expect(result.data.agentProfile.timeline.length).toBeGreaterThan(0);
    });

    it('serves proposedByActor on the work item', async () => {
      const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      const { credential } = await issueAgentCredential(prisma, {
      ownerId: await seededOwnerId(prisma),
        handle: 'proposer',
        name: 'Proposer',
        teamKey: DEFAULT_TEAM_KEY,
      });
      const created = await proposeWork(
        prisma,
        { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Proposed by an agent', description: AGENT_DESCRIPTION },
        { actorId: credential.userId, actorKind: 'AGENT', surface: 'test' },
      );

      const result = await query(
        `{ issue(id: "${created.id}") { proposedByActor { handle actorKind } } }`,
      );

      expect(result.errors).toBeUndefined();
      expect(result.data.issue.proposedByActor.handle).toBe('proposer');
      expect(result.data.issue.proposedByActor.actorKind).toBe('AGENT');
    });
  });
});

/** An agent that has been asked something, claimed it, and answered it. */
async function withAgentActivity(
  prismaClient: PrismaClient,
): Promise<{ issue: Issue; mia: User }> {
  const { credential } = await issueAgentCredential(prismaClient, {
      ownerId: await seededOwnerId(prismaClient),
    handle: 'mia',
    name: 'Mia',
    runtime: 'lumenbox',
    teamKey: DEFAULT_TEAM_KEY,
  });
  const mia = await prismaClient.user.findUniqueOrThrow({ where: { id: credential.userId } });

  const team = await prismaClient.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await prismaClient.workflowState.findFirstOrThrow({
    where: { name: 'Ready', teamId: team.id },
  });
  const issue = await prismaClient.issue.create({
    data: { identifier: 'INV-906', stateId: state.id, teamId: team.id, title: 'Profile host' },
  });

  const human = await prismaClient.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
  await createComment(prismaClient, { body: '@mia why?', issueId: issue.id }, human.id);

  const request = await prismaClient.agentRequest.findFirstOrThrow({
    where: { targetActorId: mia.id },
  });
  const held = await claimAgentRequest(prismaClient, { actorId: mia.id, id: request.id });
  await answerAgentRequest(prismaClient, {
    actorId: mia.id,
    body: 'Because of the code-block rule.',
    claimToken: held.claimToken,
    id: request.id,
  });

  return { issue, mia };
}


// INV-586: a new agent needs a human accountable for it.
async function seededOwnerId(client: PrismaClient): Promise<string> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
  return admin.id;
}
