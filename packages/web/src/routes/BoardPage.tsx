import {
  closestCorners,
  DndContext,
  type DragOverEvent,
  DragEndEvent,
  DragOverlay,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery } from '@apollo/client/react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import {
  BOARD_PAGE_QUERY,
  COMMENT_CREATE_MUTATION,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
} from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  CommentCreateMutationData,
  CommentCreateMutationVariables,
  Html5BoardDragPayload,
  IssueCreateMutationData,
  IssueCreateMutationVariables,
  IssueSummary,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
} from '../board/types';
import {
  ACTIVE_TEAM_STORAGE_KEY,
  filterIssuesByTeam,
  getBoardColumns,
  getInitialTeamKey,
  getStoredTeamKey,
  readStoredTeamKey,
  groupIssuesByState,
  writeStoredTeamKey,
} from '../board/utils';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { Column } from '../components/Column';
import { IssueCard } from '../components/IssueCard';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';
import { BacklogPage } from './BacklogPage';

const ISSUE_LIMIT = 200;
const ERROR_MESSAGE = 'We could not save the issue changes. Please try again.';
const DND_ACTIVATION_DISTANCE = 1;
const EMPTY_ISSUES: IssueSummary[] = [];

function getStateIdFromData(data: unknown): string | null {
  if (data && typeof data === 'object' && 'stateId' in data && typeof data.stateId === 'string') {
    return data.stateId;
  }

  return null;
}

function getDropTargetStateId(
  event: Pick<DragEndEvent, 'over'> | Pick<DragOverEvent, 'over'>,
): string | null {
  const overData = event.over?.data.current;
  const explicitStateId = getStateIdFromData(overData);

  if (explicitStateId) {
    return explicitStateId;
  }

  return event.over ? String(event.over.id) : null;
}

function moveIssueToState(
  issues: IssueSummary[],
  issueId: string,
  state: IssueSummary['state'],
): IssueSummary[] {
  return issues.map((item) => (item.id === issueId ? { ...item, state } : item));
}

function parseHtml5DragPayload(rawPayload: string): Html5BoardDragPayload | null {
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

function createHtml5BoardDragPayload(issueId: string, stateId: string): string {
  return JSON.stringify({
    issueId,
    stateId,
  } satisfies Html5BoardDragPayload);
}

export function BoardPage() {
  const [selectedTeamKey, setSelectedTeamKey] = useState<string | null>(() => readStoredTeamKey());
  const boardQueryVariables = useMemo<BoardPageQueryVariables>(
    () => ({
      first: ISSUE_LIMIT,
      ...(selectedTeamKey
        ? {
            filter: {
              team: {
                key: {
                  eq: selectedTeamKey,
                },
              },
            },
          }
        : {}),
    }),
    [selectedTeamKey],
  );
  const location = useLocation();
  const { data, error, loading } = useQuery<BoardPageQueryData, BoardPageQueryVariables>(
    BOARD_PAGE_QUERY,
    {
      variables: boardQueryVariables,
    },
  );
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(
    ISSUE_UPDATE_MUTATION,
  );
  const [runIssueCreate] = useMutation<IssueCreateMutationData, IssueCreateMutationVariables>(
    ISSUE_CREATE_MUTATION,
  );
  const [runCommentCreate] = useMutation<CommentCreateMutationData, CommentCreateMutationVariables>(
    COMMENT_CREATE_MUTATION,
  );
  const teams = data?.teams.nodes ?? [];
  const users = data?.users.nodes ?? [];
  const labels = data?.issueLabels.nodes ?? [];
  const baseIssues = data?.issues.nodes ?? EMPTY_ISSUES;
  const [createdIssues, setCreatedIssues] = useState<IssueSummary[]>([]);
  const [issueOverrides, setIssueOverrides] = useState<Record<string, IssueSummary>>({});
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSavingState, setIsSavingState] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [dragPreviewStateId, setDragPreviewStateId] = useState<string | null>(null);
  const [dragOriginStateId, setDragOriginStateId] = useState<string | null>(null);

  useEffect(() => {
    if (!teams.length) {
      if (selectedTeamKey !== null) {
        setSelectedTeamKey(null);
      }
      return;
    }

    const hasSelectedTeam = selectedTeamKey ? teams.some((team) => team.key === selectedTeamKey) : false;

    if (hasSelectedTeam) {
      return;
    }

    const nextTeamKey = getStoredTeamKey(teams) ?? getInitialTeamKey(teams);

    if (nextTeamKey !== selectedTeamKey) {
      setSelectedTeamKey(nextTeamKey);
    }
  }, [selectedTeamKey, teams]);

  useEffect(() => {
    writeStoredTeamKey(selectedTeamKey);
  }, [selectedTeamKey]);

  useEffect(() => {
    setIssueOverrides((currentOverrides) => reconcileIssueOverrides(baseIssues, currentOverrides));
    setCreatedIssues((currentIssues) => reconcileCreatedIssues(baseIssues, currentIssues));
  }, [baseIssues]);

  const selectedTeam =
    teams.find((team) => team.key === selectedTeamKey) ?? teams[0] ?? null;
  const allIssues = useMemo(
    () => mergeBoardIssues(baseIssues, issueOverrides, createdIssues),
    [baseIssues, createdIssues, issueOverrides],
  );
  const columns = useMemo(() => getBoardColumns(selectedTeam), [selectedTeam]);
  const visibleIssues = useMemo(() => {
    return filterIssuesByTeam(allIssues, selectedTeamKey ?? selectedTeam?.key ?? null);
  }, [allIssues, selectedTeam?.key, selectedTeamKey]);
  const issuesByState = useMemo(() => groupIssuesByState(visibleIssues), [visibleIssues]);
  const activeIssue = useMemo(
    () => visibleIssues.find((issue) => issue.id === activeIssueId) ?? null,
    [activeIssueId, visibleIssues],
  );
  const selectedIssue = useMemo(
    () => visibleIssues.find((issue) => issue.id === selectedIssueId) ?? null,
    [selectedIssueId, visibleIssues],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE } }),
    useSensor(MouseSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE } }),
    useSensor(TouchSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE } }),
  );

  async function persistIssueUpdate(
    issue: IssueSummary,
    input: IssueUpdateMutationVariables['input'],
    applyOptimisticIssue: (current: IssueSummary) => IssueSummary,
  ) {
    const previousOverride = issueOverrides[issue.id];
    const optimisticIssue = applyOptimisticIssue(issue);

    setMutationError(null);
    setIsSavingState(true);
    setIssueOverrides((currentOverrides) =>
      replaceIssueOverride(currentOverrides, issue.id, optimisticIssue),
    );

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

      setIssueOverrides((currentOverrides) =>
        replaceIssueOverride(
          currentOverrides,
          issue.id,
          mergeIssueWithPreservedComments(optimisticIssue, result.data!.issueUpdate.issue!),
        ),
      );
    } catch (mutationIssue) {
      setIssueOverrides((currentOverrides) =>
        replaceIssueOverride(currentOverrides, issue.id, previousOverride ?? null),
      );
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
    const previousOverride = issueOverrides[issue.id];

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

      setIssueOverrides((currentOverrides) => {
        const currentIssue = currentOverrides[issue.id] ?? issue;

        return replaceIssueOverride(currentOverrides, issue.id, {
          ...currentIssue,
          comments: {
            nodes: [...currentIssue.comments.nodes, result.data!.commentCreate.comment!].sort(
              (left, right) =>
                new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
            ),
          },
        });
      });
    } catch (mutationIssue) {
      setIssueOverrides((currentOverrides) =>
        replaceIssueOverride(currentOverrides, issue.id, previousOverride ?? null),
      );
      setMutationError(ERROR_MESSAGE);
      throw mutationIssue;
    } finally {
      setIsSavingState(false);
    }
  }

  async function handleCreateIssueSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextTitle = createTitle.trim();

    if (!selectedTeam || !nextTitle) {
      return;
    }

    setMutationError(null);
    setIsSavingState(true);

    try {
      const trimmedDescription = createDescription.trim();
      const result = await runIssueCreate({
        variables: {
          input: {
            teamId: selectedTeam.id,
            title: nextTitle,
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
          },
        },
      });

      if (!result.data?.issueCreate.success || !result.data.issueCreate.issue) {
        throw new Error('Create issue mutation failed');
      }

      setIssueOverrides((currentOverrides) =>
        replaceIssueOverride(currentOverrides, result.data!.issueCreate.issue!.id, result.data!.issueCreate.issue!),
      );
      setCreatedIssues((currentIssues) => [
        result.data!.issueCreate.issue!,
        ...currentIssues.filter((issue) => issue.id !== result.data!.issueCreate.issue!.id),
      ]);
      setSelectedIssueId(result.data.issueCreate.issue.id);
      setCreateTitle('');
      setCreateDescription('');
      setIsCreateOpen(false);
    } catch {
      setMutationError('We could not create the issue. Please try again.');
    } finally {
      setIsSavingState(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const issueId = String(event.active.id);
    const targetStateId = getDropTargetStateId(event) ?? dragPreviewStateId;
    const originStateId = dragOriginStateId;
    const originState =
      originStateId
        ? selectedTeam?.states.nodes.find((item) => item.id === originStateId) ?? null
        : null;

    setActiveIssueId(null);
    setDragPreviewStateId(null);
    setDragOriginStateId(null);

    const issue = visibleIssues.find((item) => item.id === issueId);

    if (!targetStateId) {
      if (issue && originState && issue.state.id !== originState.id) {
        setIssueOverrides((currentOverrides) =>
          replaceIssueOverride(currentOverrides, issueId, {
            ...issue,
            state: originState,
          }),
        );
      }
      return;
    }

    // Compare against the origin state to avoid skipping the mutation after
    // handleDragOver has already optimistically moved the card.
    if (!issue || originStateId === targetStateId) {
      return;
    }

    const targetState =
      selectedTeam?.states.nodes.find((item) => item.id === targetStateId) ?? null;

    if (!targetState) {
      return;
    }

    try {
      // Call persistIssueUpdate directly instead of persistStateChange because
      // handleDragOver already updated issue.state optimistically, which would
      // cause persistStateChange to skip the mutation.
      await persistIssueUpdate(issue, { stateId: targetStateId }, (current) => ({
        ...current,
        state: targetState,
      }));
    } catch {
      if (originState) {
        setIssueOverrides((currentOverrides) =>
          replaceIssueOverride(currentOverrides, issueId, {
            ...issue,
            state: originState,
          }),
        );
      }
    }
  }

  async function handleNativeDropIssue(payload: Html5BoardDragPayload, targetStateId: string) {
    const issue = visibleIssues.find((item) => item.id === payload.issueId);
    const targetState =
      selectedTeam?.states.nodes.find((state) => state.id === targetStateId) ?? null;

    setActiveIssueId(null);
    setDragPreviewStateId(null);
    setDragOriginStateId(null);

    if (!issue || !targetState || payload.stateId === targetStateId) {
      return;
    }

    try {
      await persistIssueUpdate(issue, { stateId: targetStateId }, (current) => ({
        ...current,
        state: targetState,
      }));
    } catch {
      // persistIssueUpdate already restored the previous issue override.
    }
  }

  function handleDragOver(event: DragOverEvent) {
    const issueId = String(event.active.id);
    const targetStateId = getDropTargetStateId(event);

    if (!targetStateId) {
      return;
    }

    const issue = visibleIssues.find((item) => item.id === issueId);
    const targetState =
      selectedTeam?.states.nodes.find((state) => state.id === targetStateId) ?? null;

    if (!issue || !targetState) {
      return;
    }

    setDragPreviewStateId(targetStateId);

    if (issue.state.id === targetStateId) {
      return;
    }

    setIssueOverrides((currentOverrides) =>
      replaceIssueOverride(currentOverrides, issueId, {
        ...issue,
        state: targetState,
      }),
    );
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

  const createIssueDialog = isCreateOpen ? (
    <aside className="issue-drawer" aria-label="Create issue drawer" aria-modal="true" role="dialog">
      <button
        type="button"
        className="issue-drawer__backdrop"
        aria-label="Close create issue drawer"
        onClick={() => setIsCreateOpen(false)}
      />
      <section className="issue-drawer__panel">
        <div className="issue-drawer__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h2>Create issue</h2>
          </div>
          <button type="button" className="issue-drawer__close" onClick={() => setIsCreateOpen(false)}>
            Close
          </button>
        </div>

        <form className="issue-comment-composer" onSubmit={(event) => void handleCreateIssueSubmit(event)}>
          <div className="issue-drawer__section">
            <label className="issue-drawer__label" htmlFor="create-issue-title">
              Title
            </label>
            <input
              id="create-issue-title"
              aria-label="Issue title"
              className="issue-drawer__title-input"
              value={createTitle}
              disabled={isSavingState}
              onChange={(event) => setCreateTitle(event.target.value)}
            />
          </div>

          <div className="issue-drawer__section">
            <label className="issue-drawer__label" htmlFor="create-issue-description">
              Description
            </label>
            <textarea
              id="create-issue-description"
              aria-label="Issue description"
              className="issue-drawer__textarea"
              value={createDescription}
              disabled={isSavingState}
              onChange={(event) => setCreateDescription(event.target.value)}
            />
          </div>

          {teams.length > 1 ? (
            <div className="issue-drawer__section">
              <label className="team-selector">
                <span>Team</span>
                <select
                  aria-label="Select team"
                  value={selectedTeam?.key ?? ''}
                  disabled={isSavingState}
                  onChange={(event) => setSelectedTeamKey(event.target.value)}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.key}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <button
            type="submit"
            className="issue-comment-composer__submit"
            disabled={isSavingState || !createTitle.trim() || !selectedTeam}
          >
            Create issue
          </button>
        </form>
      </section>
    </aside>
  ) : null;

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
          <button
            type="button"
            className="issue-comment-composer__submit"
            onClick={() => {
              setCreateTitle('');
              setCreateDescription('');
              setMutationError(null);
              setIsCreateOpen(true);
            }}
          >
            Create issue
          </button>
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
      ) : location.pathname === '/backlog' ? (
        <BacklogPage
          issues={visibleIssues}
          selectedTeam={selectedTeam}
          onSelectIssue={(issue) => {
            setMutationError(null);
            setSelectedIssueId(issue.id);
          }}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={kanbanCollisionDetection}
          onDragStart={(event) => {
            const draggedId = String(event.active.id);
            const draggedIssue = visibleIssues.find((item) => item.id === draggedId);
            setActiveIssueId(draggedId);
            setDragOriginStateId(draggedIssue?.state.id ?? null);
            setDragPreviewStateId(null);
            setMutationError(null);
          }}
          onDragOver={handleDragOver}
          onDragCancel={() => {
            const originState =
              dragOriginStateId
                ? selectedTeam?.states.nodes.find((state) => state.id === dragOriginStateId) ?? null
                : null;
            const cancelledIssueId = activeIssueId;
            setActiveIssueId(null);
            setDragPreviewStateId(null);
            setDragOriginStateId(null);
            if (cancelledIssueId && originState) {
              const cancelledIssue =
                visibleIssues.find((issue) => issue.id === cancelledIssueId) ?? null;

              if (cancelledIssue) {
                setIssueOverrides((currentOverrides) =>
                  replaceIssueOverride(currentOverrides, cancelledIssueId, {
                    ...cancelledIssue,
                    state: originState,
                  }),
                );
              }
              return;
            }
          }}
          onDragEnd={(event) => void handleDragEnd(event)}
        >
          <section className="board-grid" aria-label="Kanban board">
            {columns.map((column) => (
              <Column
                key={column.name}
                title={column.name}
                stateId={column.stateId}
                issues={issuesByState[column.name]}
                onNativeDragStart={(payload) => {
                  setActiveIssueId(payload.issueId);
                  setDragOriginStateId(payload.stateId);
                  setDragPreviewStateId(payload.stateId);
                  setMutationError(null);
                }}
                onNativeDragEnd={() => {
                  setActiveIssueId(null);
                  setDragPreviewStateId(null);
                  setDragOriginStateId(null);
                }}
                onNativeDropIssue={(payload, targetStateId) => {
                  void handleNativeDropIssue(payload, targetStateId);
                }}
                onSelectIssue={(issue) => {
                  setMutationError(null);
                  setSelectedIssueId(issue.id);
                }}
              />
            ))}
          </section>

          <DragOverlay>
            {activeIssue ? <IssueCard issue={activeIssue} sortable={false} /> : null}
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
      {createIssueDialog}
    </main>
  );
}

export function mergeIssueWithPreservedComments(
  previousIssue: IssueSummary,
  nextIssue: IssueSummary,
): IssueSummary {
  const nextComments = nextIssue.comments ?? previousIssue.comments;
  const nextChildren = nextIssue.children ?? previousIssue.children;

  return {
    ...nextIssue,
    children: nextChildren,
    comments:
      nextComments.nodes.length > 0 || previousIssue.comments.nodes.length === 0
        ? nextComments
        : previousIssue.comments,
  };
}

function mergeBoardIssues(
  baseIssues: IssueSummary[],
  issueOverrides: Record<string, IssueSummary>,
  createdIssues: IssueSummary[],
): IssueSummary[] {
  const baseIssueIds = new Set(baseIssues.map((issue) => issue.id));
  const nextCreatedIssues = createdIssues
    .filter((issue) => !baseIssueIds.has(issue.id))
    .map((issue) => issueOverrides[issue.id] ?? issue);
  const nextBaseIssues = baseIssues.map((issue) => issueOverrides[issue.id] ?? issue);
  const seenIssueIds = new Set([
    ...baseIssues.map((issue) => issue.id),
    ...nextCreatedIssues.map((issue) => issue.id),
  ]);
  const nextOrphanOverrides = Object.values(issueOverrides).filter((issue) => !seenIssueIds.has(issue.id));

  return [...nextCreatedIssues, ...nextOrphanOverrides, ...nextBaseIssues];
}

function reconcileIssueOverrides(
  baseIssues: IssueSummary[],
  issueOverrides: Record<string, IssueSummary>,
): Record<string, IssueSummary> {
  const baseIssuesById = new Map(baseIssues.map((issue) => [issue.id, issue]));
  let changed = false;
  const nextOverrides: Record<string, IssueSummary> = {};

  for (const [issueId, override] of Object.entries(issueOverrides)) {
    const baseIssue = baseIssuesById.get(issueId);

    if (baseIssue && areIssuesEquivalent(baseIssue, override)) {
      changed = true;
      continue;
    }

    nextOverrides[issueId] = override;
  }

  return changed ? nextOverrides : issueOverrides;
}

function reconcileCreatedIssues(
  baseIssues: IssueSummary[],
  createdIssues: IssueSummary[],
): IssueSummary[] {
  const nextCreatedIssues = createdIssues.filter(
    (issue) => !baseIssues.some((baseIssue) => baseIssue.id === issue.id),
  );

  return nextCreatedIssues.length === createdIssues.length ? createdIssues : nextCreatedIssues;
}

function replaceIssueOverride(
  issueOverrides: Record<string, IssueSummary>,
  issueId: string,
  issue: IssueSummary | null,
): Record<string, IssueSummary> {
  if (!issue) {
    if (!(issueId in issueOverrides)) {
      return issueOverrides;
    }

    const nextOverrides = { ...issueOverrides };
    delete nextOverrides[issueId];
    return nextOverrides;
  }

  if (issueOverrides[issueId] === issue) {
    return issueOverrides;
  }

  return {
    ...issueOverrides,
    [issueId]: issue,
  };
}

function areIssuesEquivalent(left: IssueSummary, right: IssueSummary): boolean {
  return JSON.stringify(toComparableIssue(left)) === JSON.stringify(toComparableIssue(right));
}

function toComparableIssue(issue: IssueSummary) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    updatedAt: issue.updatedAt,
    stateId: issue.state.id,
    teamKey: issue.team.key,
    assigneeId: issue.assignee?.id ?? null,
    labelIds: issue.labels.nodes.map((label) => label.id).sort(),
    childIds: issue.children.nodes.map((child) => child.id).sort(),
    parentId: issue.parent?.id ?? null,
    comments: [...issue.comments.nodes]
      .sort((left, right) => {
        const createdAtComparison =
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

        if (createdAtComparison !== 0) {
          return createdAtComparison;
        }

        return left.id.localeCompare(right.id);
      })
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        userId: comment.user?.id ?? null,
      })),
  };
}

export { getDropTargetStateId };
export { moveIssueToState };
export { DND_ACTIVATION_DISTANCE };
export { parseHtml5DragPayload };
export { createHtml5BoardDragPayload };

export const kanbanCollisionDetection: CollisionDetection = (args) => {
  const pointerMatches = pointerWithin(args);

  if (pointerMatches.length > 0) {
    return pointerMatches;
  }

  const rectMatches = rectIntersection(args);

  if (rectMatches.length > 0) {
    return rectMatches;
  }

  return closestCorners(args);
};
