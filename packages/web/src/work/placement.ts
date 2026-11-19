/**
 * Where new work goes (INV-744). Created work needs a parent: its project
 * ("No milestone", addressed by the project identifier), a milestone or epic,
 * or a parent issue. The server accepts an id or an identifier.
 */
export interface CreatePlacement {
  repository: string;
  parentId: string;
  /** Shown when the parent is not one of the project's containers (a sub-issue's parent). */
  parentLabel?: string;
}

/** Why the picker starts where it does; "last" is labelled "Last used". */
export type PlacementSource = 'context' | 'board' | 'last';

export interface PlaceableProject {
  /** Null for a project with no GitHub repository (INV-1918); it still takes new work. */
  repository: string | null;
  identifier: string | null;
}

/**
 * Every project new work may go under: those with a repository from
 * projectSummary.projects, then those without one (INV-1918).
 */
export function placementProjects(
  summary:
    | {
        projects?: Array<PlaceableProject & { name: string }> | null;
        projectsWithoutRepository?: Array<{ identifier: string; name: string }> | null;
      }
    | null
    | undefined,
): Array<PlaceableProject & { name: string }> {
  return [
    ...(summary?.projects ?? []),
    ...(summary?.projectsWithoutRepository ?? []).map((project) => ({
      repository: null,
      identifier: project.identifier,
      name: project.name,
    })),
  ];
}

/** The picker's value for a project: its repository, or its identifier when it has none. */
export function placementProjectKey(project: PlaceableProject): string {
  return project.repository || `project:${project.identifier ?? ''}`;
}

/** The project a placement is in. Without a repository, only directly under the project is known. */
export function findPlacementProject<T extends PlaceableProject>(projects: T[], placement: CreatePlacement | null): T | undefined {
  if (!placement) return undefined;
  if (placement.repository) return projects.find((project) => project.repository === placement.repository && project.identifier);
  return projects.find((project) => !project.repository && project.identifier === placement.parentId);
}

/** Directly under the project, shown as "No milestone". */
export function projectPlacement(project: PlaceableProject | undefined): CreatePlacement | null {
  return project?.identifier ? { repository: project.repository ?? '', parentId: project.identifier } : null;
}

const STORAGE_PREFIX = 'involute.createPlacement.';

export function readLastPlacement(teamKey: string): CreatePlacement | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + teamKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CreatePlacement>;
    return typeof parsed.repository === 'string' && typeof parsed.parentId === 'string'
      ? { repository: parsed.repository, parentId: parsed.parentId }
      : null;
  } catch {
    return null;
  }
}

/** Remembers the project and location, not a sub-issue parent, which is one-off context. */
export function rememberPlacement(teamKey: string, placement: CreatePlacement): void {
  if (placement.parentLabel) return;
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + teamKey,
      JSON.stringify({ repository: placement.repository, parentId: placement.parentId }),
    );
  } catch {
    // Ignore storage failures; the picker just starts empty next time.
  }
}

/**
 * New work under an existing item — a sub-issue of an issue, or work in a
 * milestone, epic or project. Null where nothing may be contained (DECISION)
 * or the item has no repository to place it in.
 */
export function childPlacement(parent: {
  id: string;
  identifier: string;
  title: string;
  kind?: string | null;
  repository?: string | null;
}): CreatePlacement | null {
  if (!parent.repository || parent.kind === 'DECISION') return null;
  const isIssue = !parent.kind || parent.kind === 'ISSUE';
  return {
    repository: parent.repository,
    parentId: parent.id,
    ...(isIssue ? { parentLabel: `Sub-issue of ${parent.identifier} — ${parent.title}` } : {}),
  };
}

/** The project's own placement: directly under it, shown as "No milestone". */
export function noMilestonePlacement(projects: PlaceableProject[], repository: string): CreatePlacement | null {
  const project = projects.find((candidate) => candidate.repository === repository && candidate.identifier);
  return project?.identifier ? { repository, parentId: project.identifier } : null;
}

/**
 * The first placement that applies, like Linear: the entry point's own context
 * (sub-issue, milestone row), then the board's project filter, then this
 * person's last choice on the team. Only projects that exist are offered.
 */
export function resolveInitialPlacement(input: {
  context?: CreatePlacement | null;
  boardRepository?: string | null;
  last?: CreatePlacement | null;
  projects: PlaceableProject[];
}): { placement: CreatePlacement; source: PlacementSource } | null {
  if (input.context) return { placement: input.context, source: 'context' };
  if (input.boardRepository) {
    const board = noMilestonePlacement(input.projects, input.boardRepository);
    if (board) return { placement: board, source: 'board' };
  }
  if (input.last && findPlacementProject(input.projects, input.last)) {
    return { placement: input.last, source: 'last' };
  }
  return null;
}
