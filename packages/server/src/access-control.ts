import type {
  Prisma,
  PrismaClient,
  TeamMembershipRole,
  TeamVisibility,
} from '@prisma/client';

import type { GraphQLContext } from './auth.js';
import {
  COMMENT_NOT_FOUND_MESSAGE,
  ACTOR_MANAGE_FORBIDDEN_MESSAGE,
  TEAM_MANAGE_FORBIDDEN_MESSAGE,
  TEAM_WRITE_FORBIDDEN_MESSAGE,
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
} from './errors.js';
const NEVER_MATCHING_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * INV-592: an agent's access comes from the credential it authenticated
 * with — its team binding and its scopes — never from a TeamMembership.
 * Memberships are a human roster with human roles; an agent has no role on
 * it. So every check below has two paths: the human one (membership) and
 * the agent one (the bound team on the request).
 */
function isAgentRequest(context: GraphQLContext): boolean {
  return context.authMode === 'agent-token';
}

function boundTeamId(context: GraphQLContext): string | null {
  return isAgentRequest(context) ? context.agentTeamId ?? null : null;
}

type MembershipRole = TeamMembershipRole;
type Visibility = TeamVisibility;

export function buildReadableTeamWhere(context: GraphQLContext): Prisma.TeamWhereInput | undefined {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return undefined;
  }

  if (!context.viewer) {
    return {
      id: NEVER_MATCHING_UUID,
    };
  }

  if (isAgentRequest(context)) {
    const teamId = boundTeamId(context);
    return {
      OR: [
        { visibility: 'PUBLIC' satisfies Visibility },
        { id: teamId ?? NEVER_MATCHING_UUID },
      ],
    };
  }

  return {
    OR: [
      { visibility: 'PUBLIC' satisfies Visibility },
      {
        memberships: {
          some: {
            userId: context.viewer.id,
          },
        },
      },
    ],
  };
}

export function buildReadableIssueWhere(context: GraphQLContext): Prisma.IssueWhereInput | undefined {
  const readableTeamWhere = buildReadableTeamWhere(context);

  if (!readableTeamWhere) {
    return undefined;
  }

  return {
    team: readableTeamWhere,
  };
}

export async function assertCanReadTeam(
  prisma: PrismaClient,
  context: GraphQLContext,
  teamId: string,
): Promise<void> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }

  if (!context.viewer) {
    throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  }

  const readable = await prisma.team.findFirst({
    where: { id: teamId, ...buildReadableTeamWhere(context) },
    select: { id: true },
  });

  if (!readable) {
    throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  }
}

export async function assertCanWriteTeam(
  prisma: PrismaClient,
  context: GraphQLContext,
  teamId: string,
): Promise<void> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }

  if (!context.viewer) {
    throw createValidationError(TEAM_WRITE_FORBIDDEN_MESSAGE);
  }

  if (isAgentRequest(context)) {
    // Exactly the team the credential is bound to. Scopes (what it may do
    // there) are checked by the tool surface; this is where it may do it.
    if (boundTeamId(context) !== teamId) {
      throw createValidationError(TEAM_WRITE_FORBIDDEN_MESSAGE);
    }
    return;
  }

  const membership = await prisma.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId,
        userId: context.viewer.id,
      },
    },
    select: {
      role: true,
    },
  });

  if (!membership || !isEditorRole(membership.role)) {
    throw createValidationError(TEAM_WRITE_FORBIDDEN_MESSAGE);
  }
}

export async function assertCanManageTeam(
  prisma: PrismaClient,
  context: GraphQLContext,
  teamId: string,
): Promise<void> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }

  if (!context.viewer || isAgentRequest(context)) {
    // Managing a team — its roster, its visibility, its agents — is a human act.
    throw createValidationError(TEAM_MANAGE_FORBIDDEN_MESSAGE);
  }

  const membership = await prisma.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId,
        userId: context.viewer.id,
      },
    },
    select: {
      role: true,
    },
  });

  if (!membership || membership.role !== 'OWNER') {
    throw createValidationError(TEAM_MANAGE_FORBIDDEN_MESSAGE);
  }
}

/**
 * Who may change an actor's lifecycle (deactivate it, transfer its owner).
 *
 * A global ADMIN; the actor's owner; or an OWNER of a team the actor belongs
 * to — by membership or by a live credential bound to that team. A HUMAN
 * subject has no owner and belongs to nobody, so only an ADMIN may deactivate
 * one. Being logged in is not enough: knowing an id must not be a capability.
 */
export async function assertCanManageActor(
  prisma: PrismaClient,
  context: GraphQLContext,
  subjectId: string,
): Promise<void> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }
  const viewer = context.viewer;
  if (!viewer || viewer.actorKind !== 'HUMAN') {
    throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
  }

  const subject = await prisma.user.findUnique({
    where: { id: subjectId },
    select: { actorKind: true, ownerId: true },
  });
  if (!subject || subject.actorKind === 'HUMAN') {
    throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
  }
  if (subject.ownerId === viewer.id) {
    return;
  }

  const [memberships, credentials] = await Promise.all([
    prisma.teamMembership.findMany({ where: { userId: subjectId }, select: { teamId: true } }),
    prisma.agentCredential.findMany({
      where: { revokedAt: null, teamId: { not: null }, userId: subjectId },
      select: { teamId: true },
    }),
  ]);
  const teamIds = [...new Set([
    ...memberships.map((m) => m.teamId),
    ...credentials.map((c) => c.teamId).filter((id): id is string => id !== null),
  ])];
  if (teamIds.length === 0) {
    throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
  }
  const ownsATeam = await prisma.teamMembership.findFirst({
    where: { role: 'OWNER', teamId: { in: teamIds }, userId: viewer.id },
    select: { id: true },
  });
  if (!ownsATeam) {
    throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
  }
}

export async function assertCanReadIssue(
  prisma: PrismaClient,
  context: GraphQLContext,
  issueId: string,
): Promise<void> {
  const issue = await prisma.issue.findUnique({
    where: {
      id: issueId,
    },
    select: {
      teamId: true,
    },
  });

  if (!issue) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  await assertCanReadTeam(prisma, context, issue.teamId);
}

export async function assertCanWriteIssue(
  prisma: PrismaClient,
  context: GraphQLContext,
  issueId: string,
): Promise<void> {
  const issue = await prisma.issue.findUnique({
    where: {
      id: issueId,
    },
    select: {
      teamId: true,
    },
  });

  if (!issue) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  await assertCanWriteTeam(prisma, context, issue.teamId);
}

export async function assertCanDeleteComment(
  prisma: PrismaClient,
  context: GraphQLContext,
  commentId: string,
): Promise<void> {
  const comment = await prisma.comment.findUnique({
    where: {
      id: commentId,
    },
    select: {
      id: true,
      issue: {
        select: {
          teamId: true,
        },
      },
      userId: true,
    },
  });

  if (!comment) {
    throw createNotFoundError(COMMENT_NOT_FOUND_MESSAGE);
  }

  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }

  if (context.viewer?.id === comment.userId) {
    return;
  }

  await assertCanWriteTeam(prisma, context, comment.issue.teamId);
}

export function buildVisibleUsersWhere(context: GraphQLContext): Prisma.UserWhereInput | undefined {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return undefined;
  }

  if (!context.viewer) {
    return {
      id: NEVER_MATCHING_UUID,
    };
  }

  // The teams whose people (and agents) this viewer may see: public ones,
  // plus the ones it is in — by membership for a human, by binding for an agent.
  const visibleTeam: Prisma.TeamWhereInput = isAgentRequest(context)
    ? { OR: [{ visibility: 'PUBLIC' }, { id: boundTeamId(context) ?? NEVER_MATCHING_UUID }] }
    : { OR: [{ visibility: 'PUBLIC' }, { memberships: { some: { userId: context.viewer.id } } }] };

  return {
    OR: [
      { id: context.viewer.id },
      // humans: on the roster of a visible team
      { memberships: { some: { team: visibleTeam } } },
      // agents and services: bound to a visible team by a live credential
      { agentCredentials: { some: { revokedAt: null, team: visibleTeam } } },
    ],
  };
}

function isEditorRole(role: MembershipRole): boolean {
  return role === 'EDITOR' || role === 'OWNER';
}
