import {
  closestCenter,
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import { BOARD_PAGE_QUERY, ISSUE_UPDATE_MUTATION } from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  IssueSummary,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
} from '../board/types';
import {
  filterIssuesByTeam,
  getBoardColumns,
  getInitialTeamKey,
  groupIssuesByState,
} from '../board/utils';
import { Column } from '../components/Column';
import { IssueCard } from '../components/IssueCard';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';

const ISSUE_LIMIT = 200;
const ERROR_MESSAGE = 'We could not save the state change. Please try again.';

export function BoardPage() {
  const { data, error, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(
    BOARD_PAGE_QUERY,
    {
      variables: {
        first: ISSUE_LIMIT,
      },
    },
  );
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(
    ISSUE_UPDATE_MUTATION,
  );
  const teams = data?.teams.nodes ?? [];
  const [selectedTeamKey, setSelectedTeamKey] = useState<string | null>(null);
  const [localIssues, setLocalIssues] = useState<IssueSummary[]>([]);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSavingState, setIsSavingState] = useState(false);

  useEffect(() => {
    if (!selectedTeamKey) {
      setSelectedTeamKey(getInitialTeamKey(teams));
    }
  }, [selectedTeamKey, teams]);

  useEffect(() => {
    setLocalIssues(data?.issues.nodes ?? []);
  }, [data?.issues.nodes]);

  const selectedTeam =
    teams.find((team) => team.key === selectedTeamKey) ?? teams[0] ?? null;
  const columns = useMemo(() => getBoardColumns(selectedTeam), [selectedTeam]);
  const visibleIssues = useMemo(
    () => filterIssuesByTeam(localIssues, selectedTeam?.key ?? null),
    [localIssues, selectedTeam?.key],
  );
  const issuesByState = useMemo(() => groupIssuesByState(visibleIssues), [visibleIssues]);
  const activeIssue = useMemo(
    () => visibleIssues.find((issue) => issue.id === activeIssueId) ?? null,
    [activeIssueId, visibleIssues],
  );
  const selectedIssue = useMemo(
    () => localIssues.find((issue) => issue.id === selectedIssueId) ?? null,
    [localIssues, selectedIssueId],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  async function persistStateChange(issue: IssueSummary, stateId: string) {
    const state = selectedTeam?.states.nodes.find((item) => item.id === stateId) ?? null;

    if (!state || issue.state.id === stateId) {
      return;
    }

    const previousIssues = localIssues;
    const nextIssues = localIssues.map((item) =>
      item.id === issue.id
        ? {
            ...item,
            state,
          }
        : item,
    );

    setMutationError(null);
    setIsSavingState(true);
    setLocalIssues(nextIssues);

    try {
      const result = await runIssueUpdate({
        variables: {
          id: issue.id,
          input: {
            stateId,
          },
        },
      });

      if (!result.data?.issueUpdate.success) {
        throw new Error('Mutation failed');
      }
    } catch (mutationIssue) {
      setLocalIssues(previousIssues);
      setMutationError(ERROR_MESSAGE);
      throw mutationIssue;
    } finally {
      setIsSavingState(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveIssueId(null);

    const issueId = String(event.active.id);
    const targetStateId = event.over ? String(event.over.id) : null;

    if (!targetStateId) {
      return;
    }

    const issue = localIssues.find((item) => item.id === issueId);

    if (!issue || issue.state.id === targetStateId) {
      return;
    }

    try {
      await persistStateChange(issue, targetStateId);
    } catch {
      // error state already handled
    }
  }

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

      {mutationError ? (
        <section className="board-message board-message--error" role="alert">
          <p>{mutationError}</p>
        </section>
      ) : null}

      {loading && !data ? (
        <section className="board-message" aria-live="polite">
          Loading board…
        </section>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(event) => {
            setActiveIssueId(String(event.active.id));
            setMutationError(null);
          }}
          onDragCancel={() => setActiveIssueId(null)}
          onDragEnd={(event) => void handleDragEnd(event)}
        >
          <section className="board-grid" aria-label="Kanban board">
            {columns.map((column) => (
              <Column
                key={column.name}
                title={column.name}
                stateId={column.stateId}
                issues={issuesByState[column.name]}
                onSelectIssue={(issue) => {
                  setMutationError(null);
                  setSelectedIssueId(issue.id);
                }}
              />
            ))}
          </section>

          <DragOverlay>
            {activeIssue ? <IssueCard issue={activeIssue} /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <IssueDetailDrawer
        issue={selectedIssue}
        team={selectedTeam}
        savingState={isSavingState}
        errorMessage={mutationError}
        onClose={() => setSelectedIssueId(null)}
        onStateChange={persistStateChange}
      />
    </main>
  );
}
