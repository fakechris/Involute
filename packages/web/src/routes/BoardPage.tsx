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
import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  BOARD_PAGE_QUERY,
  COMMENT_DELETE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_DELETE_MUTATION,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
} from '../board/queries';
import type {
  BoardPageQueryData,
  BoardPageQueryVariables,
  CommentDeleteMutationData,
  CommentDeleteMutationVariables,
  CommentCreateMutationData,
  CommentCreateMutationVariables,
  Html5BoardDragPayload,
  IssueDeleteMutationData,
  IssueDeleteMutationVariables,
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
  mergeBoardIssues,
  mergeBoardPageQueryResults,
  mergeIssueWithPreservedComments,
  readStoredTeamKey,
  reconcileCreatedIssues,
  reconcileIssueOverrides,
  replaceIssueOverride,
  groupIssuesByState,
  OPEN_CREATE_ISSUE_EVENT,
  writeStoredTeamKey,
} from '../board/utils';
import {
  applyBoardViewState,
  buildBoardViewSummary,
  createSavedBoardViewId,
  getDefaultBoardViewState,
  readSavedBoardViews,
  readStoredBoardViewState,
  type BoardViewState,
  type SavedBoardView,
  writeSavedBoardViews,
  writeStoredBoardViewState,
} from '../board/views';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { writeStoredShellIssues, writeStoredShellTeams } from '../lib/app-shell-state';
import { BoardCreateIssueDialog } from '../components/BoardCreateIssueDialog';
import { BoardLoadMoreNotice } from '../components/BoardLoadMoreNotice';
import { Column } from '../components/Column';
import { IssueCard } from '../components/IssueCard';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';
import { BacklogPage } from './BacklogPage';

const ISSUE_PAGE_SIZE = 200;
const ERROR_MESSAGE = 'We could not save the issue changes. Please try again.';
const ISSUE_DELETE_ERROR_MESSAGE = 'We could not delete the issue. Please try again.';
const COMMENT_DELETE_ERROR_MESSAGE = 'We could not delete the comment. Please try again.';
const LOAD_MORE_ISSUES_ERROR_MESSAGE = 'We could not load more issues. Please try again.';
const DND_ACTIVATION_DISTANCE = 1;
const EMPTY_LABELS: BoardPageQueryData['issueLabels']['nodes'] = [];
const EMPTY_ISSUES: IssueSummary[] = [];
const EMPTY_TEAMS: BoardPageQueryData['teams']['nodes'] = [];
const EMPTY_USERS: BoardPageQueryData['users']['nodes'] = [];

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

export function BoardPage() {
  const navigate = useNavigate();
  const [activeTeamKey, setActiveTeamKey] = useState<string | null>(() => readStoredTeamKey());
  const [pendingTeamKey, setPendingTeamKey] = useState<string | null>(null);
  const [isLoadingMoreIssues, setIsLoadingMoreIssues] = useState(false);
  const [loadMoreIssuesError, setLoadMoreIssuesError] = useState<string | null>(null);
  const queryTeamKey = pendingTeamKey ?? activeTeamKey;
  const boardQueryVariables = useMemo<BoardPageQueryVariables>(
    () => ({
      first: ISSUE_PAGE_SIZE,
      ...(queryTeamKey
        ? {
            filter: {
              team: {
                key: {
                  eq: queryTeamKey,
                },
              },
            },
          }
        : {}),
    }),
    [queryTeamKey],
  );
  const location = useLocation();
  const isBacklogView = location.pathname === '/backlog';
  const { data, previousData, error, fetchMore, loading } = useQuery<
    BoardPageQueryData,
    BoardPageQueryVariables
  >(
    BOARD_PAGE_QUERY,
    {
      variables: boardQueryVariables,
      notifyOnNetworkStatusChange: true,
    },
  );
  const queryData = data ?? previousData;
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(
    ISSUE_UPDATE_MUTATION,
  );
  const [runIssueCreate] = useMutation<IssueCreateMutationData, IssueCreateMutationVariables>(
    ISSUE_CREATE_MUTATION,
  );
  const [runCommentCreate] = useMutation<CommentCreateMutationData, CommentCreateMutationVariables>(
    COMMENT_CREATE_MUTATION,
  );
  const [runIssueDelete] = useMutation<IssueDeleteMutationData, IssueDeleteMutationVariables>(
    ISSUE_DELETE_MUTATION,
  );
  const [runCommentDelete] = useMutation<CommentDeleteMutationData, CommentDeleteMutationVariables>(
    COMMENT_DELETE_MUTATION,
  );
  const teams = queryData?.teams.nodes ?? EMPTY_TEAMS;
  const users = queryData?.users.nodes ?? EMPTY_USERS;
  const labels = queryData?.issueLabels.nodes ?? EMPTY_LABELS;
  const baseIssues = queryData?.issues.nodes ?? EMPTY_ISSUES;
  const [createdIssues, setCreatedIssues] = useState<IssueSummary[]>([]);
  const [issueOverrides, setIssueOverrides] = useState<Record<string, IssueSummary>>({});
  const [deletedIssueIds, setDeletedIssueIds] = useState<string[]>([]);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [focusedIssueId, setFocusedIssueId] = useState<string | null>(null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [bulkTargetStateId, setBulkTargetStateId] = useState('');
  const [bulkAssigneeId, setBulkAssigneeId] = useState('');
  const [bulkLabelId, setBulkLabelId] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSavingState, setIsSavingState] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [dragPreviewStateId, setDragPreviewStateId] = useState<string | null>(null);
  const [dragOriginStateId, setDragOriginStateId] = useState<string | null>(null);
  const [boardViewState, setBoardViewState] = useState<BoardViewState>(() =>
    readStoredBoardViewState(activeTeamKey),
  );
  const [savedBoardViews, setSavedBoardViews] = useState<SavedBoardView[]>(() =>
    readSavedBoardViews(activeTeamKey),
  );
  const [activeSavedBoardViewId, setActiveSavedBoardViewId] = useState('');
  const boardSearchInputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (loading && !queryData) {
      return;
    }

    if (!teams.length) {
      if (activeTeamKey !== null) {
        setActiveTeamKey(null);
      }
      if (pendingTeamKey !== null) {
        setPendingTeamKey(null);
      }
      return;
    }

    const currentTeamKey = pendingTeamKey ?? activeTeamKey;
    const hasSelectedTeam = currentTeamKey ? teams.some((team) => team.key === currentTeamKey) : false;

    if (hasSelectedTeam) {
      return;
    }

    const nextTeamKey = getStoredTeamKey(teams) ?? getInitialTeamKey(teams);

    if (pendingTeamKey !== null) {
      setPendingTeamKey(null);
    }

    if (nextTeamKey !== activeTeamKey) {
      setActiveTeamKey(nextTeamKey);
    }
  }, [activeTeamKey, loading, pendingTeamKey, queryData, teams]);

  useLayoutEffect(() => {
    if (!pendingTeamKey || loading) {
      return;
    }

    if (!teams.some((team) => team.key === pendingTeamKey)) {
      setPendingTeamKey(null);
      return;
    }

    setActiveTeamKey(pendingTeamKey);
    setPendingTeamKey(null);
  }, [loading, pendingTeamKey, teams]);

  useEffect(() => {
    writeStoredTeamKey(activeTeamKey);
  }, [activeTeamKey]);

  useEffect(() => {
    if (teams.length === 0) {
      return;
    }

    writeStoredShellTeams(teams);
  }, [teams]);

  useEffect(() => {
    setIssueOverrides((currentOverrides) => reconcileIssueOverrides(baseIssues, currentOverrides));
    setCreatedIssues((currentIssues) => reconcileCreatedIssues(baseIssues, currentIssues));
  }, [baseIssues]);

  useEffect(() => {
    setLoadMoreIssuesError(null);
  }, [boardQueryVariables]);

  useLayoutEffect(() => {
    setBoardViewState(readStoredBoardViewState(activeTeamKey));
    setSavedBoardViews(readSavedBoardViews(activeTeamKey));
    setActiveSavedBoardViewId('');
  }, [activeTeamKey]);

  useEffect(() => {
    writeStoredBoardViewState(activeTeamKey, boardViewState);
  }, [activeTeamKey, boardViewState]);

  const selectedTeam =
    teams.find((team) => team.key === activeTeamKey) ??
    teams.find((team) => team.key === queryTeamKey) ??
    teams[0] ??
    null;
  const isTeamSwitching = Boolean(pendingTeamKey && pendingTeamKey !== activeTeamKey);
  const allIssues = useMemo(
    () => mergeBoardIssues(baseIssues, issueOverrides, createdIssues, deletedIssueIds),
    [baseIssues, createdIssues, deletedIssueIds, issueOverrides],
  );
  const visibleIssues = useMemo(() => {
    return filterIssuesByTeam(allIssues, activeTeamKey ?? selectedTeam?.key ?? null);
  }, [activeTeamKey, allIssues, selectedTeam?.key]);
  const boardVisibleIssues = useMemo(
    () => applyBoardViewState(visibleIssues, boardViewState, users),
    [boardViewState, users, visibleIssues],
  );
  const boardViewTokens = useMemo(
    () => buildBoardViewSummary(boardViewState, selectedTeam, users, labels),
    [boardViewState, labels, selectedTeam, users],
  );

  useEffect(() => {
    if (visibleIssues.length === 0) {
      return;
    }

    writeStoredShellIssues(visibleIssues);
  }, [visibleIssues]);

  useEffect(() => {
    if (!isTeamSwitching) {
      return;
    }

    setSelectedIssueId(null);
    setFocusedIssueId(null);
    setSelectedIssueIds([]);
    setBulkTargetStateId('');
    setBulkAssigneeId('');
    setBulkLabelId('');
    setActiveIssueId(null);
    setIsCreateOpen(false);
    setDragPreviewStateId(null);
    setDragOriginStateId(null);
    setMutationError(null);
  }, [isTeamSwitching]);

  useEffect(() => {
    function handleOpenCreateIssue() {
      setCreateTitle('');
      setCreateDescription('');
      setMutationError(null);
      setIsCreateOpen(true);
    }

    window.addEventListener(OPEN_CREATE_ISSUE_EVENT, handleOpenCreateIssue as EventListener);

    return () => {
      window.removeEventListener(OPEN_CREATE_ISSUE_EVENT, handleOpenCreateIssue as EventListener);
    };
  }, []);

  useEffect(() => {
    const visibleIssueIds = new Set(boardVisibleIssues.map((issue) => issue.id));

    setSelectedIssueIds((currentIssueIds) =>
      {
        const nextIssueIds = currentIssueIds.filter((issueId) => visibleIssueIds.has(issueId));

        return nextIssueIds.length === currentIssueIds.length &&
          nextIssueIds.every((issueId, index) => issueId === currentIssueIds[index])
          ? currentIssueIds
          : nextIssueIds;
      },
    );
    setFocusedIssueId((currentIssueId) =>
      {
        const nextIssueId =
          currentIssueId && visibleIssueIds.has(currentIssueId)
            ? currentIssueId
            : boardVisibleIssues[0]?.id ?? null;

        return currentIssueId === nextIssueId ? currentIssueId : nextIssueId;
      },
    );
  }, [boardVisibleIssues]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;

      const isTypingField =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.getAttribute('contenteditable') === 'true');

      if (isTypingField || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        boardSearchInputRef.current?.focus();
        boardSearchInputRef.current?.select();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const columns = useMemo(() => getBoardColumns(selectedTeam, visibleIssues), [selectedTeam, visibleIssues]);
  const issuesByState = useMemo(() => groupIssuesByState(boardVisibleIssues, columns), [boardVisibleIssues, columns]);
  const activeIssue = useMemo(
    () => visibleIssues.find((issue) => issue.id === activeIssueId) ?? null,
    [activeIssueId, visibleIssues],
  );
  const selectedIssue = useMemo(
    () => visibleIssues.find((issue) => issue.id === selectedIssueId) ?? null,
    [selectedIssueId, visibleIssues],
  );
  const selectedBoardIssueIndex = useMemo(
    () => boardVisibleIssues.findIndex((issue) => issue.id === selectedIssueId),
    [boardVisibleIssues, selectedIssueId],
  );
  const previousBoardIssue =
    selectedBoardIssueIndex > 0 ? boardVisibleIssues[selectedBoardIssueIndex - 1] ?? null : null;
  const nextBoardIssue =
    selectedBoardIssueIndex >= 0 ? boardVisibleIssues[selectedBoardIssueIndex + 1] ?? null : null;
  const hasMoreIssues = !isTeamSwitching && (queryData?.issues.pageInfo.hasNextPage ?? false);

  useEffect(() => {
    if (!selectedIssueId || isBacklogView) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;

      const isTypingField =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.getAttribute('contenteditable') === 'true');

      if (isTypingField || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if ((event.key === '[' || event.key === 'ArrowLeft') && previousBoardIssue) {
        event.preventDefault();
        openIssue(previousBoardIssue);
        return;
      }

      if ((event.key === ']' || event.key === 'ArrowRight') && nextBoardIssue) {
        event.preventDefault();
        openIssue(nextBoardIssue);
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBacklogView, nextBoardIssue, previousBoardIssue, selectedIssueId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE } }),
    useSensor(MouseSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE } }),
    useSensor(TouchSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE } }),
  );

  async function handleLoadMoreIssues() {
    if (isTeamSwitching) {
      return;
    }

    const pageInfo = queryData?.issues.pageInfo;

    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || isLoadingMoreIssues) {
      return;
    }

    setLoadMoreIssuesError(null);
    setIsLoadingMoreIssues(true);

    try {
      await fetchMore({
        variables: {
          ...boardQueryVariables,
          after: pageInfo.endCursor,
        },
        updateQuery: (previousResult, { fetchMoreResult }) =>
          mergeBoardPageQueryResults(previousResult, fetchMoreResult),
      });
    } catch {
      setLoadMoreIssuesError(LOAD_MORE_ISSUES_ERROR_MESSAGE);
    } finally {
      setIsLoadingMoreIssues(false);
    }
  }

  function toggleIssueSelection(issue: IssueSummary) {
    setFocusedIssueId(issue.id);
    setSelectedIssueIds((currentIssueIds) =>
      currentIssueIds.includes(issue.id)
        ? currentIssueIds.filter((issueId) => issueId !== issue.id)
        : [...currentIssueIds, issue.id],
    );
  }

  function openIssue(issue: IssueSummary) {
    setMutationError(null);
    setFocusedIssueId(issue.id);
    setSelectedIssueId(issue.id);
  }

  function selectAllVisibleIssues() {
    setSelectedIssueIds(boardVisibleIssues.map((issue) => issue.id));
  }

  async function applyBulkStateChange() {
    if (!bulkTargetStateId) {
      return;
    }

    const targetState =
      selectedTeam?.states.nodes.find((state) => state.id === bulkTargetStateId) ?? null;

    if (!targetState) {
      return;
    }

    const selectedIssueIdSet = new Set(selectedIssueIds);
    const issuesToUpdate = boardVisibleIssues.filter(
      (issue) => selectedIssueIdSet.has(issue.id) && issue.state.id !== bulkTargetStateId,
    );

    if (issuesToUpdate.length === 0) {
      return;
    }

    const previousIssuesById = new Map(
      issuesToUpdate.map((issue) => [issue.id, issueOverrides[issue.id] ?? issue]),
    );
    const optimisticIssuesById = new Map(
      issuesToUpdate.map((issue) => [issue.id, { ...(issueOverrides[issue.id] ?? issue), state: targetState }]),
    );

    setMutationError(null);
    setIsSavingState(true);

    setIssueOverrides((currentOverrides) => {
      let nextOverrides = currentOverrides;

      for (const [issueId, optimisticIssue] of optimisticIssuesById) {
        nextOverrides = replaceIssueOverride(nextOverrides, issueId, optimisticIssue);
      }

      return nextOverrides;
    });

    const results = await Promise.allSettled(
      issuesToUpdate.map((issue) =>
        runIssueUpdate({
          variables: {
            id: issue.id,
            input: {
              stateId: bulkTargetStateId,
            },
          },
        }),
      ),
    );

    let hadFailure = false;

    setIssueOverrides((currentOverrides) => {
      let nextOverrides = currentOverrides;

      results.forEach((result, index) => {
        const issue = issuesToUpdate[index]!;
        const previousIssue = previousIssuesById.get(issue.id) ?? issue;
        const optimisticIssue = optimisticIssuesById.get(issue.id) ?? issue;

        if (
          result.status === 'fulfilled' &&
          result.value.data?.issueUpdate.success &&
          result.value.data.issueUpdate.issue
        ) {
          const currentIssue = nextOverrides[issue.id] ?? optimisticIssue;
          nextOverrides = replaceIssueOverride(
            nextOverrides,
            issue.id,
            mergeIssueWithPreservedComments(currentIssue, result.value.data.issueUpdate.issue),
          );
          return;
        }

        hadFailure = true;
        nextOverrides = replaceIssueOverride(nextOverrides, issue.id, previousIssue);
      });

      return nextOverrides;
    });

    setIsSavingState(false);
    setSelectedIssueIds([]);
    setBulkTargetStateId('');

    if (hadFailure) {
      setMutationError('We could not update some selected issues. Please try again.');
    }
  }

  async function applyBulkAssigneeChange() {
    if (!bulkAssigneeId) {
      return;
    }

    const nextAssigneeId = bulkAssigneeId === 'unassigned' ? null : bulkAssigneeId;
    const nextAssignee = nextAssigneeId ? users.find((user) => user.id === nextAssigneeId) ?? null : null;
    const selectedIssueIdSet = new Set(selectedIssueIds);
    const issuesToUpdate = boardVisibleIssues.filter(
      (issue) => selectedIssueIdSet.has(issue.id) && (issue.assignee?.id ?? null) !== nextAssigneeId,
    );

    if (issuesToUpdate.length === 0) {
      return;
    }

    const previousIssuesById = new Map(
      issuesToUpdate.map((issue) => [issue.id, issueOverrides[issue.id] ?? issue]),
    );
    const optimisticIssuesById = new Map(
      issuesToUpdate.map((issue) => [
        issue.id,
        { ...(issueOverrides[issue.id] ?? issue), assignee: nextAssignee },
      ]),
    );

    setMutationError(null);
    setIsSavingState(true);

    setIssueOverrides((currentOverrides) => {
      let nextOverrides = currentOverrides;

      for (const [issueId, optimisticIssue] of optimisticIssuesById) {
        nextOverrides = replaceIssueOverride(nextOverrides, issueId, optimisticIssue);
      }

      return nextOverrides;
    });

    const results = await Promise.allSettled(
      issuesToUpdate.map((issue) =>
        runIssueUpdate({
          variables: {
            id: issue.id,
            input: {
              assigneeId: nextAssigneeId,
            },
          },
        }),
      ),
    );

    let hadFailure = false;

    setIssueOverrides((currentOverrides) => {
      let nextOverrides = currentOverrides;

      results.forEach((result, index) => {
        const issue = issuesToUpdate[index]!;
        const previousIssue = previousIssuesById.get(issue.id) ?? issue;
        const optimisticIssue = optimisticIssuesById.get(issue.id) ?? issue;

        if (
          result.status === 'fulfilled' &&
          result.value.data?.issueUpdate.success &&
          result.value.data.issueUpdate.issue
        ) {
          const currentIssue = nextOverrides[issue.id] ?? optimisticIssue;
          nextOverrides = replaceIssueOverride(
            nextOverrides,
            issue.id,
            mergeIssueWithPreservedComments(currentIssue, result.value.data.issueUpdate.issue),
          );
          return;
        }

        hadFailure = true;
        nextOverrides = replaceIssueOverride(nextOverrides, issue.id, previousIssue);
      });

      return nextOverrides;
    });

    setIsSavingState(false);
    setBulkAssigneeId('');

    if (hadFailure) {
      setMutationError('We could not update some assignees. Please try again.');
    }
  }

  async function applyBulkLabelAdd() {
    if (!bulkLabelId) {
      return;
    }

    const labelToAdd = labels.find((label) => label.id === bulkLabelId) ?? null;

    if (!labelToAdd) {
      return;
    }

    const selectedIssueIdSet = new Set(selectedIssueIds);
    const issuesToUpdate = boardVisibleIssues.filter(
      (issue) =>
        selectedIssueIdSet.has(issue.id) &&
        !issue.labels.nodes.some((label) => label.id === bulkLabelId),
    );

    if (issuesToUpdate.length === 0) {
      return;
    }

    const previousIssuesById = new Map(
      issuesToUpdate.map((issue) => [issue.id, issueOverrides[issue.id] ?? issue]),
    );
    const optimisticIssuesById = new Map(
      issuesToUpdate.map((issue) => {
        const currentIssue = issueOverrides[issue.id] ?? issue;

        return [
          issue.id,
          {
            ...currentIssue,
            labels: {
              nodes: [...currentIssue.labels.nodes, labelToAdd],
            },
          },
        ];
      }),
    );

    setMutationError(null);
    setIsSavingState(true);

    setIssueOverrides((currentOverrides) => {
      let nextOverrides = currentOverrides;

      for (const [issueId, optimisticIssue] of optimisticIssuesById) {
        nextOverrides = replaceIssueOverride(nextOverrides, issueId, optimisticIssue);
      }

      return nextOverrides;
    });

    const results = await Promise.allSettled(
      issuesToUpdate.map((issue) => {
        const labelIds = [...issue.labels.nodes.map((label) => label.id), bulkLabelId].sort();

        return runIssueUpdate({
          variables: {
            id: issue.id,
            input: {
              labelIds,
            },
          },
        });
      }),
    );

    let hadFailure = false;

    setIssueOverrides((currentOverrides) => {
      let nextOverrides = currentOverrides;

      results.forEach((result, index) => {
        const issue = issuesToUpdate[index]!;
        const previousIssue = previousIssuesById.get(issue.id) ?? issue;
        const optimisticIssue = optimisticIssuesById.get(issue.id) ?? issue;

        if (
          result.status === 'fulfilled' &&
          result.value.data?.issueUpdate.success &&
          result.value.data.issueUpdate.issue
        ) {
          const currentIssue = nextOverrides[issue.id] ?? optimisticIssue;
          nextOverrides = replaceIssueOverride(
            nextOverrides,
            issue.id,
            mergeIssueWithPreservedComments(currentIssue, result.value.data.issueUpdate.issue),
          );
          return;
        }

        hadFailure = true;
        nextOverrides = replaceIssueOverride(nextOverrides, issue.id, previousIssue);
      });

      return nextOverrides;
    });

    setIsSavingState(false);
    setBulkLabelId('');

    if (hadFailure) {
      setMutationError('We could not add the label to some selected issues. Please try again.');
    }
  }

  function toggleBoardFilterValue(key: 'assigneeIds' | 'labelIds' | 'stateIds', value: string) {
    setBoardViewState((currentState) => {
      const currentValues = currentState[key];

      return {
        ...currentState,
        [key]: currentValues.includes(value)
          ? currentValues.filter((entry) => entry !== value)
          : [...currentValues, value],
      };
    });
    setActiveSavedBoardViewId('');
  }

  function resetBoardViewState() {
    setBoardViewState(getDefaultBoardViewState());
    setActiveSavedBoardViewId('');
  }

  function clearBoardQuery() {
    setBoardViewState((currentState) => ({
      ...currentState,
      query: '',
    }));
    setActiveSavedBoardViewId('');
  }

  function removeBoardFilterToken(token: string) {
    if (token.startsWith('Query: ')) {
      clearBoardQuery();
      return;
    }

    if (token.startsWith('Assignee: ')) {
      const targetLabel = token.slice('Assignee: '.length);

      setBoardViewState((currentState) => ({
        ...currentState,
        assigneeIds: currentState.assigneeIds.filter((assigneeId) => {
          if (targetLabel === 'Unassigned') {
            return assigneeId !== 'unassigned';
          }

          const user = users.find((candidate) => candidate.id === assigneeId);
          return (user?.name ?? user?.email ?? assigneeId) !== targetLabel;
        }),
      }));
      setActiveSavedBoardViewId('');
      return;
    }

    if (token.startsWith('State: ')) {
      const targetStateName = token.slice('State: '.length);

      setBoardViewState((currentState) => ({
        ...currentState,
        stateIds: currentState.stateIds.filter((stateId) => {
          const state = selectedTeam?.states.nodes.find((candidate) => candidate.id === stateId);
          return (state?.name ?? stateId) !== targetStateName;
        }),
      }));
      setActiveSavedBoardViewId('');
      return;
    }

    if (token.startsWith('Label: ')) {
      const targetLabelName = token.slice('Label: '.length);

      setBoardViewState((currentState) => ({
        ...currentState,
        labelIds: currentState.labelIds.filter((labelId) => {
          const label = labels.find((candidate) => candidate.id === labelId);
          return (label?.name ?? labelId) !== targetLabelName;
        }),
      }));
      setActiveSavedBoardViewId('');
    }
  }

  function saveBoardView() {
    if (!activeTeamKey) {
      return;
    }

    const viewName = window.prompt('Save board view as', selectedTeam ? `${selectedTeam.name} board view` : 'Board view');
    const trimmedName = viewName?.trim();

    if (!trimmedName) {
      return;
    }

    const nextView: SavedBoardView = {
      id: createSavedBoardViewId(),
      name: trimmedName,
      state: boardViewState,
    };
    const nextSavedViews = [nextView, ...savedBoardViews].slice(0, 12);
    setSavedBoardViews(nextSavedViews);
    setActiveSavedBoardViewId(nextView.id);
    writeSavedBoardViews(activeTeamKey, nextSavedViews);
  }

  function loadBoardView(nextViewId: string) {
    setActiveSavedBoardViewId(nextViewId);

    if (!nextViewId) {
      setBoardViewState(readStoredBoardViewState(activeTeamKey));
      return;
    }

    const nextView = savedBoardViews.find((view) => view.id === nextViewId);

    if (nextView) {
      setBoardViewState(nextView.state);
    }
  }

  function deleteBoardView() {
    if (!activeTeamKey || !activeSavedBoardViewId) {
      return;
    }

    const nextSavedViews = savedBoardViews.filter((view) => view.id !== activeSavedBoardViewId);
    setSavedBoardViews(nextSavedViews);
    setActiveSavedBoardViewId('');
    writeSavedBoardViews(activeTeamKey, nextSavedViews);
  }

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

      setIssueOverrides((currentOverrides) => {
        const currentIssue = currentOverrides[issue.id] ?? optimisticIssue;

        return replaceIssueOverride(
          currentOverrides,
          issue.id,
          mergeIssueWithPreservedComments(currentIssue, result.data!.issueUpdate.issue!),
        );
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

  async function persistIssueDelete(issue: IssueSummary) {
    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runIssueDelete({
        variables: {
          id: issue.id,
        },
      });

      if (!result.data?.issueDelete.success || !result.data.issueDelete.issueId) {
        throw new Error('Delete issue mutation failed');
      }

      setDeletedIssueIds((currentIssueIds) =>
        currentIssueIds.includes(issue.id) ? currentIssueIds : [...currentIssueIds, issue.id],
      );
      setIssueOverrides((currentOverrides) => replaceIssueOverride(currentOverrides, issue.id, null));
      setCreatedIssues((currentIssues) => currentIssues.filter((currentIssue) => currentIssue.id !== issue.id));
      setSelectedIssueId((currentIssueId) => (currentIssueId === issue.id ? null : currentIssueId));
      setActiveIssueId((currentIssueId) => (currentIssueId === issue.id ? null : currentIssueId));
      setDragPreviewStateId(null);
      setDragOriginStateId(null);
    } catch {
      setMutationError(ISSUE_DELETE_ERROR_MESSAGE);
      throw new Error(ISSUE_DELETE_ERROR_MESSAGE);
    } finally {
      setIsSavingState(false);
    }
  }

  async function persistCommentDelete(issue: IssueSummary, commentId: string) {
    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runCommentDelete({
        variables: {
          id: commentId,
        },
      });

      if (!result.data?.commentDelete.success || !result.data.commentDelete.commentId) {
        throw new Error('Delete comment mutation failed');
      }

      setIssueOverrides((currentOverrides) => {
        const currentIssue = currentOverrides[issue.id] ?? issue;

        return replaceIssueOverride(currentOverrides, issue.id, {
          ...currentIssue,
          comments: {
            nodes: currentIssue.comments.nodes.filter((comment) => comment.id !== commentId),
          },
        });
      });
    } catch {
      setMutationError(COMMENT_DELETE_ERROR_MESSAGE);
      throw new Error(COMMENT_DELETE_ERROR_MESSAGE);
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
      setFocusedIssueId(result.data.issueCreate.issue.id);
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
    const targetStateId = getDropTargetStateId(event);
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

  useEffect(() => {
    if (isBacklogView || boardVisibleIssues.length === 0) {
      return;
    }

    function handleBoardKeyboardShortcuts(event: KeyboardEvent) {
      const target = event.target;
      const isElementTarget = target instanceof HTMLElement;
      const tagName = isElementTarget ? target.tagName : null;
      const isTypingField =
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        (isElementTarget && target.getAttribute('contenteditable') === 'true');

      if (isTypingField || selectedIssueId || isCreateOpen) {
        return;
      }

      const currentIndex = boardVisibleIssues.findIndex((issue) => issue.id === focusedIssueId);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIssue = boardVisibleIssues[Math.min(boardVisibleIssues.length - 1, safeIndex + 1)];
        setFocusedIssueId(nextIssue?.id ?? focusedIssueId);
        return;
      }

      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        const nextIssue = boardVisibleIssues[Math.max(0, safeIndex - 1)];
        setFocusedIssueId(nextIssue?.id ?? focusedIssueId);
        return;
      }

      if (event.key === 'x' && focusedIssueId) {
        event.preventDefault();
        const focusedIssue = boardVisibleIssues.find((issue) => issue.id === focusedIssueId);

        if (focusedIssue) {
          toggleIssueSelection(focusedIssue);
        }
        return;
      }

      if ((event.key === 'Enter' || event.key === 'o') && focusedIssueId) {
        event.preventDefault();
        const focusedIssue = boardVisibleIssues.find((issue) => issue.id === focusedIssueId);

        if (focusedIssue) {
          openIssue(focusedIssue);
        }
        return;
      }

      if (event.key === 'A' && event.shiftKey) {
        event.preventDefault();
        selectAllVisibleIssues();
      }
    }

    window.addEventListener('keydown', handleBoardKeyboardShortcuts);

    return () => {
      window.removeEventListener('keydown', handleBoardKeyboardShortcuts);
    };
  }, [boardVisibleIssues, focusedIssueId, isBacklogView, isCreateOpen, selectedIssueId]);

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
        <section className="shell-notice shell-notice--error" role="alert">
          <h2>{errorState.title}</h2>
          <p>{errorState.description}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="board-page">
      <header className="app-shell__header">
        <div className="app-shell__header-copy">
          <p className="app-shell__eyebrow">Involute</p>
          <div className="app-shell__header-inline-meta">
            {selectedTeam ? (
              <span className="context-chip context-chip--team">
                {selectedTeam.key}
              </span>
            ) : null}
            <span className="context-chip">{isBacklogView ? 'Backlog' : 'Board'}</span>
          </div>
          <h1>{isBacklogView ? 'Backlog' : 'Board'}</h1>
          <p className="app-shell__subtext">
            {isBacklogView
              ? `List view for ${selectedTeam?.name ?? 'your workspace'} issues.`
              : `Workflow overview for ${selectedTeam?.name ?? 'your workspace'}.`}
          </p>
          {isTeamSwitching ? (
            <p className="app-shell__subtext" aria-live="polite">
              Switching to {teams.find((team) => team.key === pendingTeamKey)?.name ?? pendingTeamKey}…
            </p>
          ) : null}
        </div>

        <div className="board-page__controls">
          <div className="board-page__mode-toggle" aria-label="View mode">
            <button
              type="button"
              className={`board-page__mode-button${!isBacklogView ? ' board-page__mode-button--active' : ''}`}
              onClick={() => navigate('/')}
            >
              Board
            </button>
            <button
              type="button"
              className={`board-page__mode-button${isBacklogView ? ' board-page__mode-button--active' : ''}`}
              onClick={() => navigate('/backlog')}
            >
              Backlog
            </button>
          </div>
          <button
            type="button"
            className="board-page__ghost-action"
            onClick={() => navigate('/backlog')}
          >
            Views
          </button>
          <button
            type="button"
            className="ui-action ui-action--accent"
            disabled={isTeamSwitching}
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
            <label className="field-stack">
              <span>Team</span>
              <select
                aria-label="Select team"
                value={pendingTeamKey ?? activeTeamKey ?? selectedTeam?.key ?? ''}
                onChange={(event) => {
                  const nextTeamKey = event.target.value;

                  if (nextTeamKey === activeTeamKey) {
                    setPendingTeamKey(null);
                    return;
                  }

                  setPendingTeamKey(nextTeamKey);
                }}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.key}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          ) : selectedTeam ? (
            <div className="field-stack field-stack--readonly">
              <span>Team</span>
              <strong>{selectedTeam.name}</strong>
            </div>
          ) : null}
        </div>
      </header>

      {mutationError ? (
        <section className="shell-notice shell-notice--error" role="alert">
          <p>{mutationError}</p>
        </section>
      ) : null}

      {!isBacklogView ? (
        <>
          <section className="board-viewbar">
            <div className="board-viewbar__primary">
              <label className="field-stack board-viewbar__search">
                <span>Search</span>
                <input
                  ref={boardSearchInputRef}
                  aria-label="Search board issues"
                  placeholder="Filter by identifier, title, or description"
                  value={boardViewState.query}
                  onChange={(event) => {
                    setBoardViewState((currentState) => ({
                      ...currentState,
                      query: event.target.value,
                    }));
                    setActiveSavedBoardViewId('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && boardViewState.query) {
                      event.preventDefault();
                      setBoardViewState((currentState) => ({
                        ...currentState,
                        query: '',
                      }));
                      setActiveSavedBoardViewId('');
                    }
                  }}
                />
              </label>
              {boardViewState.query ? (
                <button type="button" className="ui-action ui-action--subtle" onClick={clearBoardQuery}>
                  Clear search
                </button>
              ) : null}

              <label className="field-stack">
                <span>Sort</span>
                <select
                  aria-label="Sort board by"
                  value={boardViewState.sortField}
                  onChange={(event) => {
                    setBoardViewState((currentState) => ({
                      ...currentState,
                      sortField: event.target.value as BoardViewState['sortField'],
                    }));
                    setActiveSavedBoardViewId('');
                  }}
                >
                  <option value="updatedAt">Updated</option>
                  <option value="createdAt">Created</option>
                  <option value="identifier">Identifier</option>
                  <option value="title">Title</option>
                </select>
              </label>

              <label className="field-stack">
                <span>Direction</span>
                <select
                  aria-label="Sort board direction"
                  value={boardViewState.sortDirection}
                  onChange={(event) => {
                    setBoardViewState((currentState) => ({
                      ...currentState,
                      sortDirection: event.target.value as BoardViewState['sortDirection'],
                    }));
                    setActiveSavedBoardViewId('');
                  }}
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </label>
            </div>

            <div className="board-viewbar__secondary">
              <label className="field-stack">
                <span>Saved view</span>
                <select
                  aria-label="Load saved board view"
                  value={activeSavedBoardViewId}
                  onChange={(event) => loadBoardView(event.target.value)}
                >
                  <option value="">Current board view</option>
                  {savedBoardViews.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </label>

              <button type="button" className="ui-action ui-action--subtle" onClick={saveBoardView}>
                Save view
              </button>
              <button
                type="button"
                className="ui-action ui-action--subtle"
                disabled={!activeSavedBoardViewId}
                onClick={deleteBoardView}
              >
                Delete view
              </button>
              <button type="button" className="ui-action ui-action--subtle" onClick={resetBoardViewState}>
                Clear
              </button>
            </div>
          </section>

          <section className="board-filter-row" aria-label="Board filters">
            <details className="board-filter">
              <summary>States {boardViewState.stateIds.length > 0 ? `(${boardViewState.stateIds.length})` : ''}</summary>
              <div className="board-filter__menu">
                {selectedTeam?.states.nodes.map((state) => (
                  <label key={state.id} className="board-filter__option">
                    <input
                      type="checkbox"
                      checked={boardViewState.stateIds.includes(state.id)}
                      onChange={() => toggleBoardFilterValue('stateIds', state.id)}
                    />
                    <span>{state.name}</span>
                  </label>
                ))}
              </div>
            </details>

            <details className="board-filter">
              <summary>Assignees {boardViewState.assigneeIds.length > 0 ? `(${boardViewState.assigneeIds.length})` : ''}</summary>
              <div className="board-filter__menu">
                <label className="board-filter__option">
                  <input
                    type="checkbox"
                    checked={boardViewState.assigneeIds.includes('unassigned')}
                    onChange={() => toggleBoardFilterValue('assigneeIds', 'unassigned')}
                  />
                  <span>Unassigned</span>
                </label>
                {users.map((user) => (
                  <label key={user.id} className="board-filter__option">
                    <input
                      type="checkbox"
                      checked={boardViewState.assigneeIds.includes(user.id)}
                      onChange={() => toggleBoardFilterValue('assigneeIds', user.id)}
                    />
                    <span>{user.name ?? user.email ?? user.id}</span>
                  </label>
                ))}
              </div>
            </details>

            <details className="board-filter">
              <summary>Labels {boardViewState.labelIds.length > 0 ? `(${boardViewState.labelIds.length})` : ''}</summary>
              <div className="board-filter__menu">
                {labels.map((label) => (
                  <label key={label.id} className="board-filter__option">
                    <input
                      type="checkbox"
                      checked={boardViewState.labelIds.includes(label.id)}
                      onChange={() => toggleBoardFilterValue('labelIds', label.id)}
                    />
                    <span>{label.name}</span>
                  </label>
                ))}
              </div>
            </details>
          </section>

          <section className="board-active-view" aria-label="Active board view">
            <div className="board-active-view__meta">
              <strong>{boardVisibleIssues.length} visible issues</strong>
              <span>
                {activeSavedBoardViewId
                  ? `Loaded view: ${savedBoardViews.find((view) => view.id === activeSavedBoardViewId)?.name ?? 'Unknown'}`
                  : 'Unsaved working view'}
              </span>
            </div>
            <div className="board-active-view__tokens">
              {boardViewTokens.map((token) => (
                <button
                  key={token}
                  type="button"
                  className="context-chip context-chip--interactive"
                  onClick={() => removeBoardFilterToken(token)}
                  disabled={token.startsWith('Sort: ')}
                  aria-label={token.startsWith('Sort: ') ? token : `Remove ${token}`}
                >
                  {token}
                </button>
              ))}
              {(boardViewState.query ||
                boardViewState.assigneeIds.length > 0 ||
                boardViewState.stateIds.length > 0 ||
                boardViewState.labelIds.length > 0) ? (
                <button type="button" className="ui-action ui-action--subtle" onClick={resetBoardViewState}>
                  Clear filters
                </button>
              ) : null}
            </div>
          </section>

          <section className="issue-bulkbar" aria-label="Bulk actions">
            <div className="issue-bulkbar__meta">
              <strong>{selectedIssueIds.length} selected</strong>
              <span>
                {selectedIssueIds.length > 0
                  ? 'Apply actions to the current filtered board selection.'
                  : 'Use x to select the focused issue, Shift+A to select all visible, Enter to open.'}
              </span>
            </div>
            <div className="issue-bulkbar__actions">
              <button type="button" className="ui-action ui-action--subtle" onClick={selectAllVisibleIssues}>
                Select all visible
              </button>
              <button
                type="button"
                className="ui-action ui-action--subtle"
                disabled={selectedIssueIds.length === 0}
                onClick={() => setSelectedIssueIds([])}
              >
                Clear selection
              </button>
              <label className="field-stack">
                <span>Move to</span>
                <select
                  aria-label="Bulk move selected issues to state"
                  value={bulkTargetStateId}
                  onChange={(event) => setBulkTargetStateId(event.target.value)}
                >
                  <option value="">Choose state</option>
                  {selectedTeam?.states.nodes.map((state) => (
                    <option key={state.id} value={state.id}>
                      {state.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ui-action ui-action--accent"
                disabled={selectedIssueIds.length === 0 || !bulkTargetStateId || isSavingState}
                onClick={() => void applyBulkStateChange()}
              >
                Apply to selected
              </button>
              <label className="field-stack">
                <span>Assign to</span>
                <select
                  aria-label="Bulk assign selected issues"
                  value={bulkAssigneeId}
                  onChange={(event) => setBulkAssigneeId(event.target.value)}
                >
                  <option value="">Choose assignee</option>
                  <option value="unassigned">Unassigned</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name ?? user.email ?? user.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ui-action ui-action--subtle"
                disabled={selectedIssueIds.length === 0 || !bulkAssigneeId || isSavingState}
                onClick={() => void applyBulkAssigneeChange()}
              >
                Apply assignee
              </button>
              <label className="field-stack">
                <span>Add label</span>
                <select
                  aria-label="Bulk add label to selected issues"
                  value={bulkLabelId}
                  onChange={(event) => setBulkLabelId(event.target.value)}
                >
                  <option value="">Choose label</option>
                  {labels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ui-action ui-action--subtle"
                disabled={selectedIssueIds.length === 0 || !bulkLabelId || isSavingState}
                onClick={() => void applyBulkLabelAdd()}
              >
                Add label
              </button>
            </div>
          </section>
        </>
      ) : null}

      <BoardLoadMoreNotice
        errorMessage={loadMoreIssuesError}
        hasMoreIssues={hasMoreIssues}
        isLoadingMoreIssues={isLoadingMoreIssues}
        onLoadMore={() => void handleLoadMoreIssues()}
      />

      {loading && !queryData ? (
        <section className="shell-notice" aria-live="polite">
          Loading board…
        </section>
      ) : isBacklogView ? (
        <BacklogPage
          issues={visibleIssues}
          labels={labels}
          selectedTeam={selectedTeam}
          users={users}
          onSelectIssue={openIssue}
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
                focusedIssueId={focusedIssueId}
                issues={issuesByState[column.stateId] ?? EMPTY_ISSUES}
                onToggleIssueSelection={toggleIssueSelection}
                selectedIssueIds={selectedIssueIds}
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
                onSelectIssue={openIssue}
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
        onCommentDelete={persistCommentDelete}
        onIssueDelete={persistIssueDelete}
        {...(!isBacklogView ? { previousIssue: previousBoardIssue } : {})}
        {...(previousBoardIssue ? { onPreviousIssue: () => openIssue(previousBoardIssue) } : {})}
        {...(!isBacklogView ? { nextIssue: nextBoardIssue } : {})}
        {...(nextBoardIssue ? { onNextIssue: () => openIssue(nextBoardIssue) } : {})}
      />
      <BoardCreateIssueDialog
        isOpen={isCreateOpen}
        isSaving={isSavingState}
        teams={teams}
        selectedTeam={selectedTeam}
        createTitle={createTitle}
        createDescription={createDescription}
        onClose={() => setIsCreateOpen(false)}
        onSubmit={(event) => void handleCreateIssueSubmit(event)}
        onTitleChange={setCreateTitle}
        onDescriptionChange={setCreateDescription}
        onTeamChange={(teamKey) => setPendingTeamKey(teamKey === activeTeamKey ? null : teamKey)}
      />
    </main>
  );
}

export { getDropTargetStateId };
export { moveIssueToState };
export { DND_ACTIVATION_DISTANCE };
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
