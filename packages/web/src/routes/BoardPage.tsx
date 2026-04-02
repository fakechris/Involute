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

import {
  BOARD_PAGE_QUERY,
  COMMENT_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
} from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  CommentCreateMutationData,
  CommentCreateMutationVariables,
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
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { Column } from '../components/Column';
import { IssueCard } from '../components/IssueCard';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';

const ISSUE_LIMIT = 200;
const ERROR_MESSAGE = 'We could not save the issue changes. Please try again.';

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
  const [runCommentCreate] = useMutation<CommentCreateMutationData, CommentCreateMutationVariables>(
    COMMENT_CREATE_MUTATION,
  );
  const teams = data?.teams.nodes ?? [];
  const users = data?.users.nodes ?? [];
  const labels = data?.issueLabels.nodes ?? [];
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

  async function persistIssueUpdate(
    issue: IssueSummary,
    input: IssueUpdateMutationVariables['input'],
    applyOptimisticIssue: (current: IssueSummary) => IssueSummary,
  ) {
    const previousIssues = localIssues;
    const nextIssues = localIssues.map((item) => (item.id === issue.id ? applyOptimisticIssue(item) : item));

    setMutationError(null);
    setIsSavingState(true);
    setLocalIssues(nextIssues);

    try {
      const result = await runIssueUpdate({
        variables: {
          id: issue.id,
          input,
        },
      });

      if (!result.data?.issueUpdate.success || !result.data.issueUpdate.issue) {
        throw new Error('Mutation failed');
      }

      setLocalIssues((currentIssues) =>
        currentIssues.map((item) => (item.id === issue.id ? result.data!.issueUpdate.issue! : item)),
      );
    } catch (mutationIssue) {
      setLocalIssues(previousIssues);
      setMutationError(ERROR_MESSAGE);
      throw mutationIssue;
    } finally {
      setIsSavingState(false);
    }
  }

  async function persistStateChange(issue: IssueSummary, stateId: string) {
    const state = selectedTeam?.states.nodes.find((item) => item.id === stateId) ?? null;

    if (!state || issue.state.id === stateId) {
      return;
    }

    await persistIssueUpdate(issue, { stateId }, (current) => ({
      ...current,
      state,
    }));
  }

  async function persistTitleChange(issue: IssueSummary, title: string) {
    if (issue.title === title) {
      return;
    }

    await persistIssueUpdate(issue, { title }, (current) => ({
      ...current,
      title,
    }));
  }

  async function persistDescriptionChange(issue: IssueSummary, description: string) {
    if ((issue.description ?? '') === description) {
      return;
    }

    await persistIssueUpdate(issue, { description }, (current) => ({
      ...current,
      description,
    }));
  }

  async function persistLabelsChange(issue: IssueSummary, labelIds: string[]) {
    const nextLabels = labels.filter((label) => labelIds.includes(label.id));
    const currentLabelIds = issue.labels.nodes.map((label) => label.id).sort();
    const nextLabelIds = [...labelIds].sort();

    if (JSON.stringify(currentLabelIds) === JSON.stringify(nextLabelIds)) {
      return;
    }

    await persistIssueUpdate(issue, { labelIds }, (current) => ({
      ...current,
      labels: {
        nodes: nextLabels,
      },
    }));
  }

  async function persistAssigneeChange(issue: IssueSummary, assigneeId: string | null) {
    if ((issue.assignee?.id ?? null) === assigneeId) {
      return;
    }

    await persistIssueUpdate(issue, { assigneeId }, (current) => ({
      ...current,
      assignee: assigneeId ? users.find((user) => user.id === assigneeId) ?? null : null,
    }));
  }

  async function persistCommentCreate(issue: IssueSummary, body: string) {
    const trimmedBody = body.trim();

    if (!trimmedBody) {
      return;
    }

    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runCommentCreate({
        variables: {
          input: {
            issueId: issue.id,
            body: trimmedBody,
          },
        },
      });

      if (!result.data?.commentCreate.success || !result.data.commentCreate.comment) {
        throw new Error('Comment mutation failed');
      }

      setLocalIssues((currentIssues) =>
        currentIssues.map((item) =>
          item.id === issue.id
            ? {
                ...item,
                comments: {
                  nodes: [...item.comments.nodes, result.data!.commentCreate.comment!].sort(
                    (left, right) =>
                      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
                  ),
                },
              }
            : item,
        ),
      );
    } catch (mutationIssue) {
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
    const errorState = getBoardBootstrapErrorMessage(error);

    return (
      <main className="board-page board-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Board</h1>
          </div>
        </header>
        <section className="board-message board-message--error" role="alert">
          <h2>{errorState.title}</h2>
          <p>{errorState.description}</p>
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
        labels={labels}
        users={users}
        savingState={isSavingState}
        errorMessage={mutationError}
        onClose={() => setSelectedIssueId(null)}
        onStateChange={persistStateChange}
        onTitleSave={persistTitleChange}
        onDescriptionSave={persistDescriptionChange}
        onLabelsChange={persistLabelsChange}
        onAssigneeChange={persistAssigneeChange}
        onCommentCreate={persistCommentCreate}
      />
    </main>
  );
}
