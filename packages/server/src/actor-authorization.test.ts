import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { assertCanManageActor } from './access-control.ts';
import type { GraphQLContext } from './auth.ts';
import { ACTOR_MANAGE_FORBIDDEN_MESSAGE } from './errors.ts';
import { createSession, getSessionRecord } from './session.ts';
import {
  EXPIRY_SWEEPER_ACTOR,
  SERVICE_IDENTITY_COLLISION_MESSAGE,
  ensureServiceActor,
  provisionServiceActor,
} from './service-actors.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * INV-590. Three holes the review found after INV-586 shipped:
 * 1. any logged-in human could deactivate any actor or transfer its owner;
 * 2. a deactivated human kept acting through an existing session;
 * 3. provisioning a SERVICE upserted by email, so it could rename an existing
 *    human or agent and then audit "created a service".
 */
describe('actor authorization (INV-590)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  describe('who may manage an actor', () => {
    it('a logged-in human who is neither owner nor team owner is refused', async () => {
      const { mia } = await fixture(prisma);
      const bystander = await human(prisma, 'bystander');

      await expect(assertCanManageActor(prisma, ctx(bystander), mia.id))
        .rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
    });

    it("the actor's owner may", async () => {
      const { mia, owner } = await fixture(prisma);
      await expect(assertCanManageActor(prisma, ctx(owner), mia.id)).resolves.toBeUndefined();
    });

    it('an OWNER of a team the actor belongs to may NOT (INV-594: a team right is not an identity right)', async () => {
      const { mia, team } = await fixture(prisma);
      const lead = await human(prisma, 'lead');
      await prisma.teamMembership.create({ data: { role: 'OWNER', teamId: team.id, userId: lead.id } });

      await expect(assertCanManageActor(prisma, ctx(lead), mia.id)).rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('an EDITOR of that team may not', async () => {
      const { mia, team } = await fixture(prisma);
      const editor = await human(prisma, 'editor');
      await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: editor.id } });

      await expect(assertCanManageActor(prisma, ctx(editor), mia.id))
        .rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('a credential binding to the team does not make its OWNER able to manage the actor either', async () => {
      const { mia, team } = await fixture(prisma, { member: false });
      await prisma.agentCredential.create({
        data: { name: 'c', teamId: team.id, tokenHash: 'h-'.padEnd(20, 'x'), userId: mia.id },
      });
      const lead = await human(prisma, 'lead');
      await prisma.teamMembership.create({ data: { role: 'OWNER', teamId: team.id, userId: lead.id } });

      await expect(assertCanManageActor(prisma, ctx(lead), mia.id)).rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('a global ADMIN may, and an AGENT never may', async () => {
      const { admin, mia } = await fixture(prisma);
      await expect(assertCanManageActor(prisma, ctx(admin), mia.id)).resolves.toBeUndefined();
      await expect(assertCanManageActor(prisma, ctx(mia), mia.id)).rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
    });

    it('a HUMAN subject can only be managed by an ADMIN', async () => {
      const { admin, owner } = await fixture(prisma);
      const other = await human(prisma, 'other');

      await expect(assertCanManageActor(prisma, ctx(owner), other.id)).rejects.toThrow(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
      await expect(assertCanManageActor(prisma, ctx(admin), other.id)).resolves.toBeUndefined();
    });
  });

  describe('deactivation ends sessions', () => {
    it('a deactivated human cannot keep acting through an existing session', async () => {
      const person = await human(prisma, 'leaver');
      const { token } = await createSession(prisma, person.id);
      expect((await getSessionRecord(prisma, token))?.user.id).toBe(person.id);

      await prisma.user.update({ where: { id: person.id }, data: { deactivatedAt: new Date() } });

      await expect(getSessionRecord(prisma, token)).resolves.toBeNull();
      // and the session row is gone, like an expired one
      await expect(prisma.session.count({ where: { userId: person.id } })).resolves.toBe(0);
    });
  });

  describe('provisioning a SERVICE never touches an existing identity', () => {
    it('refuses an email that already belongs to a human, and writes no audit', async () => {
      const { admin } = await fixture(prisma);
      const before = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });

      await expect(provisionServiceActor(prisma, {
        byActorId: admin.id, email: admin.email, handle: 'not-admin', name: 'Renamed', ownerId: admin.id,
      })).rejects.toThrow(SERVICE_IDENTITY_COLLISION_MESSAGE);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(after).toEqual(before);
      await expect(prisma.actorAudit.count({ where: { action: 'provisioned' } })).resolves.toBe(0);
    });

    it('refuses a handle that already names an agent', async () => {
      const { admin } = await fixture(prisma);   // creates @mia
      await expect(provisionServiceActor(prisma, {
        byActorId: admin.id, handle: 'mia', name: 'Fake Mia', ownerId: admin.id,
      })).rejects.toThrow(SERVICE_IDENTITY_COLLISION_MESSAGE);
    });

    it('creates the row and its audit together, describing what was written', async () => {
      const { admin } = await fixture(prisma);
      const created = await provisionServiceActor(prisma, {
        byActorId: admin.id, handle: 'ci-bot', name: 'CI', ownerId: admin.id,
      });

      const audit = await prisma.actorAudit.findFirstOrThrow({ where: { subjectId: created.actorId } });
      expect(audit.action).toBe('provisioned');
      expect(audit.byActorId).toBe(admin.id);
      expect(audit.after).toMatchObject({ actorKind: 'SERVICE', handle: 'ci-bot', ownerId: admin.id });
    });
  });

  describe('built-in services have an owner', () => {
    it('defaults to the first active admin when created without one', async () => {
      const { admin } = await fixture(prisma);
      const { actorId } = await ensureServiceActor(prisma, EXPIRY_SWEEPER_ACTOR);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: actorId } });
      expect(row.ownerId).toBe(admin.id);
    });
  });
});

function ctx(viewer: User): GraphQLContext {
  return { authMode: 'session', isTrustedSystem: false, prisma, viewer };
}

async function human(client: PrismaClient, handle: string): Promise<User> {
  return client.user.create({
    data: { actorKind: 'HUMAN', email: `${handle}@humans.test.local`, globalRole: 'USER', handle, name: handle },
  });
}

async function fixture(
  client: PrismaClient,
  opts: { member?: boolean } = {},
): Promise<{ admin: User; mia: User; owner: User; team: { id: string } }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const owner = await human(client, 'owner');
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const mia = await client.user.create({
    data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: owner.id },
  });
  if (opts.member !== false) {
    await client.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: mia.id } });
  }
  return { admin, mia, owner, team };
}
