/**
 * Linear export module — barrel file.
 */

export { LinearClient, createLinearClientFromEnv } from './client.js';
export type { LinearClientOptions, PageInfo, GraphQLResponse } from './client.js';

export {
  exportTeams,
  exportWorkflowStates,
  exportLabels,
  exportUsers,
  exportIssues,
  exportCommentsForIssue,
  exportAllComments,
  filterExportDataToTeamScope,
  buildParentChildMapping,
  generateValidationReport,
} from './export.js';
export type { ProgressCallback, TeamScopedExportData } from './export.js';

export { writeExportData } from './writer.js';
export type { ExportData } from './writer.js';

export type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearUser,
  LinearIssue,
  LinearComment,
  ParentChildMapping,
  ExportValidationReport,
} from './types.js';

export {
  TEAMS_QUERY,
  WORKFLOW_STATES_QUERY,
  LABELS_QUERY,
  USERS_QUERY,
  ISSUES_QUERY,
  COMMENTS_QUERY,
} from './queries.js';
