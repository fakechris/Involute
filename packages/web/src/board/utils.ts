import { BOARD_COLUMN_ORDER } from './constants';
import type {
  BoardColumn,
  BoardPageQueryData,
  Html5BoardDragPayload,
  IssueSummary,
  TeamSummary,
  WorkflowStateSummary,
} from './types';
import { readLocalStorageValue } from '../lib/storage';

export const ACTIVE_TEAM_STORAGE_KEY = 'involute.activeTeamKey';
export const OPEN_CREATE_ISSUE_EVENT = 'involute:open-create-issue';

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
    } else {
      window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, teamKey);
    }
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }

  window.dispatchEvent(
    new CustomEvent<string | null>('involute:active-team-key', {
      detail: teamKey,
    }),
  );
}

export function parseHtml5BoardDragPayload(rawPayload: string): Html5BoardDragPayload | null {
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

export function createHtml5BoardDragPayload(issueId: string, stateId: string): string {
  return JSON.stringify({
    issueId,
    stateId,
  } satisfies Html5BoardDragPayload);
}

export function getBoardColumns(team: TeamSummary | null, issues: IssueSummary[] = []): BoardColumn[] {
  const statesById = new Map<string, WorkflowStateSummary>();

  for (const state of team?.states.nodes ?? []) {
    statesById.set(state.id, state);
  }

  for (const issue of issues) {
    if (!statesById.has(issue.state.id)) {
      statesById.set(issue.state.id, issue.state);
    }
  }

  return [...statesById.values()]
    .sort((left, right) => compareBoardStates(left.name, right.name))
    .map((state) => ({
      name: state.name,
      stateId: state.id,
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
  columns: BoardColumn[],
): Record<string, IssueSummary[]> {
  const groups = Object.fromEntries(
    columns.map((column) => [column.stateId, [] as IssueSummary[]]),
  ) as Record<string, IssueSummary[]>;

  for (const issue of issues) {
    const stateId = issue.state.id;

    if (!groups[stateId]) {
      groups[stateId] = [];
    }

    groups[stateId].push(issue);
  }

  return groups;
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

export function mergeBoardPageQueryResults(
  previousResult: BoardPageQueryData,
  fetchMoreResult: BoardPageQueryData | undefined,
): BoardPageQueryData {
  if (!fetchMoreResult) {
    return previousResult;
  }

  const issueById = new Map(previousResult.issues.nodes.map((issue) => [issue.id, issue]));

  for (const issue of fetchMoreResult.issues.nodes) {
    issueById.set(issue.id, issue);
  }

  return {
    ...fetchMoreResult,
    issues: {
      nodes: [...issueById.values()],
      pageInfo: fetchMoreResult.issues.pageInfo,
    },
  };
}

export function mergeBoardIssues(
  baseIssues: IssueSummary[],
  issueOverrides: Record<string, IssueSummary>,
  createdIssues: IssueSummary[],
  deletedIssueIds: string[],
): IssueSummary[] {
  const deletedIssueIdSet = new Set(deletedIssueIds);
  const baseIssueIds = new Set(baseIssues.map((issue) => issue.id));
  const nextCreatedIssues = createdIssues
    .filter((issue) => !baseIssueIds.has(issue.id) && !deletedIssueIdSet.has(issue.id))
    .map((issue) => issueOverrides[issue.id] ?? issue);
  const nextBaseIssues = baseIssues
    .filter((issue) => !deletedIssueIdSet.has(issue.id))
    .map((issue) => issueOverrides[issue.id] ?? issue);
  const seenIssueIds = new Set([
    ...nextBaseIssues.map((issue) => issue.id),
    ...nextCreatedIssues.map((issue) => issue.id),
  ]);
  const nextOrphanOverrides = Object.values(issueOverrides).filter(
    (issue) => !seenIssueIds.has(issue.id) && !deletedIssueIdSet.has(issue.id),
  );

  return [...nextCreatedIssues, ...nextOrphanOverrides, ...nextBaseIssues];
}

export function reconcileIssueOverrides(
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

export function reconcileCreatedIssues(
  baseIssues: IssueSummary[],
  createdIssues: IssueSummary[],
): IssueSummary[] {
  const nextCreatedIssues = createdIssues.filter(
    (issue) => !baseIssues.some((baseIssue) => baseIssue.id === issue.id),
  );

  return nextCreatedIssues.length === createdIssues.length ? createdIssues : nextCreatedIssues;
}

export function replaceIssueOverride(
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

function compareBoardStates(leftName: string, rightName: string): number {
  const defaultBoardOrder = BOARD_COLUMN_ORDER as readonly string[];
  const leftIndex = defaultBoardOrder.indexOf(leftName);
  const rightIndex = defaultBoardOrder.indexOf(rightName);
  const leftOrder = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
  const rightOrder = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return leftName.localeCompare(rightName);
}

function areIssuesEquivalent(left: IssueSummary, right: IssueSummary): boolean {
  return (
    left.id === right.id &&
    left.identifier === right.identifier &&
    left.title === right.title &&
    (left.description ?? null) === (right.description ?? null) &&
    left.updatedAt === right.updatedAt &&
    left.state.id === right.state.id &&
    left.team.key === right.team.key &&
    (left.assignee?.id ?? null) === (right.assignee?.id ?? null) &&
    areArraysEqualIgnoringOrder(
      left.labels.nodes.map((label) => label.id),
      right.labels.nodes.map((label) => label.id),
    ) &&
    areArraysEqualIgnoringOrder(
      left.children.nodes.map((child) => child.id),
      right.children.nodes.map((child) => child.id),
    ) &&
    (left.parent?.id ?? null) === (right.parent?.id ?? null) &&
    areCommentsEquivalent(left.comments.nodes, right.comments.nodes)
  );
}

function areCommentsEquivalent(
  leftComments: IssueSummary['comments']['nodes'],
  rightComments: IssueSummary['comments']['nodes'],
): boolean {
  const leftComparable = [...leftComments]
    .sort(compareIssueComments)
    .map((comment) => ({
      body: comment.body,
      createdAt: comment.createdAt,
      id: comment.id,
      userId: comment.user?.id ?? null,
    }));
  const rightComparable = [...rightComments]
    .sort(compareIssueComments)
    .map((comment) => ({
      body: comment.body,
      createdAt: comment.createdAt,
      id: comment.id,
      userId: comment.user?.id ?? null,
    }));

  if (leftComparable.length !== rightComparable.length) {
    return false;
  }

  return leftComparable.every((comment, index) => {
    const otherComment = rightComparable[index];

    return (
      otherComment !== undefined &&
      comment.id === otherComment.id &&
      comment.body === otherComment.body &&
      comment.createdAt === otherComment.createdAt &&
      comment.userId === otherComment.userId
    );
  });
}

function compareIssueComments(
  left: IssueSummary['comments']['nodes'][number],
  right: IssueSummary['comments']['nodes'][number],
): number {
  const createdAtComparison = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

function areArraysEqualIgnoringOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();

  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
