import { PrismaClient as PrismaClientConstructor } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { assertActorCan, proposeWork } from './claim-service.ts';
import { findWorkProvenance } from './agent-directory.ts';
import { HOTFIX_REFLEX_ACTOR, ensureServiceActor } from './service-actors.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const AGENT_DESCRIPTION = [
  '### 1. 目标与架构定位',
  '验证内部写入者以自己的身份署名。',
  '### 2. 核心功能与交付范围',
  '仅测试夹具。',
  '### 3. 验收标准与验证方案',
  'vitest src/service-actors.test.ts 通过，exit 0。',
].join('\n');

describe('service actors (INV-573)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
  });

  it('creates a registered, mentionable identity for an internal writer', async () => {
    const actor = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: actor.actorId } });

    expect(row.actorKind).toBe('SERVICE');
    expect(row.handle).toBe('hotfix-reflex');
    expect(row.description).toBeTruthy();
  });

  it('is idempotent, so a service can call it on every run', async () => {
    const first = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);
    const second = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);

    expect(second.actorId).toBe(first.actorId);
    await expect(prisma.user.count({ where: { handle: 'hotfix-reflex' } })).resolves.toBe(1);
  });

  it('holds no credential, so it cannot authenticate from outside', async () => {
    const actor = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);

    await expect(prisma.agentCredential.count({ where: { userId: actor.actorId } }))
      .resolves.toBe(0);
  });

  it('cannot pass the human gates, so naming it grants nothing', async () => {
    const actor = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);

    expect(actor.actorKind).toBe('SERVICE');
    expect(() => assertActorCan(actor.actorKind, 'commit')).toThrow(/commit/i);
    expect(() => assertActorCan(actor.actorKind, 'accept')).toThrow(/accept/i);
  });

  it('work it files names it, instead of reading as nobody', async () => {
    // The INV-583 failure: provenance was SERVICE / actor null / surface
    // internal, so the UI could only say "proposed via an unidentified path".
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const actor = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);

    const created = await proposeWork(
      prisma,
      { description: AGENT_DESCRIPTION, source: 'hotfix-reflex', teamId: team.id, title: 'Reflex fix' },
      actor,
    );

    const provenance = await findWorkProvenance(prisma, created.id);

    expect(provenance.actor).not.toBeNull();
    expect(provenance.actor?.handle).toBe('hotfix-reflex');
    expect(provenance.actorKind).toBe('SERVICE');
    expect(provenance.surface).toBe('hotfix-reflex');
  });
});
