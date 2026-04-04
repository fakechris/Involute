import { BOARD_COLUMN_ORDER, type BoardColumnName } from './constants';
import type { IssueSummary, TeamSummary } from './types';
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

export function getBoardColumns(team: TeamSummary | null) {
  const stateIdByName = new Map<string, string>(
    (team?.states.nodes ?? []).map((state) => [state.name, state.id]),
  );

  return BOARD_COLUMN_ORDER.map((name) => ({
    name,
    stateId: stateIdByName.get(name) ?? name,
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
): Record<BoardColumnName, IssueSummary[]> {
  return BOARD_COLUMN_ORDER.reduce(
    (groups, stateName) => ({
      ...groups,
      [stateName]: issues.filter((issue) => issue.state.name === stateName),
    }),
    {
      Backlog: [],
      Ready: [],
      'In Progress': [],
      'In Review': [],
      Done: [],
      Canceled: [],
    } satisfies Record<BoardColumnName, IssueSummary[]>,
  );
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
