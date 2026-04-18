import type { IssueSummary, UserSummary } from './types';
import { readLocalStorageValue } from '../lib/storage';

export type BoardSortField = 'identifier' | 'title' | 'updatedAt' | 'createdAt';
export type BoardSortDirection = 'asc' | 'desc';

export interface BoardViewState {
  assigneeIds: string[];
  labelIds: string[];
  query: string;
  sortDirection: BoardSortDirection;
  sortField: BoardSortField;
  stateIds: string[];
}

export interface SavedBoardView {
  id: string;
  name: string;
  state: BoardViewState;
}

const DEFAULT_BOARD_VIEW_STATE: BoardViewState = {
  assigneeIds: [],
  labelIds: [],
  query: '',
  sortDirection: 'asc',
  sortField: 'updatedAt',
  stateIds: [],
};

function getBoardViewStateStorageKey(teamKey: string) {
  return `involute.board.viewState.${teamKey}`;
}

function getSavedBoardViewsStorageKey(teamKey: string) {
  return `involute.board.savedViews.${teamKey}`;
}

function isBoardSortField(value: unknown): value is BoardSortField {
  return value === 'identifier' || value === 'title' || value === 'updatedAt' || value === 'createdAt';
}

function isBoardSortDirection(value: unknown): value is BoardSortDirection {
  return value === 'asc' || value === 'desc';
}

function normalizeBoardViewState(value: unknown): BoardViewState {
  if (!value || typeof value !== 'object') {
    return DEFAULT_BOARD_VIEW_STATE;
  }

  const candidate = value as Partial<BoardViewState>;

  return {
    assigneeIds: Array.isArray(candidate.assigneeIds)
      ? candidate.assigneeIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    labelIds: Array.isArray(candidate.labelIds)
      ? candidate.labelIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    query: typeof candidate.query === 'string' ? candidate.query : '',
    sortDirection: isBoardSortDirection(candidate.sortDirection)
      ? candidate.sortDirection
      : DEFAULT_BOARD_VIEW_STATE.sortDirection,
    sortField: isBoardSortField(candidate.sortField)
      ? candidate.sortField
      : DEFAULT_BOARD_VIEW_STATE.sortField,
    stateIds: Array.isArray(candidate.stateIds)
      ? candidate.stateIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

function normalizeSavedBoardViews(value: unknown): SavedBoardView[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Partial<SavedBoardView>;

    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') {
      return [];
    }

    return [
      {
        id: candidate.id,
        name: candidate.name,
        state: normalizeBoardViewState(candidate.state),
      },
    ];
  });
}

export function getDefaultBoardViewState(): BoardViewState {
  return {
    ...DEFAULT_BOARD_VIEW_STATE,
  };
}

export function readStoredBoardViewState(teamKey: string | null): BoardViewState {
  if (typeof window === 'undefined' || !teamKey) {
    return getDefaultBoardViewState();
  }

  const rawValue = readLocalStorageValue(getBoardViewStateStorageKey(teamKey));

  if (!rawValue) {
    return getDefaultBoardViewState();
  }

  try {
    return normalizeBoardViewState(JSON.parse(rawValue));
  } catch {
    return getDefaultBoardViewState();
  }
}

export function writeStoredBoardViewState(teamKey: string | null, state: BoardViewState): void {
  if (typeof window === 'undefined' || !teamKey) {
    return;
  }

  try {
    window.localStorage.setItem(getBoardViewStateStorageKey(teamKey), JSON.stringify(state));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

export function readSavedBoardViews(teamKey: string | null): SavedBoardView[] {
  if (typeof window === 'undefined' || !teamKey) {
    return [];
  }

  const rawValue = readLocalStorageValue(getSavedBoardViewsStorageKey(teamKey));

  if (!rawValue) {
    return [];
  }

  try {
    return normalizeSavedBoardViews(JSON.parse(rawValue));
  } catch {
    return [];
  }
}

export function writeSavedBoardViews(teamKey: string | null, views: SavedBoardView[]): void {
  if (typeof window === 'undefined' || !teamKey) {
    return;
  }

  try {
    window.localStorage.setItem(getSavedBoardViewsStorageKey(teamKey), JSON.stringify(views));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

export function applyBoardViewState(
  issues: IssueSummary[],
  state: BoardViewState,
  users: UserSummary[],
): IssueSummary[] {
  const normalizedQuery = state.query.trim().toLowerCase();
  const usersById = new Map(users.map((user) => [user.id, user]));

  const nextIssues = issues.filter((issue) => {
    if (normalizedQuery) {
      const haystack = [issue.identifier, issue.title, issue.description ?? ''].join(' ').toLowerCase();

      if (!haystack.includes(normalizedQuery)) {
        return false;
      }
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

    if (state.stateIds.length > 0 && !state.stateIds.includes(issue.state.id)) {
      return false;
    }

    return true;
  });

  const direction = state.sortDirection === 'asc' ? 1 : -1;

  return [...nextIssues].sort((left, right) => {
    const comparison = compareIssuesForBoardSort(left, right, state.sortField, usersById);
    return comparison * direction;
  });
}

function compareIssuesForBoardSort(
  left: IssueSummary,
  right: IssueSummary,
  sortField: BoardSortField,
  _usersById: Map<string, UserSummary>,
): number {
  switch (sortField) {
    case 'title':
      return left.title.localeCompare(right.title);
    case 'createdAt':
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    case 'updatedAt':
      return new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
    case 'identifier':
    default:
      return left.identifier.localeCompare(right.identifier, undefined, {
        numeric: true,
      });
  }
}

export function buildBoardViewSummary(
  viewState: BoardViewState,
  team: { states: { nodes: Array<{ id: string; name: string }> } } | null,
  users: UserSummary[],
  labels: Array<{ id: string; name: string }>,
): string[] {
  const tokens: string[] = [];

  if (viewState.query.trim()) {
    tokens.push(`Query: ${viewState.query.trim()}`);
  }

  for (const assigneeId of viewState.assigneeIds) {
    if (assigneeId === 'unassigned') {
      tokens.push('Assignee: Unassigned');
      continue;
    }

    const user = users.find((candidate) => candidate.id === assigneeId);
    tokens.push(`Assignee: ${user?.name ?? user?.email ?? assigneeId}`);
  }

  for (const stateId of viewState.stateIds) {
    const stateName = team?.states.nodes.find((state) => state.id === stateId)?.name;
    tokens.push(`State: ${stateName ?? stateId}`);
  }

  for (const labelId of viewState.labelIds) {
    const labelName = labels.find((label) => label.id === labelId)?.name;
    tokens.push(`Label: ${labelName ?? labelId}`);
  }

  tokens.push(`Sort: ${viewState.sortField} (${viewState.sortDirection})`);

  return tokens;
}

export function createSavedBoardViewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `board-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
