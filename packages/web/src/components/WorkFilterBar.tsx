import { useSearchParams } from 'react-router-dom';

/**
 * The filters a person reaches for when deciding a batch (INV-1077): type,
 * kind, priority, owner and text. Shared by /in-review and /candidates, kept
 * in the URL so a filtered list can be shared, and compiled to IQL so the
 * server does the filtering (pagination and "Select all" stay honest).
 */
export interface WorkFilters {
  type: '' | 'bug' | 'feature' | 'improvement' | 'research' | 'untyped';
  kind: '' | 'ISSUE' | 'MILESTONE' | 'EPIC' | 'DECISION' | 'PROJECT';
  priority: '' | '1' | '2' | '3' | '4' | '0';
  owner: '' | 'me' | 'none';
  q: string;
}

const KEYS = ['type', 'kind', 'priority', 'owner', 'q'] as const;
const TYPES = ['bug', 'feature', 'improvement', 'research'];

export function readWorkFilters(params: URLSearchParams): WorkFilters {
  const pick = <T extends string>(key: string, allowed: readonly string[]): T => {
    const value = (params.get(key) ?? '').trim();
    return (allowed.includes(value) ? value : '') as T;
  };
  return {
    type: pick('type', [...TYPES, 'untyped']),
    kind: pick('kind', ['ISSUE', 'MILESTONE', 'EPIC', 'DECISION', 'PROJECT']),
    priority: pick('priority', ['0', '1', '2', '3', '4']),
    owner: pick('owner', ['me', 'none']),
    q: (params.get('q') ?? '').trim(),
  };
}

export function hasWorkFilters(filters: WorkFilters): boolean {
  return KEYS.some((key) => filters[key] !== '');
}

/** IQL terms for the active filters; empty string when none are set. */
export function filtersToIql(filters: WorkFilters): string {
  const terms: string[] = [];
  if (filters.type === 'untyped') terms.push(`-label:${TYPES.join(',')}`);
  else if (filters.type) terms.push(`label:${filters.type}`);
  if (filters.kind) terms.push(`kind:${filters.kind}`);
  if (filters.priority) terms.push(`priority:${filters.priority}`);
  if (filters.owner) terms.push(`assignee:${filters.owner}`);
  if (filters.q) terms.push(`"${filters.q.replace(/"/g, '')}"`);
  return terms.join(' ');
}

/** Join IQL fragments, skipping empty ones. */
export function joinIql(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => (part ?? '').trim()).filter(Boolean).join(' ');
}

export function useWorkFilters(onChange?: () => void) {
  const [params, setParams] = useSearchParams();
  const filters = readWorkFilters(params);
  function setFilter<K extends keyof WorkFilters>(key: K, value: WorkFilters[K]) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
    onChange?.();
  }
  function clearFilters() {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const key of KEYS) next.delete(key);
      return next;
    });
    onChange?.();
  }
  return { filters, setFilter, clearFilters };
}

export function WorkFilterBar({
  filters,
  setFilter,
  clearFilters,
}: ReturnType<typeof useWorkFilters>) {
  return (
    <div className="work-filter-bar" role="group" aria-label="Filters">
      <select aria-label="Filter by type" value={filters.type} onChange={(event) => setFilter('type', event.target.value as WorkFilters['type'])}>
        <option value="">All types</option>
        <option value="bug">Bug</option>
        <option value="feature">Feature</option>
        <option value="improvement">Improvement</option>
        <option value="research">Research</option>
        <option value="untyped">No type</option>
      </select>
      <select aria-label="Filter by kind" value={filters.kind} onChange={(event) => setFilter('kind', event.target.value as WorkFilters['kind'])}>
        <option value="">All kinds</option>
        <option value="ISSUE">Issue</option>
        <option value="EPIC">Epic</option>
        <option value="MILESTONE">Milestone</option>
        <option value="DECISION">Decision</option>
        <option value="PROJECT">Project</option>
      </select>
      <select aria-label="Filter by priority" value={filters.priority} onChange={(event) => setFilter('priority', event.target.value as WorkFilters['priority'])}>
        <option value="">Any priority</option>
        <option value="1">Urgent</option>
        <option value="2">High</option>
        <option value="3">Medium</option>
        <option value="4">Low</option>
        <option value="0">No priority</option>
      </select>
      <select aria-label="Filter by owner" value={filters.owner} onChange={(event) => setFilter('owner', event.target.value as WorkFilters['owner'])}>
        <option value="">Any owner</option>
        <option value="me">Mine</option>
        <option value="none">Unassigned</option>
      </select>
      <input
        type="search"
        aria-label="Filter by text"
        placeholder="Search title or description"
        defaultValue={filters.q}
        key={filters.q}
        onKeyDown={(event) => {
          if (event.key === 'Enter') setFilter('q', (event.target as HTMLInputElement).value.trim());
        }}
        onBlur={(event) => {
          if (event.target.value.trim() !== filters.q) setFilter('q', event.target.value.trim());
        }}
      />
      {hasWorkFilters(filters) ? (
        <button type="button" className="work-filter-bar__clear" onClick={clearFilters}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
