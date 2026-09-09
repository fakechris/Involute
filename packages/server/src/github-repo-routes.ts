// packages/server/src/github-repo-routes.ts
// Multi-repository routing configuration and identifier extraction.
// Maps incoming GitHub webhook events from multiple repositories to
// their corresponding Involute teams, root projects, and team key conventions.

export interface RepoRoute {
  repository: string;        // e.g. "fakechris/Involute" | "fakechris/lumenbox"
  teamKey: string;           // e.g. "INV" | "LUM"
  identifierPattern: RegExp; // e.g. /(?:^|[^A-Za-z])(?:INV|inv)-([0-9]+)/
  projectId?: string | undefined; // Default project UUID if configured
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

export function resolveIssueIdentifierFromPr(params: {
  branch: string;
  title: string;
  route: RepoRoute;
}): string | undefined {
  const branchIdentifiers = extractIssueIdentifiers(params.branch, params.route);
  if (branchIdentifiers.length > 0 && branchIdentifiers[0]) {
    return branchIdentifiers[0];
  }
  const titleIdentifiers = extractIssueIdentifiers(params.title, params.route);
  if (titleIdentifiers.length > 0 && titleIdentifiers[0]) {
    return titleIdentifiers[0];
  }
  return undefined;
}
