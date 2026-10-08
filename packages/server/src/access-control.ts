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
  createNotAuthenticatedError,
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  TEAM_ARCHIVED_MESSAGE,
} from './errors.js';
import { EMPTY_SHARE_SCOPE, shareScopeIssueWhere, type ShareScope } from './project-sharing.js';

function shareScopeOf(context: GraphQLContext): ShareScope {
  return context.shareScope ?? EMPTY_SHARE_SCOPE;
}

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

  // A team with a shared project in it becomes visible (name, key, states)
  // so the board can render the project; its roster stays behind
  // canManageTeamMemberships, and nothing else in it is readable (INV-832).
  const sharedTeams: Prisma.TeamWhereInput[] =
    shareScopeOf(context).teamIds.length > 0 ? [{ id: { in: shareScopeOf(context).teamIds } }] : [];

  if (isAgentRequest(context)) {
    const teamId = boundTeamId(context);
    return {
      OR: [
        { visibility: 'PUBLIC' satisfies Visibility },
        { id: teamId ?? NEVER_MATCHING_UUID },
        ...sharedTeams,
      ],
    };
  }

  // Guests never see public teams by being in the workspace; only the teams
  // they were added to and what was shared with them (docs/permissions.md §2).
  const publicTeams: Prisma.TeamWhereInput[] =
    context.viewer.globalRole === 'GUEST' ? [] : [{ visibility: 'PUBLIC' satisfies Visibility }];

  return {
    OR: [
      ...publicTeams,
      {
        memberships: {
          some: {
            userId: context.viewer.id,
          },
        },
      },
      ...sharedTeams,
    ],
  };
}

export function buildReadableIssueWhere(context: GraphQLContext): Prisma.IssueWhereInput | undefined {
  const readableTeamWhere = buildMemberTeamWhere(context);

  if (!readableTeamWhere) {
    return undefined;
  }

  // Readable = in a team you are on, or inside a project shared with you.
  const shared = shareScopeIssueWhere(shareScopeOf(context), 'read');
  return shared ? { OR: [{ team: readableTeamWhere }, shared] } : { team: readableTeamWhere };
}

/**
 * The team-shaped part of readability alone: membership, binding or PUBLIC,
 * without the teams that are visible only because a project in them is
 * shared. Issues in those teams are readable through the share scope, not
 * through the team.
 */
function buildMemberTeamWhere(context: GraphQLContext): Prisma.TeamWhereInput | undefined {
  const where = buildReadableTeamWhere(context);
  if (!where || shareScopeOf(context).teamIds.length === 0) {
    return where;
  }
  return {
    OR: (where.OR ?? []).filter((clause) => !('id' in clause && typeof clause.id === 'object' && clause.id !== null && 'in' in clause.id)),
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

/** Archived teams are read-only for everyone, admins included (docs/permissions.md §5). */
export async function assertTeamNotArchived(prisma: PrismaClient, teamId: string): Promise<void> {
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { archivedAt: true } });
  if (team?.archivedAt) throw createValidationError(TEAM_ARCHIVED_MESSAGE);
}

/**
 * Who may see a team's roster with roles: its members, admins, and — for a
 * public team — any workspace member who could join it. Not share holders,
 * not guests outside the team (docs/permissions.md §3).
 */
export async function canSeeTeamRoster(prisma: PrismaClient, context: GraphQLContext, teamId: string): Promise<boolean> {
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') return true;
  const viewer = context.viewer;
  if (!viewer || viewer.actorKind !== 'HUMAN') return false;
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { visibility: true, memberships: { where: { userId: viewer.id }, select: { id: true } } },
  });
  if (!team) return false;
  if (team.memberships.length > 0) return true;
  return team.visibility === 'PUBLIC' && viewer.globalRole !== 'GUEST';
}

export async function assertCanWriteTeam(
  prisma: PrismaClient,
  context: GraphQLContext,
  teamId: string,
): Promise<void> {
  await assertTeamNotArchived(prisma, teamId);
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }

  if (!context.viewer) {
    // No one is signed in (an expired session, a token without a viewer):
    // say that, rather than blaming team rights the person may well have.
    throw createNotAuthenticatedError();
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

  if (await isInShareScope(prisma, context, issueId, 'read')) {
    return;
  }

  // Not through a share: then only membership, binding or PUBLIC counts. A
  // team that is visible merely because a project in it is shared does not
  // make its other issues readable.
  if (context.isTrustedSystem || context.viewer?.globalRole === 'ADMIN') {
    return;
  }
  const memberWhere = buildMemberTeamWhere(context);
  const readable = memberWhere
    ? await prisma.team.findFirst({ where: { id: issue.teamId, ...memberWhere }, select: { id: true } })
    : { id: issue.teamId };
  if (!readable) {
    throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  }
}

async function isInShareScope(
  prisma: PrismaClient,
  context: GraphQLContext,
  issueId: string,
  mode: 'read' | 'write',
): Promise<boolean> {
  const shared = shareScopeIssueWhere(shareScopeOf(context), mode);
  if (!shared) {
    return false;
  }
  const hit = await prisma.issue.findFirst({ where: { AND: [{ id: issueId }, shared] }, select: { id: true } });
  return hit !== null;
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

  // An EDITOR share is a write grant over exactly the shared scope (INV-832).
  if (await isInShareScope(prisma, context, issueId, 'write')) {
    await assertTeamNotArchived(prisma, issue.teamId);
    return;
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
    : context.viewer.globalRole === 'GUEST'
      ? { memberships: { some: { userId: context.viewer.id } } }
      : { OR: [{ visibility: 'PUBLIC' }, { memberships: { some: { userId: context.viewer.id } } }] };

  return {
    OR: [
      { id: context.viewer.id },
      // actors this viewer is accountable for, wherever they are bound
      { ownerId: context.viewer.id },
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
