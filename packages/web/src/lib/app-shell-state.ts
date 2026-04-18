import type { TeamSummary } from '../board/types';

export const APP_SHELL_TEAMS_STORAGE_KEY = 'involute.appShell.teams';
export const APP_SHELL_ISSUES_STORAGE_KEY = 'involute.appShell.issues';
export const APP_SHELL_TEAMS_EVENT = 'involute:app-shell-teams';
export const APP_SHELL_ISSUES_EVENT = 'involute:app-shell-issues';
const MAX_APP_SHELL_ISSUES = 40;

export interface AppShellTeamSummary {
  id: string;
  key: string;
  name: string;
}

export interface AppShellIssueSummary {
  id: string;
  identifier: string;
  stateName: string;
  teamKey: string;
  title: string;
}

function normalizeTeams(teams: TeamSummary[]): AppShellTeamSummary[] {
  return teams.map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
  }));
}

type WritableShellIssue = {
  id: string;
  identifier: string;
  title: string;
  state: {
    name: string;
  };
  team: {
    key: string;
  };
};

function normalizeIssues(issues: WritableShellIssue[]): AppShellIssueSummary[] {
  return issues.map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    stateName: issue.state.name,
    teamKey: issue.team.key,
    title: issue.title,
  }));
}

export function readStoredShellTeams(): AppShellTeamSummary[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(APP_SHELL_TEAMS_STORAGE_KEY);

    if (!rawValue) {
      return [];
    }

    const parsedValue = JSON.parse(rawValue) as AppShellTeamSummary[];

    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return parsedValue.filter((team) => {
      return (
        team &&
        typeof team.id === 'string' &&
        typeof team.key === 'string' &&
        typeof team.name === 'string'
      );
    });
  } catch {
    return [];
  }
}

export function writeStoredShellTeams(teams: TeamSummary[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedTeams = normalizeTeams(teams);

  try {
    window.localStorage.setItem(APP_SHELL_TEAMS_STORAGE_KEY, JSON.stringify(normalizedTeams));
  } catch {
    // Ignore storage failures in restricted environments.
  }

  window.dispatchEvent(
    new CustomEvent<AppShellTeamSummary[]>(APP_SHELL_TEAMS_EVENT, {
      detail: normalizedTeams,
    }),
  );
}

export function readStoredShellIssues(): AppShellIssueSummary[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(APP_SHELL_ISSUES_STORAGE_KEY);

    if (!rawValue) {
      return [];
    }

    const parsedValue = JSON.parse(rawValue) as AppShellIssueSummary[];

    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return parsedValue.filter((issue) => {
      return (
        issue &&
        typeof issue.id === 'string' &&
        typeof issue.identifier === 'string' &&
        typeof issue.stateName === 'string' &&
        typeof issue.teamKey === 'string' &&
        typeof issue.title === 'string'
      );
    });
  } catch {
    return [];
  }
}

export function writeStoredShellIssues(
  issues: WritableShellIssue[],
): void {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedIssues = normalizeIssues(issues);
  const nextIssues: AppShellIssueSummary[] = [
    ...normalizedIssues,
    ...readStoredShellIssues().filter(
      (existingIssue) => !normalizedIssues.some((issue) => issue.id === existingIssue.id),
    ),
  ].slice(0, MAX_APP_SHELL_ISSUES);

  try {
    window.localStorage.setItem(APP_SHELL_ISSUES_STORAGE_KEY, JSON.stringify(nextIssues));
  } catch {
    // Ignore storage failures in restricted environments.
  }

  window.dispatchEvent(
    new CustomEvent<AppShellIssueSummary[]>(APP_SHELL_ISSUES_EVENT, {
      detail: nextIssues,
    }),
  );
}

export function writeStoredShellIssue(issue: WritableShellIssue): void {
  writeStoredShellIssues([issue]);
}
