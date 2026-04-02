import { useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import { BOARD_PAGE_QUERY } from '../board/queries';
import type { BoardPageQueryData, BoardPageQueryVariables } from '../board/types';
import {
  filterIssuesByTeam,
  getBoardColumns,
  getInitialTeamKey,
  groupIssuesByState,
} from '../board/utils';
import { Column } from '../components/Column';

const ISSUE_LIMIT = 200;

export function BoardPage() {
  const { data, error, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(
    BOARD_PAGE_QUERY,
    {
      variables: {
        first: ISSUE_LIMIT,
      },
    },
  );
  const teams = data?.teams.nodes ?? [];
  const [selectedTeamKey, setSelectedTeamKey] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTeamKey) {
      setSelectedTeamKey(getInitialTeamKey(teams));
    }
  }, [selectedTeamKey, teams]);

  const selectedTeam =
    teams.find((team) => team.key === selectedTeamKey) ?? teams[0] ?? null;
  const columns = useMemo(() => getBoardColumns(selectedTeam), [selectedTeam]);
  const visibleIssues = useMemo(
    () => filterIssuesByTeam(data?.issues.nodes ?? [], selectedTeam?.key ?? null),
    [data?.issues.nodes, selectedTeam?.key],
  );
  const issuesByState = useMemo(() => groupIssuesByState(visibleIssues), [visibleIssues]);

  if (error) {
    return (
      <main className="board-page board-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Board</h1>
          </div>
        </header>
        <section className="board-message board-message--error" role="alert">
          <h2>Board unavailable</h2>
          <p>
            We could not load the board right now. Please confirm the API server is running and
            try again.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="board-page">
      <header className="app-shell__header">
        <div>
          <p className="app-shell__eyebrow">Involute</p>
          <h1>Board</h1>
          <p className="app-shell__subtext">
            Workflow overview for {selectedTeam?.name ?? 'your workspace'}.
          </p>
        </div>

        <div className="board-page__controls">
          {teams.length > 1 ? (
            <label className="team-selector">
              <span>Team</span>
              <select
                aria-label="Select team"
                value={selectedTeam?.key ?? ''}
                onChange={(event) => setSelectedTeamKey(event.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.key}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          ) : selectedTeam ? (
            <div className="team-selector team-selector--readonly">
              <span>Team</span>
              <strong>{selectedTeam.name}</strong>
            </div>
          ) : null}
        </div>
      </header>

      {loading && !data ? (
        <section className="board-message" aria-live="polite">
          Loading board…
        </section>
      ) : (
        <section className="board-grid" aria-label="Kanban board">
          {columns.map((column) => (
            <Column key={column.name} title={column.name} issues={issuesByState[column.name]} />
          ))}
        </section>
      )}
    </main>
  );
}
