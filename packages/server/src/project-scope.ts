import type { Issue, Prisma, PrismaClient } from '@prisma/client';
import {
  createNotFoundError,
  createValidationError,
  PROJECT_SCOPE_AMBIGUOUS_MESSAGE,
  PROJECT_SCOPE_CONFLICT_MESSAGE,
  PROJECT_SCOPE_NOT_FOUND_MESSAGE,
} from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface ProjectScopeInput {
  projectId?: string | null;
  repository?: string | null;
  teamKey?: string | null;
}

export interface ResolvedProjectScope {
  rootId: string | null;
  repository: string | null;
  source: 'repository' | 'work-graph-repository' | 'work-graph-subtree' | 'legacy-project';
  where: Prisma.IssueWhereInput;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves project identity separately from the shared claimability predicates. */
export async function resolveProjectScope(
  prisma: DatabaseClient,
  input: ProjectScopeInput,
  readableWhere?: Prisma.IssueWhereInput,
): Promise<ResolvedProjectScope | null> {
  const projectId = input.projectId?.trim();
  const repository = input.repository?.trim();
  if ((input.projectId != null && !projectId) || (input.repository != null && !repository)) {
    throw createNotFoundError(PROJECT_SCOPE_NOT_FOUND_MESSAGE);
  }
  if (!projectId && !repository) return null;

  const visibility: Prisma.IssueWhereInput = {
    AND: [readableWhere ?? {}, input.teamKey ? { team: { key: input.teamKey } } : {}],
  };
  let root: Issue | null = null;

  if (projectId) {
    const isUuid = UUID.test(projectId);
    root = await prisma.issue.findFirst({
      where: { AND: [visibility, {
        ...(isUuid ? { id: projectId } : { identifier: projectId }),
        kind: 'PROJECT', commitmentStatus: { not: 'REJECTED' },
      }] },
    });
    // Project is a separate legacy model; do not confuse its UUID with Issue.projectId.
    const legacy = isUuid ? await prisma.project.findFirst({
      where: { id: projectId, AND: [
        input.teamKey ? { team: { key: input.teamKey } } : {},
        readableWhere?.team ? { team: readableWhere.team } : {},
      ] },
      select: { id: true, teamId: true },
    }) : null;
    if (root && legacy) throw createValidationError(PROJECT_SCOPE_AMBIGUOUS_MESSAGE);
    if (!root) {
      if (!legacy) throw createNotFoundError(PROJECT_SCOPE_NOT_FOUND_MESSAGE);
      return {
        rootId: null, repository: repository ?? null, source: 'legacy-project',
        where: { projectId: legacy.id, teamId: legacy.teamId, ...(repository ? { repository } : {}) },
      };
    }
    if (repository && root.repository && repository !== root.repository) {
      throw createValidationError(PROJECT_SCOPE_CONFLICT_MESSAGE);
    }
  }

  const declaredRepository = root?.repository ?? repository;
  if (declaredRepository && (!root || root.repository)) {
    const candidates = await prisma.issue.findMany({
      where: { AND: [visibility, {
        kind: 'PROJECT', repository: declaredRepository,
        commitmentStatus: { not: 'REJECTED' },
      }] },
    });
    const committed = candidates.filter(candidate => candidate.commitmentStatus === 'COMMITTED');
    const preferred = committed.length ? committed : candidates;
    if (preferred.length > 1) throw createValidationError(PROJECT_SCOPE_AMBIGUOUS_MESSAGE);
    const canonical = preferred[0];
    if (root?.repository && canonical && canonical.id !== root.id) {
      throw createValidationError(PROJECT_SCOPE_CONFLICT_MESSAGE);
    }
    if (!root) root = canonical ?? null;
  }

  if (root && !root.repository) {
    const descendantIds = await collectSubtree(prisma, root, visibility);
    return {
      rootId: root.id, repository: repository ?? null, source: 'work-graph-subtree',
      where: { id: { in: descendantIds }, teamId: root.teamId, ...(repository ? { repository } : {}) },
    };
  }

  if (!declaredRepository) throw createNotFoundError(PROJECT_SCOPE_NOT_FOUND_MESSAGE);

  // A repository declaration remains discoverable even before hierarchy repair.
  // Resolving scope never rewrites parentId, WorkLink or repository data.
  return {
    rootId: root?.id ?? null,
    repository: declaredRepository ?? null,
    source: root ? 'work-graph-repository' : 'repository',
    where: { repository: declaredRepository, ...(root ? { teamId: root.teamId } : {}) },
  };
}

async function collectSubtree(
  prisma: DatabaseClient,
  root: Issue,
  visibility: Prisma.IssueWhereInput,
): Promise<string[]> {
  const visited = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length) {
    const children = await prisma.issue.findMany({
      where: { AND: [visibility, {
        teamId: root.teamId,
        OR: [
          { parentId: { in: frontier } },
          { incomingLinks: { some: { type: 'CONTAINS', fromId: { in: frontier } } } },
        ],
      }] },
      select: { id: true },
    });
    frontier = children.map(child => child.id).filter(id => !visited.has(id));
    for (const id of frontier) visited.add(id);
  }
  return [...visited];
}
