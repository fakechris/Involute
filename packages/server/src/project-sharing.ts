import type { Prisma, PrismaClient, WorkShare, WorkShareRole } from '@prisma/client';

import { getContainsDescendantIds } from './graph-integrity.js';
import {
  ISSUE_NOT_FOUND_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
  WORK_SHARE_NOT_FOUND_MESSAGE,
  WORK_SHARE_NOT_PROJECT_MESSAGE,
  WORK_SHARE_SELF_MESSAGE,
  createNotFoundError,
  createValidationError,
} from './errors.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

/**
 * Project-level sharing (INV-832).
 *
 * Access in Involute is team-shaped: what you may read is the set of teams
 * you are on. That made "show one project to someone outside the team"
 * impossible without moving the project, and a project cannot move because
 * its issues carry the team's identifier prefix. So the PROJECT node itself
 * becomes a permission carrier: a share on it grants read or write over
 *
 *   - the node,
 *   - everything it CONTAINS (parentId and CONTAINS links, transitively),
 *   - the team's issues on the same repository, which is the board's notion
 *     of the project and predates the node.
 *
 * The scope is resolved once per request (see `resolveShareScope`) and
 * folded into the synchronous where-builders in access-control.
 */

export interface RepositoryScope {
  repository: string;
  teamId: string;
}

export interface ShareScope {
  /** Issue ids the viewer may read through a share. */
  issueIds: string[];
  /** Issue ids the viewer may write through an EDITOR share. */
  editableIssueIds: string[];
  /** (team, repository) pairs readable through a share. */
  repositories: RepositoryScope[];
  editableRepositories: RepositoryScope[];
  /** Teams that become visible (name, states) because a project in them is shared. */
  teamIds: string[];
}

export const EMPTY_SHARE_SCOPE: ShareScope = {
  editableIssueIds: [],
  editableRepositories: [],
  issueIds: [],
  repositories: [],
  teamIds: [],
};

export async function resolveShareScope(prisma: PrismaClient | Prisma.TransactionClient, userId: string): Promise<ShareScope> {
  const shares = await prisma.workShare.findMany({
    where: { userId },
    select: {
      role: true,
      work: { select: { id: true, kind: true, repository: true, teamId: true } },
    },
  });

  if (shares.length === 0) {
    return EMPTY_SHARE_SCOPE;
  }

  const scope: ShareScope = {
    editableIssueIds: [],
    editableRepositories: [],
    issueIds: [],
    repositories: [],
    teamIds: [],
  };

  for (const share of shares) {
    const root = share.work;
    const ids = [root.id, ...(await getContainsDescendantIds(prisma, root.id))];
    const repositories: RepositoryScope[] = root.repository
      ? [{ repository: root.repository, teamId: root.teamId }]
      : [];

    scope.issueIds.push(...ids);
    scope.repositories.push(...repositories);
    scope.teamIds.push(root.teamId);
    if (share.role === 'EDITOR') {
      scope.editableIssueIds.push(...ids);
      scope.editableRepositories.push(...repositories);
    }
  }

  return {
    editableIssueIds: [...new Set(scope.editableIssueIds)],
    editableRepositories: dedupeRepositories(scope.editableRepositories),
    issueIds: [...new Set(scope.issueIds)],
    repositories: dedupeRepositories(scope.repositories),
    teamIds: [...new Set(scope.teamIds)],
  };
}

function dedupeRepositories(entries: RepositoryScope[]): RepositoryScope[] {
  const seen = new Map<string, RepositoryScope>();
  for (const entry of entries) {
    seen.set(`${entry.teamId} ${entry.repository}`, entry);
  }
  return [...seen.values()];
}

/** A Prisma condition for "this issue is inside the shared scope", or null when there is no scope. */
export function shareScopeIssueWhere(
  scope: ShareScope,
  mode: 'read' | 'write',
): Prisma.IssueWhereInput | null {
  const ids = mode === 'read' ? scope.issueIds : scope.editableIssueIds;
  const repositories = mode === 'read' ? scope.repositories : scope.editableRepositories;

  if (ids.length === 0 && repositories.length === 0) {
    return null;
  }

  const clauses: Prisma.IssueWhereInput[] = [];
  if (ids.length > 0) {
    clauses.push({ id: { in: ids } });
  }
  for (const entry of repositories) {
    clauses.push({ repository: entry.repository, teamId: entry.teamId });
  }
  return clauses.length === 1 ? clauses[0]! : { OR: clauses };
}

export interface ShareInput {
  actor: WriteActor;
  role: WorkShareRole;
  userId: string;
  workId: string;
}

/**
 * Grant or change a share. Only PROJECT nodes can be shared: sharing a leaf
 * issue would be a per-issue ACL, and the board has no way to show one.
 */
export async function upsertWorkShare(prisma: PrismaClient, input: ShareInput): Promise<WorkShare> {
  const work = await prisma.issue.findUnique({ where: { id: input.workId } });
  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }
  if (work.kind !== 'PROJECT') {
    throw createValidationError(WORK_SHARE_NOT_PROJECT_MESSAGE);
  }
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, deactivatedAt: true, email: true, handle: true, name: true },
  });
  if (!user || user.deactivatedAt) {
    throw createNotFoundError(USER_NOT_FOUND_MESSAGE);
  }
  if (input.actor.actorId === user.id) {
    throw createValidationError(WORK_SHARE_SELF_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workShare.findUnique({
      where: { workId_userId: { userId: user.id, workId: work.id } },
    });
    const share = await tx.workShare.upsert({
      where: { workId_userId: { userId: user.id, workId: work.id } },
      create: {
        createdById: input.actor.actorId ?? null,
        role: input.role,
        userId: user.id,
        workId: work.id,
      },
      update: { role: input.role },
    });
    const who = user.handle ? `@${user.handle}` : user.name || user.email;
    await recordWorkAudit(tx, {
      actor: {
        ...input.actor,
        reason: existing
          ? `share for ${who} changed to ${input.role}`
          : `shared with ${who} as ${input.role}`,
      },
      after: selectIssueSnapshot(work),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
    return share;
  });
}

export async function removeWorkShare(
  prisma: PrismaClient,
  input: { actor: WriteActor; userId: string; workId: string },
): Promise<void> {
  const work = await prisma.issue.findUnique({ where: { id: input.workId } });
  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }
  const existing = await prisma.workShare.findUnique({
    where: { workId_userId: { userId: input.userId, workId: work.id } },
    include: { user: { select: { email: true, handle: true, name: true } } },
  });
  if (!existing) {
    throw createNotFoundError(WORK_SHARE_NOT_FOUND_MESSAGE);
  }

  await prisma.$transaction(async (tx) => {
    await tx.workShare.delete({ where: { id: existing.id } });
    const who = existing.user.handle ? `@${existing.user.handle}` : existing.user.name || existing.user.email;
    await recordWorkAudit(tx, {
      actor: { ...input.actor, reason: `share for ${who} removed` },
      after: selectIssueSnapshot(work),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
  });
}

export async function listWorkShares(prisma: PrismaClient, workId: string) {
  return prisma.workShare.findMany({
    where: { workId },
    include: { createdBy: true, user: true },
    orderBy: [{ createdAt: 'asc' }],
  });
}
