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
  repository: string;
  identifier: string | null;
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
  if (input.last && input.projects.some((project) => project.repository === input.last!.repository && project.identifier)) {
    return { placement: input.last, source: 'last' };
  }
  return null;
}
