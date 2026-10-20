import { PrismaClient as PrismaClientConstructor } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectEnvironment } from '../../prisma/env.ts';
import { resetAndSeed } from '../../prisma/seed-helpers.ts';
import { normalizeTeamKey, syncOrganization } from './engine.ts';
import type { OrganizationGroup, OrganizationPerson, OrganizationSyncInput } from './types.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * A source that is deliberately **not** any sign-in line: it proves the
 * engine reads the contract and nothing else.
 */
const ROSTER_PROVIDER = 'roster';

function person(
  externalId: string | null,
  name: string,
  email: string | null,
): OrganizationPerson {
  return { avatarUrl: null, email, externalId, name };
}

function group(
  externalId: string,
  teamKey: string,
  people: OrganizationPerson[],
  overrides: Partial<OrganizationGroup> = {},
): OrganizationGroup {
  return { externalId, name: teamKey, people, teamKey, ...overrides };
}

function input(groups: OrganizationGroup[], provider = ROSTER_PROVIDER): OrganizationSyncInput {
  return { groups, provider };
}

describe('the organisation import engine (INV-1288)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.externalOrganizationRef.deleteMany();
    await prisma.teamMembership.deleteMany();
    await prisma.userIdentity.deleteMany();
    await prisma.team.deleteMany({ where: { key: { not: 'INV' } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@example.com' } } });
  });

  it('turns a group into a team and its people into members', async () => {
    const summary = await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    expect(summary.teamsCreated).toBe(1);
    expect(summary.peopleCreated).toBe(1);
    expect(summary.peopleLinked).toBe(1);
    expect(summary.membersAdded).toBe(1);

    const team = await prisma.team.findUniqueOrThrow({ where: { key: 'CORE' } });
    const member = await prisma.teamMembership.findFirstOrThrow({ where: { teamId: team.id } });
    expect(member.role).toBe('EDITOR');
  });

  it('gives the team it creates the default workflow, so issues can be filed in it', async () => {
    await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    const team = await prisma.team.findUniqueOrThrow({ where: { key: 'CORE' } });
    const states = await prisma.workflowState.findMany({
      where: { teamId: team.id },
      orderBy: { position: 'asc' },
    });

    expect(states.map((state) => state.name)).toEqual([
      'Backlog',
      'Ready',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
  });

  it('records the source identity, so the person can sign in through that source', async () => {
    await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ann@example.com' } });
    const identity = await prisma.userIdentity.findUniqueOrThrow({
      where: { provider_subject: { provider: ROSTER_PROVIDER, subject: 'p1' } },
    });

    expect(identity.userId).toBe(user.id);
  });

  it('leaves a person with no email address out, and says so', async () => {
    const summary = await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Bo Wang', null)])]),
      prisma,
    });

    expect(summary.peopleWithoutEmail).toEqual(['Bo Wang']);
    expect(summary.peopleCreated).toBe(0);
    expect(summary.membersAdded).toBe(0);
  });

  it('leaves a person with no stable id out of the identity, and says so', async () => {
    const summary = await syncOrganization({
      input: input([group('g1', 'CORE', [person(null, 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    expect(summary.peopleWithoutIdentity).toEqual(['Ann Li']);
    expect(summary.peopleLinked).toBe(0);
    // The person is still a member: the id is only needed to sign in.
    expect(summary.membersAdded).toBe(1);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const groups = [group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])];

    await syncOrganization({ input: input(groups), prisma });
    const second = await syncOrganization({ input: input(groups), prisma });

    expect(second.teamsCreated).toBe(0);
    expect(second.teamsReused).toBe(1);
    expect(second.membersAdded).toBe(0);
    expect(second.membersUnchanged).toBe(1);
    expect(second.peopleCreated).toBe(0);
    expect(second.peopleLinked).toBe(0);
  });

  it('adopts a team that already carries the key instead of making a second one', async () => {
    const existing = await prisma.team.create({ data: { key: 'CORE', name: 'Old name' } });

    const summary = await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    expect(summary.teamsCreated).toBe(0);
    expect(summary.teamsReused).toBe(1);
    expect(await prisma.team.count({ where: { key: 'CORE' } })).toBe(1);

    const ref = await prisma.externalOrganizationRef.findFirstOrThrow({
      where: { provider: ROSTER_PROVIDER },
    });
    expect(ref.teamId).toBe(existing.id);
  });

  it('does not let a second group take over a team', async () => {
    await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    const summary = await syncOrganization({
      input: input([group('g2', 'CORE', [person('p2', 'Cat Wu', 'cat@example.com')])]),
      prisma,
    });

    expect(summary.warnings.some((warning) => warning.includes('already mapped'))).toBe(true);
    expect(await prisma.team.count({ where: { key: 'CORE' } })).toBe(1);
    // The second group was refused, so its people were not written.
    expect(await prisma.user.count({ where: { email: 'cat@example.com' } })).toBe(0);
  });

  it('does not let a second source take over a team either', async () => {
    await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    const summary = await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])], 'another-source'),
      prisma,
    });

    expect(summary.warnings.some((warning) => warning.includes('already mapped'))).toBe(true);
  });

  it('refuses a team key that a project alias already spells', async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { key: 'INV' } });
    const state = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id },
      orderBy: { position: 'asc' },
    });

    await prisma.issue.create({
      data: {
        alias: 'CORE',
        identifier: 'INV-9001',
        kind: 'PROJECT',
        stateId: state.id,
        teamId: team.id,
        title: 'A project that already spells CORE',
      },
    });

    const summary = await syncOrganization({
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    expect(summary.teamsCreated).toBe(0);
    expect(summary.warnings.some((warning) => warning.includes('project alias'))).toBe(true);
    expect(await prisma.team.count({ where: { key: 'CORE' } })).toBe(0);
  });

  it('removes only the membership of somebody who left, and only when asked', async () => {
    const groups = [group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])];
    await syncOrganization({ input: input(groups), prisma });

    const empty = [group('g1', 'CORE', [])];

    const withoutPrune = await syncOrganization({ input: input(empty), prisma });
    expect(withoutPrune.membersRemoved).toBe(0);

    const team = await prisma.team.findUniqueOrThrow({ where: { key: 'CORE' } });
    expect(await prisma.teamMembership.count({ where: { teamId: team.id } })).toBe(1);

    const pruned = await syncOrganization({ input: input(empty), prune: true, prisma });
    expect(pruned.membersRemoved).toBe(1);
    expect(await prisma.teamMembership.count({ where: { teamId: team.id } })).toBe(0);
    // The account stays: a workspace remembers who worked here.
    expect(await prisma.user.count({ where: { email: 'ann@example.com' } })).toBe(1);
  });

  it('writes nothing in a dry run', async () => {
    const summary = await syncOrganization({
      dryRun: true,
      input: input([group('g1', 'CORE', [person('p1', 'Ann Li', 'ann@example.com')])]),
      prisma,
    });

    expect(summary.teamsCreated).toBe(1);
    expect(summary.membersAdded).toBe(1);
    expect(await prisma.team.count({ where: { key: 'CORE' } })).toBe(0);
    expect(await prisma.user.count({ where: { email: 'ann@example.com' } })).toBe(0);
  });

  it('refuses a team key that would not read well in an identifier', () => {
    expect(normalizeTeamKey('core')).toBe('CORE');
    expect(() => normalizeTeamKey('1')).toThrow(/2-10 letters/);
    expect(() => normalizeTeamKey('A VERY LONG KEY')).toThrow(/2-10 letters/);
  });
});
