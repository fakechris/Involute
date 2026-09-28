import type { Prisma, PrismaClient, Team, TeamVisibility, User, WorkflowStateType } from '@prisma/client';

import {
  TEAM_ARCHIVED_MESSAGE,
  TEAM_CREATE_FORBIDDEN_MESSAGE,
  TEAM_JOIN_FORBIDDEN_MESSAGE,
  TEAM_KEY_FORMAT_MESSAGE,
  TEAM_KEY_TAKEN_MESSAGE,
  TEAM_LAST_OWNER_LEAVE_MESSAGE,
  TEAM_NAME_REQUIRED_MESSAGE,
  TEAM_NOT_A_MEMBER_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  createNotFoundError,
  createValidationError,
} from './errors.js';
import { getWorkspaceSettings } from './workspace-access.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Team lifecycle (INV-848, docs/permissions.md §3 and §5).
 *
 * A team is created (by admins, or members when allowed) with its creator as
 * Owner and the default workflow; renamed and made public or private by its
 * owners; archived instead of deleted, because every identifier and PR
 * reference carries its key. People join public teams themselves and leave
 * any team, except its last owner.
 */

const DEFAULT_STATES: Array<{ name: string; type: WorkflowStateType }> = [
  { name: 'Backlog', type: 'BACKLOG' },
  { name: 'Ready', type: 'UNSTARTED' },
  { name: 'In Progress', type: 'STARTED' },
  { name: 'In Review', type: 'REVIEW' },
  { name: 'Done', type: 'COMPLETED' },
  { name: 'Canceled', type: 'CANCELED' },
];

const TEAM_KEY_SHAPE = /^[A-Z]{2,10}$/;

export type TeamCreator = Pick<User, 'actorKind' | 'globalRole' | 'id'>;

export async function canCreateTeams(prisma: DatabaseClient, viewer: TeamCreator | null): Promise<boolean> {
  if (!viewer || viewer.actorKind !== 'HUMAN') return false;
  if (viewer.globalRole === 'ADMIN') return true;
  if (viewer.globalRole !== 'USER') return false;
  return (await getWorkspaceSettings(prisma)).membersCanCreateTeams;
}

export async function createTeam(
  prisma: PrismaClient,
  input: { creator: TeamCreator; key: string; name: string; visibility?: TeamVisibility },
): Promise<Team> {
  if (!(await canCreateTeams(prisma, input.creator))) throw createValidationError(TEAM_CREATE_FORBIDDEN_MESSAGE);
  const key = input.key.trim().toUpperCase();
  const name = input.name.trim();
  if (!TEAM_KEY_SHAPE.test(key)) throw createValidationError(TEAM_KEY_FORMAT_MESSAGE);
  if (!name) throw createValidationError(TEAM_NAME_REQUIRED_MESSAGE);

  return prisma.$transaction(async (tx) => {
    // A key must not be a team key or a project alias already: both spell identifiers.
    const [teamClash, aliasClash] = await Promise.all([
      tx.team.findFirst({ where: { key: { equals: key, mode: 'insensitive' } }, select: { id: true } }),
      tx.issue.findFirst({ where: { alias: { equals: key, mode: 'insensitive' } }, select: { id: true } }),
    ]);
    if (teamClash || aliasClash) throw createValidationError(TEAM_KEY_TAKEN_MESSAGE);

    const team = await tx.team.create({ data: { key, name, visibility: input.visibility ?? 'PRIVATE' } });
    await tx.workflowState.createMany({
      data: DEFAULT_STATES.map((state, position) => ({ ...state, position, teamId: team.id })),
    });
    await tx.teamMembership.create({ data: { role: 'OWNER', teamId: team.id, userId: input.creator.id } });
    return team;
  });
}

export async function updateTeam(
  prisma: PrismaClient,
  input: { name?: string | null; teamId: string; visibility?: TeamVisibility | null },
): Promise<Team> {
  const data: Prisma.TeamUpdateInput = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw createValidationError(TEAM_NAME_REQUIRED_MESSAGE);
    data.name = name;
  }
  if (input.visibility != null) data.visibility = input.visibility;
  return prisma.team.update({ where: { id: input.teamId }, data });
}

export async function setTeamArchived(prisma: PrismaClient, teamId: string, archived: boolean): Promise<Team> {
  return prisma.team.update({ where: { id: teamId }, data: { archivedAt: archived ? new Date() : null } });
}

/** A workspace member joins a public, active team as a team Member (EDITOR). */
export async function joinTeam(prisma: PrismaClient, input: { teamId: string; user: TeamCreator }): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: input.teamId } });
  if (!team) throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  if (team.archivedAt) throw createValidationError(TEAM_ARCHIVED_MESSAGE);
  if (team.visibility !== 'PUBLIC' || input.user.actorKind !== 'HUMAN' || input.user.globalRole === 'GUEST') {
    throw createValidationError(TEAM_JOIN_FORBIDDEN_MESSAGE);
  }
  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: team.id, userId: input.user.id } },
    create: { role: 'EDITOR', teamId: team.id, userId: input.user.id },
    update: {},
  });
}

export async function leaveTeam(prisma: PrismaClient, input: { teamId: string; userId: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const membership = await tx.teamMembership.findUnique({
      where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
    });
    if (!membership) throw createValidationError(TEAM_NOT_A_MEMBER_MESSAGE);
    if (membership.role === 'OWNER') {
      const owners = await tx.teamMembership.count({ where: { role: 'OWNER', teamId: input.teamId } });
      if (owners <= 1) throw createValidationError(TEAM_LAST_OWNER_LEAVE_MESSAGE);
    }
    await tx.teamMembership.delete({ where: { id: membership.id } });
  });
}
