/**
 * Linear data export pipeline.
 * Exports all relevant data from a Linear workspace to a local directory structure.
 */

import { LinearClient, type PageInfo } from './client.js';
import {
  TEAMS_QUERY,
  WORKFLOW_STATES_QUERY,
  LABELS_QUERY,
  USERS_QUERY,
  ISSUES_QUERY,
  COMMENTS_QUERY,
} from './queries.js';
import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearUser,
  LinearIssue,
  LinearComment,
  ParentChildMapping,
  ExportValidationReport,
} from './types.js';

/** Callback for reporting export progress. */
export type ProgressCallback = (message: string) => void;

// --- GraphQL response shapes ---

interface TeamsResponse {
  teams: { nodes: LinearTeam[]; pageInfo: PageInfo };
}

interface WorkflowStatesResponse {
  workflowStates: { nodes: LinearWorkflowState[]; pageInfo: PageInfo };
}

interface LabelsResponse {
  issueLabels: { nodes: LinearLabel[]; pageInfo: PageInfo };
}

interface UsersResponse {
  users: { nodes: LinearUser[]; pageInfo: PageInfo };
}

interface IssuesResponse {
  issues: { nodes: LinearIssue[]; pageInfo: PageInfo };
}

interface CommentsResponse {
  issue: {
    comments: { nodes: LinearComment[]; pageInfo: PageInfo };
  } | null;
}

// --- Export functions ---

export async function exportTeams(
  client: LinearClient,
  onProgress?: ProgressCallback,
): Promise<LinearTeam[]> {
  onProgress?.('Exporting teams...');
  const teams = await client.paginate<TeamsResponse, LinearTeam>(
    TEAMS_QUERY,
    (data) => data.teams,
  );
  onProgress?.(`  Exported ${String(teams.length)} teams`);
  return teams;
}

export async function exportWorkflowStates(
  client: LinearClient,
  onProgress?: ProgressCallback,
): Promise<LinearWorkflowState[]> {
  onProgress?.('Exporting workflow states...');
  const states = await client.paginate<WorkflowStatesResponse, LinearWorkflowState>(
    WORKFLOW_STATES_QUERY,
    (data) => data.workflowStates,
  );
  onProgress?.(`  Exported ${String(states.length)} workflow states`);
  return states;
}

export async function exportLabels(
  client: LinearClient,
  onProgress?: ProgressCallback,
): Promise<LinearLabel[]> {
  onProgress?.('Exporting labels...');
  const labels = await client.paginate<LabelsResponse, LinearLabel>(
    LABELS_QUERY,
    (data) => data.issueLabels,
  );
  onProgress?.(`  Exported ${String(labels.length)} labels`);
  return labels;
}

export async function exportUsers(
  client: LinearClient,
  onProgress?: ProgressCallback,
): Promise<LinearUser[]> {
  onProgress?.('Exporting users...');
  const users = await client.paginate<UsersResponse, LinearUser>(
    USERS_QUERY,
    (data) => data.users,
  );
  onProgress?.(`  Exported ${String(users.length)} users`);
  return users;
}

export async function exportIssues(
  client: LinearClient,
  onProgress?: ProgressCallback,
): Promise<LinearIssue[]> {
  onProgress?.('Exporting issues...');
  const issues = await client.paginate<IssuesResponse, LinearIssue>(
    ISSUES_QUERY,
    (data) => data.issues,
  );
  onProgress?.(`  Exported ${String(issues.length)} issues`);
  return issues;
}

export async function exportCommentsForIssue(
  client: LinearClient,
  issueId: string,
): Promise<LinearComment[]> {
  const comments = await client.paginate<CommentsResponse, LinearComment>(
    COMMENTS_QUERY,
    (data) => {
      if (!data.issue) {
        return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      }
      return data.issue.comments;
    },
    { issueId },
  );
  return comments;
}

export async function exportAllComments(
  client: LinearClient,
  issues: LinearIssue[],
  onProgress?: ProgressCallback,
): Promise<Map<string, LinearComment[]>> {
  onProgress?.('Exporting comments...');
  const commentsMap = new Map<string, LinearComment[]>();
  let totalComments = 0;

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]!;
    const comments = await exportCommentsForIssue(client, issue.id);
    if (comments.length > 0) {
      commentsMap.set(issue.id, comments);
      totalComments += comments.length;
    }
    if ((i + 1) % 50 === 0 || i === issues.length - 1) {
      onProgress?.(`  Processed comments for ${String(i + 1)}/${String(issues.length)} issues (${String(totalComments)} comments found)`);
    }
  }

  onProgress?.(`  Exported ${String(totalComments)} total comments across ${String(commentsMap.size)} issues`);
  return commentsMap;
}

export interface TeamScopedExportData {
  teams: LinearTeam[];
  workflowStates: LinearWorkflowState[];
  labels: LinearLabel[];
  users: LinearUser[];
  issues: LinearIssue[];
  comments: Map<string, LinearComment[]>;
  parentChildMappings: ParentChildMapping[];
}

/**
 * Filter exported entities down to a single team scope.
 */
export function filterExportDataToTeamScope(
  teamKey: string,
  data: {
    teams: LinearTeam[];
    workflowStates: LinearWorkflowState[];
    labels: LinearLabel[];
    users: LinearUser[];
    issues: LinearIssue[];
    comments: Map<string, LinearComment[]>;
    parentChildMappings: ParentChildMapping[];
  },
): TeamScopedExportData {
  const teams = data.teams.filter((team) => team.key === teamKey);
  const allowedTeamIds = new Set(teams.map((team) => team.id));

  const workflowStates = data.workflowStates.filter((state) =>
    allowedTeamIds.has(state.team.id),
  );

  const issues = data.issues.filter((issue) => allowedTeamIds.has(issue.team.id));
  const allowedIssueIds = new Set(issues.map((issue) => issue.id));
  const allowedLabelIds = new Set<string>();

  for (const issue of issues) {
    for (const label of issue.labels.nodes) {
      allowedLabelIds.add(label.id);
    }
  }

  const comments = new Map<string, LinearComment[]>();
  for (const issue of issues) {
    const issueComments = data.comments.get(issue.id);
    if (issueComments) {
      comments.set(issue.id, issueComments);
    }
  }

  const allowedUserIds = new Set<string>();
  for (const issue of issues) {
    if (issue.assignee) {
      allowedUserIds.add(issue.assignee.id);
    }
  }
  for (const issueComments of comments.values()) {
    for (const comment of issueComments) {
      if (comment.user) {
        allowedUserIds.add(comment.user.id);
      }
    }
  }
  const users = data.users.filter((user) => allowedUserIds.has(user.id));

  const parentChildMappings = data.parentChildMappings.filter(
    (mapping) =>
      allowedIssueIds.has(mapping.parentId) && allowedIssueIds.has(mapping.childId),
  );
  const labels = data.labels.filter((label) => allowedLabelIds.has(label.id));

  return {
    teams,
    workflowStates,
    labels,
    users,
    issues,
    comments,
    parentChildMappings,
  };
}

/**
 * Build parent-child mapping from exported issues.
 */
export function buildParentChildMapping(issues: LinearIssue[]): ParentChildMapping[] {
  const issueById = new Map<string, LinearIssue>();
  for (const issue of issues) {
    issueById.set(issue.id, issue);
  }

  const mappings: ParentChildMapping[] = [];
  for (const issue of issues) {
    if (issue.parent) {
      const parent = issueById.get(issue.parent.id);
      mappings.push({
        parentId: issue.parent.id,
        childId: issue.id,
        parentIdentifier: parent?.identifier,
        childIdentifier: issue.identifier,
      });
    }
  }

  return mappings;
}

/**
 * Generate a validation report summarizing the export.
 */
export function generateValidationReport(
  teams: LinearTeam[],
  workflowStates: LinearWorkflowState[],
  labels: LinearLabel[],
  users: LinearUser[],
  issues: LinearIssue[],
  commentsMap: Map<string, LinearComment[]>,
  parentChildMappings: ParentChildMapping[],
): ExportValidationReport {
  let totalComments = 0;
  for (const comments of commentsMap.values()) {
    totalComments += comments.length;
  }

  return {
    exportedAt: new Date().toISOString(),
    counts: {
      teams: teams.length,
      workflowStates: workflowStates.length,
      labels: labels.length,
      users: users.length,
      issues: issues.length,
      comments: totalComments,
      parentChildRelationships: parentChildMappings.length,
    },
  };
}
