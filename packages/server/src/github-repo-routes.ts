// packages/server/src/github-repo-routes.ts
// Multi-repository routing configuration and identifier extraction.
// Maps incoming GitHub webhook events from multiple repositories to
// their corresponding Involute teams, root projects, and team key conventions.
//
// INV-459: routing is primarily derived from the work graph — PROJECT-kind
// Issue nodes with a `repository` field own their repo; their optional
// `alias` adds a second accepted reference prefix (e.g. LUM-398 on the
// lumenbox project canonicalizes to INV-398). The static/env list below
// remains as fallback for repos without a PROJECT node.

import type { PrismaClient } from '@prisma/client';

export interface RepoRoute {
  repository: string;        // e.g. "fakechris/Involute" | "fakechris/lumenbox"
  teamKey: string;           // e.g. "INV" | "LUM"
  identifierPattern: RegExp; // e.g. /(?:^|[^A-Za-z])(?:INV|inv)-([0-9]+)/
  projectId?: string | undefined; // Default project UUID if configured
  alias?: string | undefined;     // INV-459: extra accepted reference prefix
}

export const DEFAULT_REPO_ROUTES: readonly RepoRoute[] = [
  {
    repository: 'fakechris/Involute',
    teamKey: 'INV',
    // Word boundary anchored: matches INV-123 or inv-123, prevents false match on SPINV-123
    identifierPattern: /(?:^|[^A-Za-z])((?:INV|inv)-[0-9]+)/,
    projectId: process.env.INVOLUTE_ROOT_PROJECT_ID,
  },
  {
    repository: 'fakechris/lumenbox',
    teamKey: 'LUM',
    identifierPattern: /(?:^|[^A-Za-z])((?:LUM|lum)-[0-9]+)/,
    projectId: process.env.LUMENBOX_ROOT_PROJECT_ID,
  },
];

let customRepoRoutes: RepoRoute[] | null = null;

export function setCustomRepoRoutes(routes: RepoRoute[] | null): void {
  customRepoRoutes = routes;
}

export function getRepoRoutes(): readonly RepoRoute[] {
  if (customRepoRoutes) {
    return customRepoRoutes;
  }
  const envRoutes = process.env.GITHUB_REPO_ROUTES;
  if (envRoutes) {
    try {
      const parsed = JSON.parse(envRoutes) as Array<{
        repository: string;
        teamKey: string;
        identifierPrefix?: string;
        projectId?: string;
      }>;
      return parsed.map((item) => ({
        repository: item.repository,
        teamKey: item.teamKey,
        identifierPattern: new RegExp(
          `(?:^|[^A-Za-z])((?:${item.identifierPrefix ?? item.teamKey})-[0-9]+)`,
          'i',
        ),
        projectId: item.projectId,
      }));
    } catch {
      // Fallback to defaults on parse error
    }
  }
  return DEFAULT_REPO_ROUTES;
}

export function findRepoRoute(repository: string): RepoRoute | undefined {
  const routes = getRepoRoutes();
  const normalizedRepo = repository.toLowerCase().trim();
  return routes.find((r) => r.repository.toLowerCase().trim() === normalizedRepo);
}

/**
 * Build a word-boundary identifier pattern accepting every prefix in the set
 * (team key plus optional project alias). Case-insensitive: callers compile
 * with 'gi' and uppercase matches anyway.
 */
export function buildIdentifierPattern(prefixes: readonly string[]): RegExp {
  const escaped = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:^|[^A-Za-z])((?:${escaped.join('|')})-[0-9]+)`, 'i');
}

export function extractIssueIdentifiers(text: string, route: RepoRoute): string[] {
  if (!text) return [];
  const results: string[] = [];
  const globalPattern = new RegExp(route.identifierPattern.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = globalPattern.exec(text)) !== null) {
    if (match[1]) {
      results.push(match[1].toUpperCase());
    }
  }
  return results;
}

export interface CanonicalIssueRef {
  /** Canonical identifier: alias prefixes are rewritten to the team key. */
  identifier: string;
  /** True when the reference used the route's project alias prefix. */
  viaAlias: boolean;
}

/**
 * Resolve the canonical issue reference for a PR. Alias semantics: when the
 * matched prefix equals the route's alias (and differs from the team key),
 * `LUM-398` canonicalizes to `INV-398` with viaAlias — an assertion that the
 * issue belongs to the aliased project, verified by the caller.
 */
function canonicalizeIdentifier(rawIdentifier: string, route: RepoRoute): CanonicalIssueRef {
  const uppercased = rawIdentifier.toUpperCase();
  const dashIndex = uppercased.indexOf('-');
  const prefix = dashIndex === -1 ? uppercased : uppercased.slice(0, dashIndex);
  const number = dashIndex === -1 ? '' : uppercased.slice(dashIndex + 1);
  const teamKey = route.teamKey.toUpperCase();

  if (prefix !== teamKey && route.alias && prefix === route.alias.toUpperCase()) {
    return { identifier: `${teamKey}-${number}`, viaAlias: true };
  }
  return { identifier: uppercased, viaAlias: false };
}

export function resolveCanonicalIssueRef(params: {
  branch: string;
  title: string;
  route: RepoRoute;
}): CanonicalIssueRef | undefined {
  const branchIdentifiers = extractIssueIdentifiers(params.branch, params.route);
  if (branchIdentifiers.length > 0 && branchIdentifiers[0]) {
    return canonicalizeIdentifier(branchIdentifiers[0], params.route);
  }
  const titleIdentifiers = extractIssueIdentifiers(params.title, params.route);
  if (titleIdentifiers.length > 0 && titleIdentifiers[0]) {
    return canonicalizeIdentifier(titleIdentifiers[0], params.route);
  }
  return undefined;
}

export function resolveIssueIdentifierFromPr(params: {
  branch: string;
  title: string;
  route: RepoRoute;
}): string | undefined {
  return resolveCanonicalIssueRef(params)?.identifier;
}

type ProjectRouteSource = {
  id: string;
  alias: string | null;
  repository: string;
  team: { key: string };
};

function buildRouteFromProject(project: ProjectRouteSource): RepoRoute {
  const prefixes = [project.team.key, ...(project.alias ? [project.alias] : [])];
  return {
    repository: project.repository,
    teamKey: project.team.key,
    identifierPattern: buildIdentifierPattern(prefixes),
    projectId: project.id,
    ...(project.alias ? { alias: project.alias } : {}),
  };
}

const PROJECT_ROUTE_INCLUDE = { team: { select: { key: true } } } as const;

/**
 * Graph-derived route lookup: a PROJECT-kind, non-REJECTED issue owning the
 * repository wins; otherwise fall back to the static/env route list so repos
 * without a PROJECT node (and the setCustomRepoRoutes test hook) keep working.
 */
export async function resolveRepoRoute(
  prisma: Pick<PrismaClient, 'issue'>,
  repository: string,
): Promise<RepoRoute | null> {
  const repositoryWhere = {
    kind: 'PROJECT' as const,
    repository: { equals: repository.trim(), mode: 'insensitive' as const },
  };
  const project =
    (await prisma.issue.findFirst({
      where: { ...repositoryWhere, commitmentStatus: 'COMMITTED' },
      include: PROJECT_ROUTE_INCLUDE,
    })) ??
    (await prisma.issue.findFirst({
      where: { ...repositoryWhere, commitmentStatus: { not: 'REJECTED' as const } },
      include: PROJECT_ROUTE_INCLUDE,
    }));

  if (project?.repository) {
    return buildRouteFromProject({
      id: project.id,
      alias: project.alias,
      repository: project.repository,
      team: project.team,
    });
  }

  return findRepoRoute(repository) ?? null;
}

/**
 * Every route the system should reconcile/audit: graph-derived routes for all
 * PROJECT nodes with a repository, unioned with the static/env fallback list
 * and deduped by repository (graph wins).
 */
export async function listAllRepoRoutes(prisma: PrismaClient): Promise<RepoRoute[]> {
  const projects = await prisma.issue.findMany({
    where: {
      kind: 'PROJECT',
      commitmentStatus: { not: 'REJECTED' },
      repository: { not: null },
    },
    include: PROJECT_ROUTE_INCLUDE,
  });

  const routes = new Map<string, RepoRoute>();
  for (const project of projects) {
    if (!project.repository) {
      continue;
    }
    routes.set(
      project.repository.toLowerCase().trim(),
      buildRouteFromProject({
        id: project.id,
        alias: project.alias,
        repository: project.repository,
        team: project.team,
      }),
    );
  }
  for (const fallback of getRepoRoutes()) {
    const key = fallback.repository.toLowerCase().trim();
    if (!routes.has(key)) {
      routes.set(key, fallback);
    }
  }
  return [...routes.values()];
}
