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
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  BoardGroupBy,
  BoardIssueGroup,
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
  APPLY_BOARD_VIEW_EVENT,
  buildBoardViewSummary,
  createSavedBoardViewId,
  getDefaultBoardViewState,
  groupIssuesBy,
  readSavedBoardViews,
  dispatchApplyBoardView,
  readStoredBoardViewState,
  type ApplyBoardViewDetail,
  type BoardViewMode,
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
import { InlineCreate } from '../components/InlineCreate';
import { IssueCard } from '../components/IssueCard';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';
import { KanbanView } from '../components/KanbanView';
import { BacklogPage } from './BacklogPage';
import { IcoFilter, IcoSort, IcoPlus, IcoList, IcoBoard, IcoClose, IcoChevR } from '../components/Icons';
import { Btn, PriorityIcon } from '../components/Primitives';

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
  const labels = useMemo(() => Array.from(
    new Map((queryData?.issueLabels.nodes ?? EMPTY_LABELS).map(l => [l.id, l])).values()
  ), [queryData?.issueLabels.nodes]);
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
  const [bulkRemoveLabelId, setBulkRemoveLabelId] = useState('');
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
  const [inlineCreateGroupId, setInlineCreateGroupId] = useState<string | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem('involute:collapsed-columns');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const collapsedColumnsInitialized = useRef(false);

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
    function handleApplyBoardView(event: Event) {
      const detail =
        event instanceof CustomEvent && event.detail
          ? (event.detail as ApplyBoardViewDetail)
          : null;

      if (!detail) {
        return;
      }

      setBoardViewState(detail.state);
      setActiveSavedBoardViewId(detail.viewId ?? '');
    }

    window.addEventListener(APPLY_BOARD_VIEW_EVENT, handleApplyBoardView as EventListener);

    return () => {
      window.removeEventListener(APPLY_BOARD_VIEW_EVENT, handleApplyBoardView as EventListener);
    };
  }, []);

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
    setBulkRemoveLabelId('');
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

    if (
      !isBacklogView &&
      location.state &&
      typeof location.state === 'object' &&
      'openCreateIssue' in location.state &&
      location.state.openCreateIssue
    ) {
      handleOpenCreateIssue();
      navigate(location.pathname, {
        replace: true,
        state: {},
      });
    }

    window.addEventListener(OPEN_CREATE_ISSUE_EVENT, handleOpenCreateIssue as EventListener);

    return () => {
      window.removeEventListener(OPEN_CREATE_ISSUE_EVENT, handleOpenCreateIssue as EventListener);
    };
  }, [isBacklogView, location.pathname, location.state, navigate]);

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

  useEffect(() => {
    if (!selectedTeam || collapsedColumnsInitialized.current) {
      return;
    }
    collapsedColumnsInitialized.current = true;
    const stored = collapsedColumns;
    const hasAnyStored = selectedTeam.states.nodes.some((s) => s.id in stored);
    if (hasAnyStored) {
      return;
    }
    const defaults: Record<string, boolean> = {};
    for (const state of selectedTeam.states.nodes) {
      if (state.type === 'COMPLETED' || state.type === 'CANCELED') {
        defaults[state.id] = true;
      }
    }
    if (Object.keys(defaults).length > 0) {
      setCollapsedColumns((prev) => ({ ...prev, ...defaults }));
    }
  }, [selectedTeam, collapsedColumns]);

  useEffect(() => {
    try {
      localStorage.setItem('involute:collapsed-columns', JSON.stringify(collapsedColumns));
    } catch { /* ignore */ }
  }, [collapsedColumns]);

  const toggleColumnCollapse = useCallback((stateId: string) => {
    setCollapsedColumns((prev) => ({ ...prev, [stateId]: !prev[stateId] }));
  }, []);

  const columns = useMemo(() => getBoardColumns(selectedTeam, visibleIssues), [selectedTeam, visibleIssues]);
  const issuesByState = useMemo(() => groupIssuesByState(boardVisibleIssues, columns), [boardVisibleIssues, columns]);
  const issueGroups = useMemo(
    () => groupIssuesBy(boardVisibleIssues, boardViewState.groupBy, selectedTeam, users, labels),
    [boardVisibleIssues, boardViewState.groupBy, selectedTeam, users, labels],
  );
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

  async function applyBulkLabelRemove() {
    if (!bulkRemoveLabelId) {
      return;
    }

    const selectedIssueIdSet = new Set(selectedIssueIds);
    const issuesToUpdate = boardVisibleIssues.filter(
      (issue) =>
        selectedIssueIdSet.has(issue.id) &&
        issue.labels.nodes.some((label) => label.id === bulkRemoveLabelId),
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
              nodes: currentIssue.labels.nodes.filter((label) => label.id !== bulkRemoveLabelId),
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
        const labelIds = issue.labels.nodes
          .map((label) => label.id)
          .filter((labelId) => labelId !== bulkRemoveLabelId)
          .sort();

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
    setBulkRemoveLabelId('');

    if (hadFailure) {
      setMutationError('We could not remove the label from some selected issues. Please try again.');
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

  async function handleInlineCreate(title: string, groupMeta?: BoardIssueGroup['meta']) {
    if (!selectedTeam || !title.trim()) {
      return;
    }

    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runIssueCreate({
        variables: {
          input: {
            teamId: selectedTeam.id,
            title: title.trim(),
            ...(groupMeta?.stateId ? { stateId: groupMeta.stateId } : {}),
            ...(groupMeta?.priority !== undefined ? { priority: groupMeta.priority } : {}),
          },
        },
      });

      if (!result.data?.issueCreate.success || !result.data.issueCreate.issue) {
        throw new Error('Create issue mutation failed');
      }

      const newIssue = result.data.issueCreate.issue;

      setIssueOverrides((currentOverrides) =>
        replaceIssueOverride(currentOverrides, newIssue.id, newIssue),
      );
      setCreatedIssues((currentIssues) => [
        newIssue,
        ...currentIssues.filter((issue) => issue.id !== newIssue.id),
      ]);
      setFocusedIssueId(newIssue.id);
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

      if (event.key === 'X' && event.shiftKey) {
        event.preventDefault();
        setSelectedIssueIds([]);
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
      <header className="board-page__header" style={{
        display: 'flex', alignItems: 'center', gap: 10,
        height: 44, padding: '0 var(--pad-x, var(--content-gutter))',
        borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, whiteSpace: 'nowrap' }}>
          {selectedTeam ? (
            <span className="mono" style={{
              fontSize: 10, fontWeight: 500, padding: '1px 5px', borderRadius: 3,
              background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--fg-muted)',
            }}>{selectedTeam.key}</span>
          ) : null}
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
            {selectedTeam?.name ?? 'Involute'}
          </span>
          <span style={{ color: 'var(--fg-faint)', display: 'inline-flex' }}>
            <IcoChevR size={12} />
          </span>
          <h1 style={{ fontSize: 13, fontWeight: 400, color: 'var(--fg-muted)', margin: 0 }}>{isBacklogView ? 'Backlog' : 'All issues'}</h1>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)', marginLeft: 4 }}>{visibleIssues.length}</span>
        </div>
        <p className="app-shell__subtext" style={{ fontSize: 11, color: 'var(--fg-dim)', margin: 0 }}>
          {isBacklogView
            ? `List view for ${selectedTeam?.name ?? 'your workspace'} issues.`
            : `Workflow overview for ${selectedTeam?.name ?? 'your workspace'}.`}
        </p>
        {isTeamSwitching ? (
          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }} aria-live="polite">
            Switching to {teams.find((team) => team.key === pendingTeamKey)?.name ?? pendingTeamKey}…
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        {teams.length > 1 ? (
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
            style={{
              height: 24, padding: '0 8px', fontSize: 11.5,
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 'var(--r-2)', color: 'var(--fg)',
            }}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.key}>{team.name}</option>
            ))}
          </select>
        ) : null}
        <Btn variant="ghost" icon={<IcoFilter size={14} />} size="sm">Filter</Btn>
        <Btn variant="ghost" icon={<IcoSort size={14} />} size="sm">Sort</Btn>
        <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <Btn
          variant="subtle"
          icon={<IcoPlus size={12} />}
          kbd="C"
          size="sm"
          onClick={() => {
            setCreateTitle('');
            setCreateDescription('');
            setMutationError(null);
            setIsCreateOpen(true);
          }}
        >Create issue</Btn>
      </header>

      {mutationError ? (
        <section className="shell-notice shell-notice--error" role="alert">
          <p>{mutationError}</p>
        </section>
      ) : null}

      {!isBacklogView ? (
        <>
          <section style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px var(--pad-x, var(--content-gutter))',
            borderBottom: '1px solid var(--border-subtle)',
            flexWrap: 'wrap', background: 'var(--bg)', flexShrink: 0,
          }} aria-label="Board filters">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '0 8px', height: 24, minWidth: 220,
              border: '1px solid var(--border)', borderRadius: 'var(--r-2)',
            }}>
              <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="m9 9 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </span>
              <input
                ref={boardSearchInputRef}
                aria-label="Search board issues"
                placeholder="Filter by identifier, title…"
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
                    setBoardViewState((currentState) => ({ ...currentState, query: '' }));
                    setActiveSavedBoardViewId('');
                  }
                }}
                style={{ flex: 1, fontSize: 12, color: 'var(--fg)', background: 'transparent', height: 22, border: 'none', outline: 'none' }}
              />
              <kbd>/</kbd>
            </div>

            <details style={{ position: 'relative', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', padding: '2px 8px', borderRadius: 'var(--r-1)', color: 'var(--fg-muted)' }}>States</summary>
              <fieldset style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
                {(selectedTeam?.states.nodes ?? []).map((state) => (
                  <label key={state.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                    <input type="checkbox" checked={boardViewState.stateIds.includes(state.id)} onChange={() => toggleBoardFilterValue('stateIds', state.id)} aria-label={state.name} />
                    {state.name}
                  </label>
                ))}
              </fieldset>
            </details>

            <details style={{ position: 'relative', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', padding: '2px 8px', borderRadius: 'var(--r-1)', color: 'var(--fg-muted)' }}>Labels</summary>
              <fieldset style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
                {labels.map((label) => (
                  <label key={label.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                    <input type="checkbox" checked={boardViewState.labelIds.includes(label.id)} onChange={() => toggleBoardFilterValue('labelIds', label.id)} aria-label={label.name} />
                    {label.name}
                  </label>
                ))}
              </fieldset>
            </details>

            <details style={{ position: 'relative', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', padding: '2px 8px', borderRadius: 'var(--r-1)', color: 'var(--fg-muted)' }}>Assignees</summary>
              <fieldset style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                  <input type="checkbox" checked={boardViewState.assigneeIds.includes('unassigned')} onChange={() => toggleBoardFilterValue('assigneeIds', 'unassigned')} aria-label="Unassigned" />
                  Unassigned
                </label>
                {users.map((user) => (
                  <label key={user.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                    <input type="checkbox" checked={boardViewState.assigneeIds.includes(user.id)} onChange={() => toggleBoardFilterValue('assigneeIds', user.id)} aria-label={user.name ?? user.email ?? user.id} />
                    {user.name ?? user.email}
                  </label>
                ))}
              </fieldset>
            </details>

            {boardViewState.stateIds.map((stateId) => {
              const state = selectedTeam?.states.nodes.find((s) => s.id === stateId);
              return (
                <button key={stateId} type="button" aria-label={`Remove State: ${state?.name ?? stateId}`} onClick={() => toggleBoardFilterValue('stateIds', stateId)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px',
                  fontSize: 11, fontWeight: 500, border: '1px solid var(--border-strong)', borderRadius: 11,
                  background: 'var(--bg-active)', color: 'var(--fg)', cursor: 'pointer',
                }}>
                  State: {state?.name ?? stateId}
                  <span style={{ color: 'var(--fg-dim)', display: 'inline-flex', marginLeft: 2 }}><IcoClose size={10} /></span>
                </button>
              );
            })}

            {boardViewState.assigneeIds.map((assigneeId) => {
              const user = users.find((u) => u.id === assigneeId);
              return (
                <button key={assigneeId} type="button" aria-label={`Remove Assignee: ${assigneeId === 'unassigned' ? 'Unassigned' : (user?.name ?? user?.email ?? assigneeId)}`} onClick={() => toggleBoardFilterValue('assigneeIds', assigneeId)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px',
                  fontSize: 11, fontWeight: 500, border: '1px solid var(--border-strong)', borderRadius: 11,
                  background: 'var(--bg-active)', color: 'var(--fg)', cursor: 'pointer',
                }}>
                  Assignee: {assigneeId === 'unassigned' ? 'Unassigned' : (user?.name ?? user?.email ?? assigneeId)}
                  <span style={{ color: 'var(--fg-dim)', display: 'inline-flex', marginLeft: 2 }}><IcoClose size={10} /></span>
                </button>
              );
            })}

            {boardViewState.labelIds.map((labelId) => {
              const label = labels.find((l) => l.id === labelId);
              return (
                <button key={labelId} type="button" aria-label={`Remove Label: ${label?.name ?? labelId}`} onClick={() => toggleBoardFilterValue('labelIds', labelId)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px',
                  fontSize: 11, fontWeight: 500, border: '1px solid var(--border-strong)', borderRadius: 11,
                  background: 'var(--bg-active)', color: 'var(--fg)', cursor: 'pointer',
                }}>
                  Label: {label?.name ?? labelId}
                  <span style={{ color: 'var(--fg-dim)', display: 'inline-flex', marginLeft: 2 }}><IcoClose size={10} /></span>
                </button>
              );
            })}

            {(boardViewState.query || boardViewState.assigneeIds.length > 0 || boardViewState.stateIds.length > 0 || boardViewState.labelIds.length > 0) ? (
              <button type="button" onClick={resetBoardViewState} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px',
                fontSize: 11, fontWeight: 500, color: 'var(--fg-dim)', cursor: 'pointer',
                background: 'transparent', border: 'none',
              }}>Clear all</button>
            ) : null}

            {activeSavedBoardViewId ? (
              <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                Loaded view: {savedBoardViews.find((v) => v.id === activeSavedBoardViewId)?.name ?? 'Unknown'}
              </span>
            ) : null}

            <div style={{ flex: 1 }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>Sort</span>
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
                style={{ height: 22, padding: '0 6px', fontSize: 11, fontWeight: 500, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)', cursor: 'pointer' }}
              >
                <option value="updatedAt">Updated</option>
                <option value="createdAt">Created</option>
                <option value="identifier">ID</option>
                <option value="title">Title</option>
              </select>
              <select
                aria-label="Sort board direction"
                value={boardViewState.sortDirection}
                onChange={(event) => {
                  setBoardViewState((currentState) => ({
                    ...currentState,
                    sortDirection: event.target.value as 'asc' | 'desc',
                  }));
                  setActiveSavedBoardViewId('');
                }}
                style={{ height: 22, padding: '0 6px', fontSize: 11, fontWeight: 500, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)', cursor: 'pointer' }}
              >
                <option value="asc">Asc</option>
                <option value="desc">Desc</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--fg-dim)', marginRight: 4 }}>Group</span>
              <select
                aria-label="Group board by"
                value={boardViewState.groupBy}
                onChange={(event) => {
                  setBoardViewState((currentState) => ({
                    ...currentState,
                    groupBy: event.target.value as BoardGroupBy,
                  }));
                  setActiveSavedBoardViewId('');
                  setInlineCreateGroupId(null);
                }}
                style={{ height: 22, padding: '0 6px', fontSize: 11, fontWeight: 500, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)', cursor: 'pointer' }}
              >
                <option value="status">Status</option>
                <option value="priority">Priority</option>
                <option value="assignee">Assignee</option>
                <option value="label">Label</option>
                <option value="none">None</option>
              </select>
            </div>

            <details style={{ position: 'relative', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', padding: '2px 8px', borderRadius: 'var(--r-1)', color: 'var(--fg-muted)' }}>Columns</summary>
              <fieldset style={{ position: 'absolute', top: '100%', right: 0, zIndex: 10, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
                {(selectedTeam?.states.nodes ?? []).map((state) => (
                  <label key={state.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!collapsedColumns[state.id]} onChange={() => toggleColumnCollapse(state.id)} aria-label={`Toggle ${state.name} column`} />
                    {state.name}
                  </label>
                ))}
              </fieldset>
            </details>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
              <button type="button" onClick={() => { const name = window.prompt('View name'); if (name) { const nextView: SavedBoardView = { id: crypto.randomUUID(), name, state: { ...boardViewState } }; const nextViews = [...savedBoardViews, nextView]; setSavedBoardViews(nextViews); writeSavedBoardViews(activeTeamKey, nextViews); setActiveSavedBoardViewId(nextView.id); } }} style={{ height: 22, padding: '0 6px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 'var(--r-2)', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer' }}>Save view</button>
              <button type="button" onClick={() => { resetBoardViewState(); setActiveSavedBoardViewId(''); }} style={{ height: 22, padding: '0 6px', fontSize: 11, border: 'none', background: 'transparent', color: 'var(--fg-dim)', cursor: 'pointer' }}>Clear</button>
              <select
                aria-label="Load saved board view"
                value={activeSavedBoardViewId}
                onChange={(event) => {
                  const viewId = event.target.value;
                  setActiveSavedBoardViewId(viewId);
                  const view = savedBoardViews.find((v) => v.id === viewId);
                  if (view) { dispatchApplyBoardView({ state: view.state, viewId: view.id }); }
                }}
                style={{ height: 22, padding: '0 6px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)', cursor: 'pointer' }}
              >
                <option value="">Views</option>
                {savedBoardViews.map((view) => (
                  <option key={view.id} value={view.id}>{view.name}</option>
                ))}
              </select>
            </div>

            <div style={{
              display: 'flex', alignItems: 'center',
              border: '1px solid var(--border)', borderRadius: 'var(--r-2)', padding: 1, marginLeft: 4,
            }}>
              <button type="button" onClick={() => {
                setBoardViewState((s) => ({ ...s, viewMode: 'list' as BoardViewMode }));
                setInlineCreateGroupId(null);
              }} style={{
                height: 20, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontWeight: 500, borderRadius: 'var(--r-1)', border: 'none', cursor: 'pointer',
                color: boardViewState.viewMode === 'list' ? 'var(--fg)' : 'var(--fg-muted)',
                background: boardViewState.viewMode === 'list' ? 'var(--bg-active)' : 'transparent',
              }}>
                <IcoList size={12} /> List
              </button>
              <button type="button" onClick={() => {
                setBoardViewState((s) => ({ ...s, viewMode: 'board' as BoardViewMode }));
                setInlineCreateGroupId(null);
              }} style={{
                height: 20, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontWeight: 500, borderRadius: 'var(--r-1)', border: 'none', cursor: 'pointer',
                color: boardViewState.viewMode === 'board' ? 'var(--fg)' : 'var(--fg-muted)',
                background: boardViewState.viewMode === 'board' ? 'var(--bg-active)' : 'transparent',
              }}>
                <IcoBoard size={12} /> Board
              </button>
            </div>
          </section>

          {selectedIssueIds.length > 0 ? (
            <section style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px var(--pad-x, var(--content-gutter))',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--bg-sunken)', fontSize: 12,
            }} aria-label="Bulk actions">
              <strong style={{ fontSize: 12 }}>{selectedIssueIds.length} selected</strong>
              <button type="button" className="ui-action ui-action--subtle" onClick={selectAllVisibleIssues}>Select all</button>
              <button type="button" className="ui-action ui-action--subtle" onClick={() => setSelectedIssueIds([])}>Clear</button>
              <select aria-label="Bulk move selected issues to state" value={bulkTargetStateId} onChange={(event) => setBulkTargetStateId(event.target.value)}
                style={{ height: 24, padding: '0 6px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)' }}>
                <option value="">Move to…</option>
                {selectedTeam?.states.nodes.map((state) => (<option key={state.id} value={state.id}>{state.name}</option>))}
              </select>
              {bulkTargetStateId ? (
                <button type="button" className="ui-action ui-action--accent" disabled={isSavingState} onClick={() => void applyBulkStateChange()}>Apply to selected</button>
              ) : null}
              <select aria-label="Bulk assign selected issues" value={bulkAssigneeId} onChange={(event) => setBulkAssigneeId(event.target.value)}
                style={{ height: 24, padding: '0 6px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)' }}>
                <option value="">Assign to…</option>
                <option value="unassigned">Unassigned</option>
                {users.map((user) => (<option key={user.id} value={user.id}>{user.name ?? user.email ?? user.id}</option>))}
              </select>
              {bulkAssigneeId ? (
                <button type="button" className="ui-action ui-action--subtle" disabled={isSavingState} onClick={() => void applyBulkAssigneeChange()}>Apply assignee</button>
              ) : null}
              <select aria-label="Bulk add label to selected issues" value={bulkLabelId} onChange={(event) => setBulkLabelId(event.target.value)}
                style={{ height: 24, padding: '0 6px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)' }}>
                <option value="">Add label…</option>
                {labels.map((label) => (<option key={label.id} value={label.id}>{label.name}</option>))}
              </select>
              {bulkLabelId ? (
                <button type="button" className="ui-action ui-action--subtle" disabled={isSavingState} onClick={() => void applyBulkLabelAdd()}>Add label</button>
              ) : null}
              <select aria-label="Bulk remove label from selected issues" value={bulkRemoveLabelId} onChange={(event) => setBulkRemoveLabelId(event.target.value)}
                style={{ height: 24, padding: '0 6px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-2)', color: 'var(--fg)' }}>
                <option value="">Remove label…</option>
                {labels.map((label) => (<option key={label.id} value={label.id}>{label.name}</option>))}
              </select>
              {bulkRemoveLabelId ? (
                <button type="button" className="ui-action ui-action--subtle" disabled={isSavingState} onClick={() => void applyBulkLabelRemove()}>Remove label</button>
              ) : null}
            </section>
          ) : null}
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
          {boardViewState.viewMode === 'board' && boardViewState.groupBy === 'status' ? (
            <section className="board-grid" aria-label="Kanban board">
              {columns.map((column) => (
                <Column
                  key={column.name}
                  title={column.name}
                  stateId={column.stateId}
                  focusedIssueId={focusedIssueId}
                  collapsed={!!collapsedColumns[column.stateId]}
                  onToggleCollapse={() => toggleColumnCollapse(column.stateId)}
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
          ) : boardViewState.viewMode === 'board' ? (
            <KanbanView
              groups={issueGroups}
              focusedIssueId={focusedIssueId}
              selectedIssueIds={selectedIssueIds}
              onSelectIssue={openIssue}
              onToggleIssueSelection={toggleIssueSelection}
              onInlineCreate={(title, meta) => void handleInlineCreate(title, meta)}
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
            />
          ) : (
            <section style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }} aria-label="Issue list">
              {issueGroups.map((group: BoardIssueGroup) => (
                <div key={group.id}>
                  {boardViewState.groupBy !== 'none' && (
                    <div className="issue-group-header">
                      {group.meta?.priority !== undefined && (
                        <PriorityIcon level={group.meta.priority} size={13} />
                      )}
                      <span className="issue-group-header__label">{group.label}</span>
                      <span className="issue-group-header__count">{group.issues.length}</span>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="issue-group-header__create"
                        onClick={() => setInlineCreateGroupId(
                          inlineCreateGroupId === group.id ? null : group.id,
                        )}
                        title="Create issue in this group"
                      >
                        <IcoPlus size={12} />
                      </button>
                    </div>
                  )}
                  {inlineCreateGroupId === group.id && (
                    <InlineCreate
                      contextLabel={group.label}
                      onSubmit={(title) => void handleInlineCreate(title, group.meta)}
                      onCancel={() => setInlineCreateGroupId(null)}
                    />
                  )}
                  {group.issues.map((issue: IssueSummary) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      isFocused={focusedIssueId === issue.id}
                      isSelected={selectedIssueIds.includes(issue.id)}
                      onSelect={openIssue}
                      onToggleSelected={toggleIssueSelection}
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
                    />
                  ))}
                  {group.issues.length === 0 && boardViewState.groupBy !== 'none' && inlineCreateGroupId !== group.id && (
                    <div style={{
                      padding: '10px var(--content-gutter)',
                      fontSize: 12, color: 'var(--fg-faint)',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}>
                      No issues
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

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
