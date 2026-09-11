export interface RecentViewEntry {
  path: string;
  label: string;
  at: number;
}

export const RECENT_VIEWS_STORAGE_KEY = 'involute.recentViews';
export const RECENT_VIEWS_CAP = 8;

const PATHNAME_LABELS: Record<string, string> = {
  '/': 'Board',
  '/backlog': 'Backlog',
  '/candidates': 'Candidates',
  '/in-review': 'In Review',
  '/bugs': 'Bugs',
  '/graph': 'Graph',
  '/inbox': 'Inbox',
  '/my-issues': 'My Issues',
  '/views': 'Views',
  '/projects': 'Projects',
  '/members': 'Members',
};

function shortProjectName(repository: string): string {
  const shortName = repository.split('/').pop()?.trim();
  return shortName || repository;
}

export function deriveViewLabel(pathname: string, search: string): string | null {
  let baseLabel = PATHNAME_LABELS[pathname];

  if (!baseLabel) {
    if (/^\/(issue|issues|work)\/[^/]+$/.test(pathname)) {
      baseLabel = 'Work';
    } else {
      return null;
    }
  }

  let label = baseLabel;
  const params = new URLSearchParams(search);

  const team = params.get('team');
  if (team) {
    label += ` · ${team}`;
  }

  const project = params.get('project');
  if (project && project !== 'all') {
    label += project === '__none__' ? ' · No project' : ` · ${shortProjectName(project)}`;
  }

  const issue = params.get('issue');
  if (issue) {
    label += ` · ${issue}`;
  }

  return label;
}

export function pushRecentView(
  list: RecentViewEntry[],
  entry: RecentViewEntry,
  cap: number = RECENT_VIEWS_CAP,
): RecentViewEntry[] {
  return [entry, ...list.filter((item) => item.path !== entry.path)].slice(0, cap);
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function isRecentViewEntry(value: unknown): value is RecentViewEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<RecentViewEntry>;
  return (
    typeof entry.path === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.at === 'number'
  );
}

export function readRecentViews(storage: StorageLike): RecentViewEntry[] {
  try {
    const raw = storage.getItem(RECENT_VIEWS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isRecentViewEntry).slice(0, RECENT_VIEWS_CAP);
  } catch {
    return [];
  }
}

export function writeRecentViews(storage: StorageLike, list: RecentViewEntry[]): void {
  try {
    storage.setItem(RECENT_VIEWS_STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_VIEWS_CAP)));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}
