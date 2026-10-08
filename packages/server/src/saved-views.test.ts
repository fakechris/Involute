import { PrismaClient } from '@prisma/client';
import type { Team, User } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import type { GraphQLContext } from './auth.ts';
import { deleteSavedView, listSavedViews, SAVED_VIEW_INVALID_MESSAGE, upsertSavedView } from './saved-views.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

// INV-1005: a view saved by one person on one device is theirs everywhere; a shared one is the team's.
describe('saved views (INV-1005)', () => {
  let team: Team;
  let owner: User;
  let member: User;
  let viewerOnly: User;
  let outsider: User;
  const ctx = (viewer: User): GraphQLContext => ({ prisma, viewer, authMode: 'session', isTrustedSystem: false });
  const state = { groupBy: 'status', query: 'state:review', sortField: 'updatedAt', sortDirection: 'desc', assigneeIds: [], labelIds: [], stateIds: [], viewMode: 'list' };

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    owner = await prisma.user.create({ data: { name: 'Owner', email: 'owner@views.test', actorKind: 'HUMAN' } });
    member = await prisma.user.create({ data: { name: 'Member', email: 'member@views.test', actorKind: 'HUMAN' } });
    viewerOnly = await prisma.user.create({ data: { name: 'Viewer', email: 'viewer@views.test', actorKind: 'HUMAN' } });
    outsider = await prisma.user.create({ data: { name: 'Outsider', email: 'outsider@views.test', actorKind: 'HUMAN' } });
    await prisma.teamMembership.createMany({ data: [
      { teamId: team.id, userId: owner.id, role: 'EDITOR' },
      { teamId: team.id, userId: member.id, role: 'EDITOR' },
      { teamId: team.id, userId: viewerOnly.id, role: 'VIEWER' },
    ] });
  });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('shows a private view only to its owner, on any device, and a shared view to every member', async () => {
    const mine = await upsertSavedView(ctx(owner), { teamKey: DEFAULT_TEAM_KEY, name: 'Mine', kind: 'board', state });
    const shared = await upsertSavedView(ctx(owner), { teamKey: DEFAULT_TEAM_KEY, name: 'Team queue', kind: 'backlog', visibility: 'TEAM', state });
    // "Another device" is just another session of the same person.
    expect((await listSavedViews({ ...ctx(owner), authMode: 'token' }, DEFAULT_TEAM_KEY)).map((view) => view.name)).toEqual(['Mine', 'Team queue']);
    expect((await listSavedViews(ctx(member), DEFAULT_TEAM_KEY)).map((view) => view.name)).toEqual(['Team queue']);
    expect((await listSavedViews(ctx(viewerOnly), DEFAULT_TEAM_KEY)).map((view) => view.name)).toEqual(['Team queue']);
    await expect(listSavedViews(ctx(outsider), DEFAULT_TEAM_KEY)).rejects.toThrow();
    expect(mine.visibility).toBe('PRIVATE');
    expect(shared.state).toMatchObject({ query: 'state:review' });
  });

  it('lets only the owner edit, needs team write access to share, and keeps a browser-made UUID when migrating', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const migrated = await upsertSavedView(ctx(owner), { id, teamKey: DEFAULT_TEAM_KEY, name: 'From localStorage', kind: 'board', state });
    expect(migrated.id).toBe(id);
    const renamed = await upsertSavedView(ctx(owner), { id, teamKey: DEFAULT_TEAM_KEY, name: 'Renamed', kind: 'board', state });
    expect(renamed.name).toBe('Renamed');
    expect(await prisma.savedView.count()).toBe(1);
    await expect(upsertSavedView(ctx(member), { id, teamKey: DEFAULT_TEAM_KEY, name: 'Hijack', kind: 'board', state })).rejects.toThrow();
    await expect(upsertSavedView(ctx(viewerOnly), { teamKey: DEFAULT_TEAM_KEY, name: 'Share', kind: 'board', visibility: 'TEAM', state })).rejects.toThrow();
    await expect(upsertSavedView(ctx(owner), { teamKey: DEFAULT_TEAM_KEY, name: '', kind: 'board', state })).rejects.toThrow(SAVED_VIEW_INVALID_MESSAGE);
    await expect(upsertSavedView(ctx(owner), { teamKey: DEFAULT_TEAM_KEY, name: 'x', kind: 'calendar', state })).rejects.toThrow(SAVED_VIEW_INVALID_MESSAGE);
  });

  it('deletes: the owner any of theirs, a team editor a shared one, nobody else', async () => {
    const mine = await upsertSavedView(ctx(owner), { teamKey: DEFAULT_TEAM_KEY, name: 'Mine', kind: 'board', state });
    const shared = await upsertSavedView(ctx(owner), { teamKey: DEFAULT_TEAM_KEY, name: 'Shared', kind: 'board', visibility: 'TEAM', state });
    await expect(deleteSavedView(ctx(member), mine.id)).rejects.toThrow();
    expect(await deleteSavedView(ctx(member), shared.id)).toBe(true);
    expect(await deleteSavedView(ctx(owner), mine.id)).toBe(true);
    expect(await deleteSavedView(ctx(owner), mine.id)).toBe(false);
  });
});
