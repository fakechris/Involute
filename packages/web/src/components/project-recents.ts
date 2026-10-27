/**
 * Recently used projects for the project quick pills (INV-1386).
 *
 * Each team keeps its own list in localStorage: newest first, de-duplicated
 * (case-insensitive), at most five entries. The pills show these projects and,
 * when fewer than five are known, fill up with the projects that have the most
 * issues.
 */
export const PROJECT_RECENTS_STORAGE_PREFIX = 'involute.projectRecents.';
export const MAX_PROJECT_RECENTS = 5;

/** Fields the pill picker needs; `AvailableProject` satisfies it. */
export interface PinnableProject {
  id: string;
  identifier: string;
  name: string;
  key: string;
  title?: string;
  issueCount: number;
}

export function projectRecentsStorageKey(teamKey: string | null): string {
  return `${PROJECT_RECENTS_STORAGE_PREFIX}${teamKey?.trim() || '__all__'}`;
}

export function readProjectRecents(teamKey: string | null): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(projectRecentsStorageKey(teamKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').slice(0, MAX_PROJECT_RECENTS);
  } catch {
    return [];
  }
}

/** Puts `projectName` first, drops older copies of it, keeps five. */
export function addProjectRecent(recents: readonly string[], projectName: string): string[] {
  const name = projectName.trim();
  if (!name) return [...recents];
  const lower = name.toLowerCase();
  return [name, ...recents.filter((entry) => entry.toLowerCase() !== lower)].slice(0, MAX_PROJECT_RECENTS);
}

export function recordProjectRecent(teamKey: string | null, projectName: string): string[] {
  const next = addProjectRecent(readProjectRecents(teamKey), projectName);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(projectRecentsStorageKey(teamKey), JSON.stringify(next));
    } catch {
      // Storage can be unavailable (private mode); the pills fall back to issue counts.
    }
  }
  return next;
}

/** Whether `value` names this project (by name, key, identifier or title). */
export function projectMatches(project: PinnableProject, value: string | null | undefined): boolean {
  if (!value) return false;
  const target = value.trim().toLowerCase();
  return (
    project.name.toLowerCase() === target ||
    project.key.toLowerCase() === target ||
    project.identifier.toLowerCase() === target ||
    Boolean(project.title && project.title.toLowerCase() === target)
  );
}

/**
 * The projects shown as pills: recents (newest first) that still exist, then
 * the projects with the most issues until there are five. The selected
 * project is not added here; the caller shows it separately when missing.
 */
export function pickPinnedProjects<T extends PinnableProject>(projects: readonly T[], recents: readonly string[]): T[] {
  const pinned: T[] = [];
  for (const recent of recents) {
    if (pinned.length >= MAX_PROJECT_RECENTS) break;
    const project = projects.find((candidate) => projectMatches(candidate, recent));
    if (project && !pinned.includes(project)) pinned.push(project);
  }
  if (pinned.length < MAX_PROJECT_RECENTS) {
    const byCount = projects
      .map((project, index) => ({ project, index }))
      .filter(({ project }) => !pinned.includes(project))
      .sort((a, b) => b.project.issueCount - a.project.issueCount || a.index - b.index);
    for (const { project } of byCount) {
      if (pinned.length >= MAX_PROJECT_RECENTS) break;
      pinned.push(project);
    }
  }
  return pinned;
}

/** "fakechris/Involute" → "Involute"; names without an owner stay whole. */
export function shortProjectName(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1) : name;
}
