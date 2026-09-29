import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_SHELL_TEAMS_EVENT, readStoredShellTeams, writeStoredShellTeams } from './app-shell-state';
import type { TeamSummary } from '../board/types';

const teams = [{ id: 'team-1', key: 'INV', name: 'Involute' }] as TeamSummary[];

describe('writeStoredShellTeams', () => {
  afterEach(() => window.localStorage.clear());

  it('announces a change once and stays quiet when the teams are unchanged (INV-859)', () => {
    const listener = vi.fn();
    window.addEventListener(APP_SHELL_TEAMS_EVENT, listener);
    try {
      writeStoredShellTeams(teams);
      writeStoredShellTeams([...teams]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(readStoredShellTeams().map((team) => team.key)).toEqual(['INV']);

      writeStoredShellTeams([...teams, { id: 'team-2', key: 'LUM', name: 'LumenBox' } as TeamSummary]);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(APP_SHELL_TEAMS_EVENT, listener);
    }
  });
});
