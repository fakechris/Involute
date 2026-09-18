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
  REQUEST_NOT_FOUND_MESSAGE,
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
 * Two independent gates (INV-594), never merged into one:
 *
 * - **Team authorization** — may the caller manage this *team*?
 *   (`assertCanManageTeam`: ADMIN or the team's OWNER.)
 * - **Identity authorization** — may the caller act *for this actor*?
 *   (`assertCanRepresentActor`: ADMIN or the actor's owner.)
 *
 * They answer different questions. An actor bound to team A and team B is one
 * identity with two credentials; B's OWNER manages B's credential, and that
 * is all. Owning a team the actor happens to be bound to does not make B's
 * OWNER able to speak as the actor, mint it new credentials, stop it, or
 * hand its ownership to someone else. The earlier rule ("owner of any bound
 * team may manage the whole actor") let exactly that happen.
 *
 * Operation                        Who
 * deactivate actor                 ADMIN, actor owner
 * transfer actor owner             ADMIN, current actor owner
 * revoke a team's credential       ADMIN, actor owner, that team's OWNER
 * issue credential to an existing  ADMIN or actor owner — AND manage rights
 *   actor                            on the target team (both gates)
 */
export async function assertCanRepresentActor(
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
  // A HUMAN has no owner and is represented by nobody but an ADMIN.
  if (!subject || subject.actorKind === 'HUMAN' || subject.ownerId !== viewer.id) {
    throw createValidationError(ACTOR_MANAGE_FORBIDDEN_MESSAGE);
  }
}

/** Lifecycle (deactivate, transfer owner): the identity gate, nothing team-shaped. */
export async function assertCanManageActor(
  prisma: PrismaClient,
  context: GraphQLContext,
  subjectId: string,
): Promise<void> {
  await assertCanRepresentActor(prisma, context, subjectId);
}

/**
 * Revoking a credential is the one thing a team's OWNER may do to another
 * team's actor — and only for the credential bound to *their* team. An
 * unbound (legacy) credential belongs to nobody's team, so only the actor's
 * owner or an ADMIN may revoke it.
 */
export async function assertCanRevokeCredential(
  prisma: PrismaClient,
  context: GraphQLContext,
  credential: { teamId: string | null; userId: string },
): Promise<void> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }
  const viewer = context.viewer;
  if (!viewer || viewer.actorKind !== 'HUMAN') {
    throw createValidationError(TEAM_MANAGE_FORBIDDEN_MESSAGE);
  }
  const subject = await prisma.user.findUnique({ where: { id: credential.userId }, select: { ownerId: true } });
  if (subject?.ownerId === viewer.id) {
    return;
  }
  if (!credential.teamId) {
    throw createValidationError(TEAM_MANAGE_FORBIDDEN_MESSAGE);
  }
  await assertCanManageTeam(prisma, context, credential.teamId);
}

/**
 * A request is a resource on a work item on a team. Reading it in the inbox,
 * claiming it, answering it: each is authorized against that team like any
 * other access to the work item, so a credential bound to team B cannot see
 * or act on team A's requests even when both are addressed to the same actor.
 */
export async function assertCanActOnRequest(
  prisma: PrismaClient,
  context: GraphQLContext,
  requestId: string,
): Promise<void> {
  const request = await prisma.agentRequest.findUnique({
    where: { id: requestId },
    select: { work: { select: { teamId: true } } },
  });
  if (!request) {
    throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
  }
  await assertCanWriteTeam(prisma, context, request.work.teamId);
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
