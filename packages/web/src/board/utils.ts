import { BOARD_COLUMN_ORDER } from './constants';
import type { BoardColumn, Html5BoardDragPayload, IssueSummary, TeamSummary, WorkflowStateSummary } from './types';
import { readLocalStorageValue } from '../lib/storage';

export const ACTIVE_TEAM_STORAGE_KEY = 'involute.activeTeamKey';

export function readStoredTeamKey(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const storedTeamKey = readLocalStorageValue(ACTIVE_TEAM_STORAGE_KEY)?.trim();

  return storedTeamKey || null;
}

export function writeStoredTeamKey(teamKey: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (!teamKey) {
      window.localStorage.removeItem(ACTIVE_TEAM_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, teamKey);
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

export function parseHtml5BoardDragPayload(rawPayload: string): Html5BoardDragPayload | null {
  try {
    const payload = JSON.parse(rawPayload) as Partial<Html5BoardDragPayload>;

    if (typeof payload.issueId !== 'string' || typeof payload.stateId !== 'string') {
      return null;
    }

    return {
      issueId: payload.issueId,
      stateId: payload.stateId,
    };
  } catch {
    return null;
  }
}

export function createHtml5BoardDragPayload(issueId: string, stateId: string): string {
  return JSON.stringify({
    issueId,
    stateId,
  } satisfies Html5BoardDragPayload);
}

export function getBoardColumns(team: TeamSummary | null, issues: IssueSummary[] = []): BoardColumn[] {
  const statesById = new Map<string, WorkflowStateSummary>();

  for (const state of team?.states.nodes ?? []) {
    statesById.set(state.id, state);
  }

  for (const issue of issues) {
    if (!statesById.has(issue.state.id)) {
      statesById.set(issue.state.id, issue.state);
    }
  }

  return [...statesById.values()]
    .sort((left, right) => compareBoardStates(left.name, right.name))
    .map((state) => ({
      name: state.name,
      stateId: state.id,
    }));
}

export function filterIssuesByTeam(issues: IssueSummary[], teamKey: string | null): IssueSummary[] {
  if (!teamKey) {
    return issues;
  }

  return issues.filter((issue) => issue.team.key === teamKey);
}

export function groupIssuesByState(
  issues: IssueSummary[],
  columns: BoardColumn[],
): Record<string, IssueSummary[]> {
  const groups = Object.fromEntries(
    columns.map((column) => [column.stateId, [] as IssueSummary[]]),
  ) as Record<string, IssueSummary[]>;

  for (const issue of issues) {
    const stateId = issue.state.id;

    if (!groups[stateId]) {
      groups[stateId] = [];
    }

    groups[stateId].push(issue);
  }

  return groups;
}

export function getInitialTeamKey(teams: TeamSummary[]): string | null {
  return teams[0]?.key ?? null;
}

export function getStoredTeamKey(teams: TeamSummary[]): string | null {
  const storedTeamKey = readStoredTeamKey();

  if (!storedTeamKey) {
    return null;
  }

  return teams.some((team) => team.key === storedTeamKey) ? storedTeamKey : null;
}

function compareBoardStates(leftName: string, rightName: string): number {
  const defaultBoardOrder = BOARD_COLUMN_ORDER as readonly string[];
  const leftIndex = defaultBoardOrder.indexOf(leftName);
  const rightIndex = defaultBoardOrder.indexOf(rightName);
  const leftOrder = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
  const rightOrder = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return leftName.localeCompare(rightName);
}
