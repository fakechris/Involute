import type { IssueSummary, TeamSummary, UserSummary } from '../board/types';
import { readLocalStorageValue } from '../lib/storage';

export type BacklogSortField =
  | 'identifier'
  | 'title'
  | 'state'
  | 'assignee'
  | 'updatedAt'
  | 'createdAt';
export type BacklogSortDirection = 'asc' | 'desc';

export interface BacklogViewState {
  assigneeIds: string[];
  labelIds: string[];
  query: string;
  sortDirection: BacklogSortDirection;
  sortField: BacklogSortField;
  stateIds: string[];
}

export interface SavedBacklogView {
  id: string;
  name: string;
  state: BacklogViewState;
}

export interface ApplyBacklogViewDetail {
  state: BacklogViewState;
  viewId?: string;
}

export interface SavedBacklogViewsEventDetail {
  teamKey: string | null;
  views: SavedBacklogView[];
}

const DEFAULT_BACKLOG_VIEW_STATE: BacklogViewState = {
  assigneeIds: [],
  labelIds: [],
  query: '',
  sortDirection: 'asc',
  sortField: 'identifier',
  stateIds: [],
};

export const APPLY_BACKLOG_VIEW_EVENT = 'involute:apply-backlog-view';
export const BACKLOG_SAVED_VIEWS_EVENT = 'involute:backlog-saved-views';

function getBacklogViewStateStorageKey(teamKey: string) {
  return `involute.backlog.viewState.${teamKey}`;
}

function getSavedBacklogViewsStorageKey(teamKey: string) {
  return `involute.backlog.savedViews.${teamKey}`;
}

function isBacklogSortField(value: unknown): value is BacklogSortField {
  return (
    value === 'identifier' ||
    value === 'title' ||
    value === 'state' ||
    value === 'assignee' ||
    value === 'updatedAt' ||
    value === 'createdAt'
  );
}

function isBacklogSortDirection(value: unknown): value is BacklogSortDirection {
  return value === 'asc' || value === 'desc';
}

function normalizeBacklogViewState(value: unknown): BacklogViewState {
  if (!value || typeof value !== 'object') {
    return DEFAULT_BACKLOG_VIEW_STATE;
  }

  const candidate = value as Partial<BacklogViewState>;

  return {
    assigneeIds: Array.isArray(candidate.assigneeIds)
      ? candidate.assigneeIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    labelIds: Array.isArray(candidate.labelIds)
      ? candidate.labelIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    query: typeof candidate.query === 'string' ? candidate.query : '',
    sortDirection: isBacklogSortDirection(candidate.sortDirection)
      ? candidate.sortDirection
      : DEFAULT_BACKLOG_VIEW_STATE.sortDirection,
    sortField: isBacklogSortField(candidate.sortField)
      ? candidate.sortField
      : DEFAULT_BACKLOG_VIEW_STATE.sortField,
    stateIds: Array.isArray(candidate.stateIds)
      ? candidate.stateIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

function normalizeSavedBacklogViews(value: unknown): SavedBacklogView[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Partial<SavedBacklogView>;

    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') {
      return [];
    }

    return [
      {
        id: candidate.id,
        name: candidate.name,
        state: normalizeBacklogViewState(candidate.state),
      },
    ];
  });
}

export function getDefaultBacklogViewState(): BacklogViewState {
  return {
    ...DEFAULT_BACKLOG_VIEW_STATE,
  };
}

export function readStoredBacklogViewState(teamKey: string | null): BacklogViewState {
  if (typeof window === 'undefined' || !teamKey) {
    return getDefaultBacklogViewState();
  }

  const rawValue = readLocalStorageValue(getBacklogViewStateStorageKey(teamKey));

  if (!rawValue) {
    return getDefaultBacklogViewState();
  }

  try {
    return normalizeBacklogViewState(JSON.parse(rawValue));
  } catch {
    return getDefaultBacklogViewState();
  }
}

export function writeStoredBacklogViewState(teamKey: string | null, state: BacklogViewState): void {
  if (typeof window === 'undefined' || !teamKey) {
    return;
  }

  try {
    window.localStorage.setItem(
      getBacklogViewStateStorageKey(teamKey),
      JSON.stringify(state),
    );
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

export function readSavedBacklogViews(teamKey: string | null): SavedBacklogView[] {
  if (typeof window === 'undefined' || !teamKey) {
    return [];
  }

  const rawValue = readLocalStorageValue(getSavedBacklogViewsStorageKey(teamKey));

  if (!rawValue) {
    return [];
  }

  try {
    return normalizeSavedBacklogViews(JSON.parse(rawValue));
  } catch {
    return [];
  }
}

export function writeSavedBacklogViews(teamKey: string | null, views: SavedBacklogView[]): void {
  if (typeof window === 'undefined' || !teamKey) {
    return;
  }

  try {
    window.localStorage.setItem(
      getSavedBacklogViewsStorageKey(teamKey),
      JSON.stringify(views),
    );
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }

  window.dispatchEvent(
    new CustomEvent<SavedBacklogViewsEventDetail>(BACKLOG_SAVED_VIEWS_EVENT, {
      detail: {
        teamKey,
        views,
      },
    }),
  );
}

export function dispatchApplyBacklogView(detail: ApplyBacklogViewDetail): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<ApplyBacklogViewDetail>(APPLY_BACKLOG_VIEW_EVENT, {
      detail,
    }),
  );
}

export function applyBacklogViewState(
  issues: IssueSummary[],
  state: BacklogViewState,
  users: UserSummary[],
): IssueSummary[] {
  const normalizedQuery = state.query.trim().toLowerCase();
  const nextIssues = issues.filter((issue) => {
    if (normalizedQuery) {
      const haystack = [issue.identifier, issue.title, issue.description ?? ''].join(' ').toLowerCase();

      if (!haystack.includes(normalizedQuery)) {
        return false;
      }
    }

    if (state.stateIds.length > 0 && !state.stateIds.includes(issue.state.id)) {
      return false;
    }

    if (state.assigneeIds.length > 0) {
      const assigneeKey = issue.assignee?.id ?? 'unassigned';

      if (!state.assigneeIds.includes(assigneeKey)) {
        return false;
      }
    }

    if (state.labelIds.length > 0) {
      const issueLabelIds = issue.labels.nodes.map((label) => label.id);

      if (!state.labelIds.every((labelId) => issueLabelIds.includes(labelId))) {
        return false;
      }
    }

    return true;
  });

  const direction = state.sortDirection === 'asc' ? 1 : -1;
  const usersById = new Map(users.map((user) => [user.id, user]));

  return [...nextIssues].sort((left, right) => {
    const comparison = compareIssuesForBacklogSort(left, right, state.sortField, usersById);
    return comparison * direction;
  });
}

function compareIssuesForBacklogSort(
  left: IssueSummary,
  right: IssueSummary,
  sortField: BacklogSortField,
  usersById: Map<string, UserSummary>,
): number {
  switch (sortField) {
    case 'title':
      return left.title.localeCompare(right.title);
    case 'state':
      return left.state.name.localeCompare(right.state.name);
    case 'assignee': {
      const leftAssignee = getAssigneeSortValue(left, usersById);
      const rightAssignee = getAssigneeSortValue(right, usersById);
      return leftAssignee.localeCompare(rightAssignee);
    }
    case 'updatedAt':
      return new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
    case 'createdAt':
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    case 'identifier':
    default:
      return left.identifier.localeCompare(right.identifier, undefined, {
        numeric: true,
      });
  }
}

function getAssigneeSortValue(issue: IssueSummary, usersById: Map<string, UserSummary>): string {
  const assigneeId = issue.assignee?.id;

  if (!assigneeId) {
    return 'zzzz-unassigned';
  }

  const user = usersById.get(assigneeId) ?? issue.assignee;
  return user?.name ?? user?.email ?? assigneeId;
}

export function buildBacklogViewSummary(
  viewState: BacklogViewState,
  team: TeamSummary | null,
  users: UserSummary[],
  labels: Array<{ id: string; name: string }>,
): string[] {
  const tokens: string[] = [];

  if (viewState.query.trim()) {
    tokens.push(`Query: ${viewState.query.trim()}`);
  }

  for (const stateId of viewState.stateIds) {
    const stateName = team?.states.nodes.find((state) => state.id === stateId)?.name;
    tokens.push(`State: ${stateName ?? stateId}`);
  }

  for (const assigneeId of viewState.assigneeIds) {
    if (assigneeId === 'unassigned') {
      tokens.push('Assignee: Unassigned');
      continue;
    }

    const user = users.find((candidate) => candidate.id === assigneeId);
    tokens.push(`Assignee: ${user?.name ?? user?.email ?? assigneeId}`);
  }

  for (const labelId of viewState.labelIds) {
    const labelName = labels.find((label) => label.id === labelId)?.name;
    tokens.push(`Label: ${labelName ?? labelId}`);
  }

  tokens.push(
    `Sort: ${viewState.sortField} (${viewState.sortDirection})`,
  );

  return tokens;
}
