import type {
  Prisma,
  PrismaClient,
  TeamMembershipRole,
  TeamVisibility,
} from '@prisma/client';

import type { GraphQLContext } from './auth.js';
import {
  COMMENT_NOT_FOUND_MESSAGE,
  TEAM_MANAGE_FORBIDDEN_MESSAGE,
  TEAM_WRITE_FORBIDDEN_MESSAGE,
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
} from './errors.js';
const NEVER_MATCHING_UUID = '00000000-0000-0000-0000-000000000000';

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

  const membership = await prisma.team.findFirst({
    where: {
      id: teamId,
      OR: [
        { visibility: 'PUBLIC' },
        {
          memberships: {
            some: {
              userId: context.viewer.id,
            },
          },
        },
      ],
    },
    select: {
      id: true,
    },
  });

  if (!membership) {
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

  if (!context.viewer) {
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

  return {
    OR: [
      {
        id: context.viewer.id,
      },
      {
        memberships: {
          some: {
            team: {
              visibility: 'PUBLIC',
            },
          },
        },
      },
      {
        memberships: {
          some: {
            team: {
              memberships: {
                some: {
                  userId: context.viewer.id,
                },
              },
            },
          },
        },
      },
    ],
  };
}

function isEditorRole(role: MembershipRole): boolean {
  return role === 'EDITOR' || role === 'OWNER';
}
