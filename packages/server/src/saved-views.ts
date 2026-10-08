import type { Prisma, PrismaClient, SavedView } from '@prisma/client';

import { assertCanReadTeam, assertCanWriteTeam, assertTeamNotArchived } from './access-control.js';
import { requireAuthentication, type GraphQLContext } from './auth.js';
import { createNotFoundError, createValidationError, TEAM_NOT_FOUND_MESSAGE } from './errors.js';

/**
 * Saved board / backlog views on the server (INV-1005). Until now a view lived
 * only in the browser that made it (board/views.ts): not on another device,
 * not for a teammate. A PRIVATE view is its owner's; a TEAM view is every
 * member's. Visibility follows team access (INV-846): reading needs read
 * access to the team, writing a TEAM view needs write access.
 */
export const SAVED_VIEW_KINDS = ['board', 'backlog'] as const;
export const SAVED_VIEW_VISIBILITIES = ['PRIVATE', 'TEAM'] as const;
export type SavedViewKind = (typeof SAVED_VIEW_KINDS)[number];
export type SavedViewVisibility = (typeof SAVED_VIEW_VISIBILITIES)[number];

export const SAVED_VIEW_NOT_FOUND_MESSAGE = 'Saved view not found, or not yours to change.';
export const SAVED_VIEW_INVALID_MESSAGE = 'A saved view needs a name (1–120 characters), kind board or backlog, visibility PRIVATE or TEAM and an object state.';

export interface SavedViewInput {
  id?: string | null;
  teamKey: string;
  name: string;
  kind: string;
  visibility?: string | null;
  state: unknown;
}

async function teamByKey(prisma: PrismaClient, teamKey: string) {
  const team = await prisma.team.findFirst({ where: { OR: [{ key: teamKey }, ...(/^[0-9a-f-]{36}$/i.test(teamKey) ? [{ id: teamKey }] : [])] }, select: { id: true, key: true } });
  if (!team) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  return team;
}

/** The viewer's own views plus the team's shared ones, oldest first. */
export async function listSavedViews(context: GraphQLContext, teamKey: string): Promise<SavedView[]> {
  const viewer = requireAuthentication(context);
  const team = await teamByKey(context.prisma, teamKey);
  await assertCanReadTeam(context.prisma, context, team.id);
  return context.prisma.savedView.findMany({
    where: { teamId: team.id, OR: [{ ownerId: viewer.id }, { visibility: 'TEAM' }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Create or update. Only the owner edits a view; sharing it needs write access to the team. */
export async function upsertSavedView(context: GraphQLContext, input: SavedViewInput): Promise<SavedView> {
  const viewer = requireAuthentication(context);
  const name = input.name?.trim() ?? '';
  const visibility = (input.visibility ?? 'PRIVATE') as SavedViewVisibility;
  if (!name || name.length > 120 || !SAVED_VIEW_KINDS.includes(input.kind as SavedViewKind) || !SAVED_VIEW_VISIBILITIES.includes(visibility) || !input.state || typeof input.state !== 'object' || Array.isArray(input.state)) {
    throw createValidationError(SAVED_VIEW_INVALID_MESSAGE);
  }
  const team = await teamByKey(context.prisma, input.teamKey);
  // An archived team is read-only for everything, private views included.
  await assertTeamNotArchived(context.prisma, team.id);
  if (visibility === 'TEAM') await assertCanWriteTeam(context.prisma, context, team.id);
  else await assertCanReadTeam(context.prisma, context, team.id);
  const state = JSON.parse(JSON.stringify(input.state)) as Prisma.InputJsonValue;
  if (input.id) {
    const existing = await context.prisma.savedView.findFirst({ where: { id: input.id, teamId: team.id } });
    if (existing && existing.ownerId !== viewer.id && context.viewer?.globalRole !== 'ADMIN') throw createNotFoundError(SAVED_VIEW_NOT_FOUND_MESSAGE);
    if (existing) return context.prisma.savedView.update({ where: { id: existing.id }, data: { name, kind: input.kind, visibility, state } });
    // A client-made id (the browser's migration keeps its old ids) is accepted when it is a UUID.
    if (/^[0-9a-f-]{36}$/i.test(input.id)) {
      return context.prisma.savedView.create({ data: { id: input.id, teamId: team.id, ownerId: viewer.id, name, kind: input.kind, visibility, state } });
    }
  }
  return context.prisma.savedView.create({ data: { teamId: team.id, ownerId: viewer.id, name, kind: input.kind, visibility, state } });
}

export async function deleteSavedView(context: GraphQLContext, id: string): Promise<boolean> {
  const viewer = requireAuthentication(context);
  const existing = await context.prisma.savedView.findUnique({ where: { id } });
  if (!existing) return false;
  await assertTeamNotArchived(context.prisma, existing.teamId);
  if (existing.ownerId !== viewer.id && context.viewer?.globalRole !== 'ADMIN') {
    // A team owner may remove a shared view from the team.
    if (existing.visibility !== 'TEAM') throw createNotFoundError(SAVED_VIEW_NOT_FOUND_MESSAGE);
    await assertCanWriteTeam(context.prisma, context, existing.teamId);
  }
  await context.prisma.savedView.delete({ where: { id } });
  return true;
}
