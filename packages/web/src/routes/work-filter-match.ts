import { useSearchParams } from 'react-router-dom';

import type { AvailableProject, ProjectFilterExtraOption } from '../components/ProjectFilterCombobox';
import type { WorkFilters } from '../components/WorkFilterBar';

/**
 * Client-side counterparts of the WorkFilterBar / project filter (INV-1314),
 * for pages that already hold their whole list (My Issues, Bugs, Incidents)
 * rather than asking the server with IQL. `project` is the repository, as on
 * /candidates and /in-review; `__none__` means "no repository".
 */

const TYPES = ['bug', 'feature', 'improvement', 'research'];

/** The combobox item for work with no repository (`project=__none__`). */
export const NO_REPOSITORY_OPTIONS: ReadonlyArray<ProjectFilterExtraOption> = [{ key: '__none__', label: 'No repository' }];

export interface FilterableWork {
  title: string;
  description?: string | null | undefined;
  kind?: string | undefined;
  priority?: number | undefined;
  repository?: string | null | undefined;
  labelNames?: string[] | undefined;
  /** null when unassigned; undefined when the page does not know the owner. */
  assigneeId?: string | null | undefined;
}

export function matchesProject(repository: string | null | undefined, project: string): boolean {
  if (!project) return true;
  if (project === '__none__') return !repository;
  return (repository ?? '').toLowerCase() === project.toLowerCase();
}

/** Filters a page cannot evaluate (no owner, no priority on the row) are skipped, not failed. */
export function matchesWorkFilters(item: FilterableWork, filters: WorkFilters, viewerId: string | null): boolean {
  if (filters.type) {
    const labels = (item.labelNames ?? []).map((name) => name.toLowerCase());
    if (filters.type === 'untyped' ? labels.some((name) => TYPES.includes(name)) : !labels.includes(filters.type)) return false;
  }
  if (filters.kind && (item.kind ?? 'ISSUE') !== filters.kind) return false;
  if (filters.priority && item.priority !== undefined && item.priority !== Number(filters.priority)) return false;
  if (filters.owner && item.assigneeId !== undefined) {
    if (filters.owner === 'none' && item.assigneeId !== null) return false;
    if (filters.owner === 'me' && (item.assigneeId === null || (viewerId !== null && item.assigneeId !== viewerId))) return false;
  }
  if (filters.q) {
    const text = `${item.title} ${item.description ?? ''}`.toLowerCase();
    if (!filters.q.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word))) return false;
  }
  return true;
}

/** The `project` URL parameter (a repository) and its setter. */
export function useProjectParam(): [string, (project: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  function setProject(next: string | null) {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      if (next) updated.set('project', next);
      else updated.delete('project');
      return updated;
    });
  }
  return [project, setProject];
}

/** Projects for the combobox from repository counts, largest first. */
export function projectsFromCounts(rows: ReadonlyArray<{ repository: string | null | undefined; count: number }>): AvailableProject[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.repository) continue;
    totals.set(row.repository, (totals.get(row.repository) ?? 0) + row.count);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([repository, count]) => ({
      id: repository,
      identifier: repository.includes('/') ? repository.split('/')[1]! : repository,
      name: repository,
      key: repository,
      title: repository,
      issueCount: count,
    }));
}
