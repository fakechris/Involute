import { useQuery } from '@apollo/client/react';
import { useEffect } from 'react';

import { SHELL_TEAMS_QUERY } from '../board/queries';
import type { TeamSummary } from '../board/types';
import { writeStoredShellTeams } from '../lib/app-shell-state';

/**
 * Keeps the sidebar's Teams section filled for a signed-in person. It used to
 * be written only by the board, so a browser that had not opened the board
 * showed no teams — and no way to reach a team's Members or Settings.
 */
export function ShellTeamsSync() {
  const { data } = useQuery<{ teams: { nodes: TeamSummary[] } }>(SHELL_TEAMS_QUERY, { fetchPolicy: 'cache-and-network' });
  useEffect(() => {
    if (data?.teams.nodes) writeStoredShellTeams(data.teams.nodes);
  }, [data]);
  return null;
}
