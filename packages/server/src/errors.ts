import { GraphQLError } from 'graphql';

export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated';
export const TEAM_NOT_FOUND_MESSAGE = 'Team not found.';
export const ISSUE_NOT_FOUND_MESSAGE = 'Issue not found.';
export const COMMENT_NOT_FOUND_MESSAGE = 'Comment not found.';
export const COMMENT_PARENT_ISSUE_MISMATCH_MESSAGE =
  'Parent comment belongs to a different work item.';
export const MEMBERSHIP_NOT_FOUND_MESSAGE = 'Team membership not found.';
export const WORKFLOW_STATE_NOT_FOUND_MESSAGE = 'Workflow state not found.';
export const ISSUE_LABEL_NOT_FOUND_MESSAGE = 'One or more issue labels were not found.';
export const ASSIGNEE_NOT_FOUND_MESSAGE = 'Assignee not found.';
export const PROJECT_SCOPE_NOT_FOUND_MESSAGE = 'Project scope not found.';
export const PROJECT_SCOPE_CONFLICT_MESSAGE = 'Project selectors conflict.';
export const PROJECT_SCOPE_AMBIGUOUS_MESSAGE = 'Project scope is ambiguous.';
export const PROJECT_NOT_FOUND_MESSAGE = 'Project not found in the issue team.';
export const CYCLE_NOT_FOUND_MESSAGE = 'Cycle not found in the issue team.';
export const TEAM_OWNER_REQUIRED_MESSAGE = 'Each team must retain at least one owner.';
export const PARENT_ISSUE_NOT_FOUND_MESSAGE = 'Parent issue not found.';
export const PARENT_ISSUE_TEAM_MISMATCH_MESSAGE =
  'Parent issue does not belong to the issue team.';
export const PARENT_ISSUE_SELF_REFERENCE_MESSAGE = 'Issue cannot be its own parent.';
export const PARENT_ISSUE_CYCLE_MESSAGE = 'Issue parent relationship cannot create a cycle.';
export const WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE =
  'Workflow state does not belong to the specified team.';
export const WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE =
  'Workflow state does not belong to the issue team.';
export const TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE =
  'The selected team does not have any workflow states.';
export const TEAM_WRITE_FORBIDDEN_MESSAGE = 'You do not have edit access to this team.';
export const TEAM_MANAGE_FORBIDDEN_MESSAGE = 'You do not have access to manage this team.';
export const TEAM_ROSTER_HUMANS_ONLY_MESSAGE =
  'Team membership is a human roster. An agent or service is bound to a team by its credential, not by a membership role.';
export const ACTOR_MANAGE_FORBIDDEN_MESSAGE =
  'You do not have access to manage this actor: only an admin or its owner may. Owning a team it is bound to lets you revoke that team\'s credential, nothing more.';
export const WORK_LINK_NOT_FOUND_MESSAGE = 'Work link not found.';
export const WORK_LINK_SELF_REFERENCE_MESSAGE = 'Work cannot link to itself.';
export const WORK_LINK_CYCLE_MESSAGE = 'Work link cannot create a cycle.';
export const WORK_LINK_TEAM_MISMATCH_MESSAGE = 'Work links must stay within the same team.';
export const WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE = 'Work link endpoint not found.';
export const WORK_COMMIT_FORBIDDEN_MESSAGE = 'Agents cannot commit work.';
export const WORK_REJECT_FORBIDDEN_MESSAGE = 'Agents cannot reject work.';
export const WORK_ACCEPT_FORBIDDEN_MESSAGE = 'Agents cannot accept or cancel work.';
export const WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE =
  'Agents cannot rewrite committed contract fields; ask a human to update acceptance, scope, verification, outcome, or constraints under "Edit contract" on the issue page (/issue/<id>#contract).';
export const WORK_NOT_CANDIDATE_MESSAGE = 'Only candidate work can be committed or rejected.';
export const WORK_NOT_COMMITTED_MESSAGE = 'Only committed work can be claimed.';
export const WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE =
  'Committed work requires acceptance criteria.';
export const WORK_COMMIT_REQUIRES_OWNER_MESSAGE = 'Committed work requires a human owner.';
export const WORK_COMMIT_REQUIRES_PARENT_MESSAGE =
  'Committed work requires a parent: place it under a PROJECT, MILESTONE, EPIC or parent ISSUE (CONTAINS) before committing, or pass parentId with the commit.';
export const WORK_COMMIT_PARENT_REJECTED_MESSAGE = 'The parent of committed work cannot be rejected work.';
// Hierarchy rules (graph-integrity.ts), exposed so mutations can say why.
export const CONTAINS_KINDS_MESSAGE =
  'CONTAINS allows PROJECT → MILESTONE/DECISION/EPIC/ISSUE, MILESTONE → EPIC/ISSUE, EPIC → ISSUE, ISSUE → ISSUE.';
export const CONTAINS_REPOSITORY_REQUIRED_MESSAGE = 'CONTAINS requires an explicit repository on both endpoints.';
export const CONTAINS_REPOSITORY_WHITESPACE_MESSAGE = 'CONTAINS repository values must not have surrounding whitespace.';
export const CONTAINS_CROSS_REPOSITORY_MESSAGE = 'CONTAINS cannot cross repository boundaries.';
export const CONTAINS_MULTIPLE_PARENTS_MESSAGE = 'CONTAINS cannot have multiple parents; use an explicit parent update.';
export const HIERARCHY_PARENT_MISSING_MESSAGE = 'Hierarchy parent does not exist.';
export const ISSUE_TYPE_EXCLUSIVE_MESSAGE = 'An item has at most one Type: Bug, Feature or Improvement.';
export const BUG_REPORT_PRIORITY_REQUIRED_MESSAGE = 'A bug report needs a priority (Urgent, High, Medium or Low).';
export const BUG_REPORT_STEPS_REQUIRED_MESSAGE = 'A bug report needs steps to reproduce.';
export const BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE = 'Committing a bug needs a priority (Urgent, High, Medium or Low): it sets the SLA.';
export const BUG_PROPOSE_PRIORITY_REQUIRED_MESSAGE = 'Proposing a bug needs a priority (Urgent, High, Medium or Low): it sets the SLA.';
export const BUG_PROPOSE_PARENT_REQUIRED_MESSAGE =
  'A bug is committed directly (it does not go to Candidates): pass parent_id, or related_work_id so it can inherit a parent.';
export const BUG_PROPOSE_STEPS_REQUIRED_MESSAGE =
  'A bug is committed directly (it does not go to Candidates): pass steps_to_reproduce.';
export const BUG_PROPOSE_OWNER_REQUIRED_MESSAGE =
  'A bug is committed directly (it does not go to Candidates): the filing agent needs a human owner on this team.';
export const BUG_REJECT_REASON_REQUIRED_MESSAGE = 'Declining a bug needs a reason (zero-bug: fix it or say why not).';
export const BUG_NO_BACKLOG_MESSAGE = 'Bugs do not go to the backlog (zero-bug): commit to fixing it, or decline it with a reason.';
export const TRIAGE_ROTATION_INVALID_MESSAGE = 'A triage rotation lists human members of the team and a valid start date.';
export const CLAIM_RELEASE_FORBIDDEN_MESSAGE = 'Only a person can release a claim.';
export const ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE =
  'Only a human may deactivate or reactivate an actor, transfer its ownership, or declare its successor.';
export const REQUEST_ANSWER_STATE_INVALID_MESSAGE = 'An answer state is completed, failed or input-required.';
export const ACTOR_SUCCESSOR_INVALID_MESSAGE = 'A successor is another active actor, not the actor itself.';
export const WORK_RESTORE_FORBIDDEN_MESSAGE = 'Only a person can restore a rejected candidate.';
export const WORK_RESTORE_NOT_REJECTED_MESSAGE = 'Only rejected work can be restored to a candidate.';
export const WORK_RESTORE_REASON_REQUIRED_MESSAGE = 'Restoring rejected work needs a reason.';
export const CLAIM_RELEASE_REASON_REQUIRED_MESSAGE = 'Releasing a claim needs a reason; the agent and its owner are told.';
export const CLAIM_RELEASE_NO_CLAIM_MESSAGE = 'This work has no claim to release.';
export const ISSUE_CREATE_REQUIRES_PARENT_MESSAGE =
  'New work requires a parent: choose its project (No milestone), a MILESTONE, EPIC or parent ISSUE. Only a PROJECT is created without one.';
export const WORK_COMMIT_PARENT_CONFLICT_MESSAGE =
  'This candidate already has a different parent; move it with an explicit parent update instead of passing another parentId at commit.';
export const WORK_OWNER_MUST_BE_HUMAN_MESSAGE = 'Work owner must be a human assignee.';
export const WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE = 'Work owner must belong to the work team.';
export const WORK_READY_STATE_MISSING_MESSAGE = 'Team workflow is missing an unstarted state.';
export const WORK_REVISION_CONFLICT_MESSAGE = 'Work revision does not match expected_revision.';
export const WORK_IDEMPOTENCY_CONFLICT_MESSAGE =
  'Idempotency key was already used with a different request.';
export const WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE =
  'Idempotent operation result is no longer available.';
export const WORK_ALREADY_CLAIMED_MESSAGE = 'Work is already claimed.';
export const WORK_NOT_READY_MESSAGE = 'Work is not ready to be claimed.';
// Why it is not ready, and what to do about it (INV-808): one generic refusal
// left agents guessing — a Backlog item looked unclaimable when one work_update
// would have made it ready.
export const WORK_NOT_READY_STATE_MESSAGE =
  'Work is not ready to be claimed: it is not in Ready or In Progress (for example it is in Backlog). Move it to Ready first: MCP work_update with state "UNSTARTED", or the state menu in the web app.';
export const WORK_NOT_READY_ACCEPTANCE_MESSAGE =
  'Work is not ready to be claimed: it has no acceptance criteria. Add them first (work_update acceptance).';
export const WORK_NOT_READY_OWNER_MESSAGE =
  'Work is not ready to be claimed: it is not assigned to a person. Assign it in the web app first.';
export const WORK_NOT_READY_BLOCKED_MESSAGE =
  'Work is not ready to be claimed: an open item blocks it. Finish the blocker, or remove the BLOCKS link if it no longer applies.';
export const WORK_NOT_READY_LABEL_MESSAGE =
  'Work is not ready to be claimed: it carries the "blocked" or "needs-clarification" label. Remove the label once it is resolved.';
export const WORK_CLAIM_REQUIRES_ACTOR_MESSAGE = 'Claiming work requires an authenticated actor.';
export const WORK_RELATED_NOT_FOUND_MESSAGE = 'Related work not found.';
export const WORK_RUN_NOT_FOUND_MESSAGE =
  'Work run not found. To start a new run, omit run_id (the server assigns RUN-N automatically). Only pass run_id when updating an existing run.';
export const WORK_EVIDENCE_KIND_INVALID_MESSAGE = 'Unknown evidence kind.';
export const WORK_RUN_STATUS_INVALID_MESSAGE = 'Unknown run status.';
export const WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE =
  'Reporting a run requires an active claim owned by the current actor.';
export const WORK_RUN_ACTOR_MISMATCH_MESSAGE = 'Only the run actor can update this run.';
export const WORK_RUN_TERMINAL_MESSAGE = 'Completed or failed runs cannot be changed.';
export const WORK_RUN_TERMINAL_REPLAY_MESSAGE =
  'This run is already completed or failed. Only a proven idempotent replay (same idempotencyKey, identical content) is accepted; anything else is refused rather than silently dropped. Attach further evidence with evidence_attach, or comment on the work item.';
export const WORK_RUN_TRANSITION_INVALID_MESSAGE = 'Invalid work run status transition.';
export const WORK_RUN_CONFLICT_MESSAGE = 'Work run changed while the update was in progress.';
export const WORK_EVIDENCE_REQUIRES_RUN_MESSAGE = 'Evidence must reference a work run.';
export const WORK_REVIEW_REQUIRED_MESSAGE = 'Work is not awaiting review.';
export const WORK_REVIEW_STATE_MISSING_MESSAGE = 'Team workflow is missing a required semantic state.';
export const UPLOAD_TOO_LARGE_MESSAGE = 'Upload exceeds the 10 MB size limit.';
export const WEBHOOK_NOT_FOUND_MESSAGE = 'Webhook subscription not found.';
export const WEBHOOK_URL_INVALID_MESSAGE = 'Webhook URL must be a valid absolute http(s) URL.';
export const WEBHOOK_EVENT_TYPE_INVALID_MESSAGE = 'Unknown webhook event type.';
export const AGENT_SCOPE_INVALID_MESSAGE = 'Unknown agent scope.';
export const AGENT_EMAIL_INVALID_MESSAGE = 'Agent email must look like an email address (name@host).';
export const AGENT_HANDLE_INVALID_MESSAGE = 'Agent handle must be 1–32 characters of a-z, 0-9, _ or -, starting with a letter or digit.';
export const AGENT_HANDLE_TAKEN_MESSAGE = 'That handle already belongs to another actor.';
export const AGENT_CREDENTIAL_NOT_FOUND_MESSAGE = 'Agent credential not found.';
export const REQUEST_NOT_FOUND_MESSAGE = 'Request not found.';
export const NOTIFICATION_NOT_FOUND_MESSAGE = 'Notification not found.';
export const SNOOZE_REQUIRES_CANDIDATE_MESSAGE = 'Only candidate work can be snoozed.';
export const AGENT_DESCRIPTION_REQUIRED_MESSAGE =
  "Agent proposals require a rich structured Chinese description with three sections: '### 1. 目标与架构定位', '### 2. 核心功能与交付范围', and '### 3. 验收标准与验证方案'. Lazy references (e.g. 'ref docs/...') are strictly rejected.";
// Dynamic IQL failures carry this prefix; getExposedError lets them through so
// agents see exactly which term failed to parse.
export const IQL_PARSE_ERROR_PREFIX = 'Invalid IQL query:';

// Project reference alias (INV-793): the prefix PRs may use instead of the team key.
export const PROJECT_ALIAS_FORMAT_MESSAGE = 'A project alias is 2 to 10 letters, such as LUM.';
export const PROJECT_ALIAS_KIND_MESSAGE = 'Only a PROJECT can have a reference alias.';
export const PROJECT_ALIAS_TAKEN_MESSAGE = 'That alias is already a team key or another project\'s alias.';

// Workspace settings (INV-797).
export const SETTINGS_ADMIN_ONLY_MESSAGE = 'Workspace settings can be changed by admins only.';
export const LABEL_NOT_FOUND_MESSAGE = 'Label not found.';
export const LABEL_NAME_INVALID_MESSAGE = 'A label name is 1 to 50 characters.';
export const LABEL_NAME_TAKEN_MESSAGE = 'A label with that name already exists (names ignore case).';
export const LABEL_PROTECTED_MESSAGE =
  'Bug, Feature, Improvement and research are built in: the Type group and the research rules depend on them, so they cannot be renamed or deleted.';
export const LABEL_TYPE_NAME_RESERVED_MESSAGE = 'Bug, Feature and Improvement are the Type labels; another label cannot take those names.';
export const USER_NOT_FOUND_MESSAGE = 'User not found.';
export const WORKFLOW_STATE_NAME_INVALID_MESSAGE = 'A state name is 1 to 40 characters and unique within its team.';
export const WORKFLOW_STATE_IN_USE_MESSAGE = 'This state still holds work; move that work to another state first.';
export const WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE =
  'Each team keeps at least one state of every type: agents and GitHub move work by type, not by name.';
export const GLOBAL_ROLE_TARGET_HUMAN_MESSAGE = 'Admin rights go to people; agents and services act through their credentials.';
export const GLOBAL_ROLE_LAST_ADMIN_MESSAGE = 'The workspace needs at least one admin.';

export function createScopeForbiddenError(scope: string): GraphQLError {
  return new GraphQLError(`Agent credential lacks required scope: ${scope}.`, {
    extensions: { code: 'FORBIDDEN' },
  });
}

const exposedErrorCodes = new Map<string, string>([
  [NOT_AUTHENTICATED_MESSAGE, 'UNAUTHENTICATED'],
  [TEAM_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [COMMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [COMMENT_PARENT_ISSUE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [MEMBERSHIP_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORKFLOW_STATE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_LABEL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ASSIGNEE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PROJECT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PROJECT_SCOPE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PROJECT_SCOPE_CONFLICT_MESSAGE, 'PROJECT_SCOPE_CONFLICT'],
  [PROJECT_SCOPE_AMBIGUOUS_MESSAGE, 'PROJECT_SCOPE_AMBIGUOUS'],
  [CYCLE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [TEAM_OWNER_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PARENT_ISSUE_TEAM_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_SELF_REFERENCE_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_CYCLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_WRITE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [TEAM_MANAGE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [ACTOR_MANAGE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_LINK_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_LINK_SELF_REFERENCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_CYCLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_TEAM_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_COMMIT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_REJECT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_ACCEPT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_CONTRACT_UPDATE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_NOT_CANDIDATE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_COMMITTED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_OWNER_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_PARENT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_PARENT_REJECTED_MESSAGE, 'BAD_USER_INPUT'],
  [ISSUE_CREATE_REQUIRES_PARENT_MESSAGE, 'BAD_USER_INPUT'],
  [ISSUE_TYPE_EXCLUSIVE_MESSAGE, 'BAD_USER_INPUT'],
  [CLAIM_RELEASE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_RESTORE_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [ACTOR_LIFECYCLE_HUMAN_ONLY_MESSAGE, 'FORBIDDEN'],
  [ACTOR_SUCCESSOR_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [REQUEST_ANSWER_STATE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RESTORE_NOT_REJECTED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RESTORE_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CLAIM_RELEASE_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CLAIM_RELEASE_NO_CLAIM_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_PRIORITY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_PARENT_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_STEPS_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_PROPOSE_OWNER_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_REJECT_REASON_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_NO_BACKLOG_MESSAGE, 'BAD_USER_INPUT'],
  [TRIAGE_ROTATION_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_REPORT_PRIORITY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [BUG_REPORT_STEPS_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_KINDS_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_REPOSITORY_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_REPOSITORY_WHITESPACE_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_CROSS_REPOSITORY_MESSAGE, 'BAD_USER_INPUT'],
  [CONTAINS_MULTIPLE_PARENTS_MESSAGE, 'BAD_USER_INPUT'],
  [HIERARCHY_PARENT_MISSING_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_PARENT_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_OWNER_MUST_BE_HUMAN_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_READY_STATE_MISSING_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVISION_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_IDEMPOTENCY_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_ALREADY_CLAIMED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_STATE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_ACCEPTANCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_OWNER_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_BLOCKED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_READY_LABEL_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_CLAIM_REQUIRES_ACTOR_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RELATED_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_RUN_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_EVIDENCE_KIND_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_STATUS_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_ACTOR_MISMATCH_MESSAGE, 'FORBIDDEN'],
  [WORK_RUN_TERMINAL_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_TRANSITION_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_EVIDENCE_REQUIRES_RUN_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVIEW_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVIEW_STATE_MISSING_MESSAGE, 'BAD_USER_INPUT'],
  [UPLOAD_TOO_LARGE_MESSAGE, 'BAD_USER_INPUT'],
  [WEBHOOK_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WEBHOOK_URL_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WEBHOOK_EVENT_TYPE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_SCOPE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_EMAIL_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_HANDLE_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_HANDLE_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_CREDENTIAL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [NOTIFICATION_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [SNOOZE_REQUIRES_CANDIDATE_MESSAGE, 'BAD_USER_INPUT'],
  [AGENT_DESCRIPTION_REQUIRED_MESSAGE, 'BAD_USER_INPUT'],
  [PROJECT_ALIAS_FORMAT_MESSAGE, 'BAD_USER_INPUT'],
  [PROJECT_ALIAS_KIND_MESSAGE, 'BAD_USER_INPUT'],
  [PROJECT_ALIAS_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [SETTINGS_ADMIN_ONLY_MESSAGE, 'FORBIDDEN'],
  [LABEL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [LABEL_NAME_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [LABEL_NAME_TAKEN_MESSAGE, 'BAD_USER_INPUT'],
  [LABEL_PROTECTED_MESSAGE, 'BAD_USER_INPUT'],
  [LABEL_TYPE_NAME_RESERVED_MESSAGE, 'BAD_USER_INPUT'],
  [USER_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORKFLOW_STATE_NAME_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_IN_USE_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE, 'BAD_USER_INPUT'],
  [GLOBAL_ROLE_TARGET_HUMAN_MESSAGE, 'BAD_USER_INPUT'],
  [GLOBAL_ROLE_LAST_ADMIN_MESSAGE, 'BAD_USER_INPUT'],
]);

export function createNotAuthenticatedError(): GraphQLError {
  return createExposedError(NOT_AUTHENTICATED_MESSAGE);
}

export function createNotFoundError(message: string): GraphQLError {
  return createExposedError(message);
}

export function createValidationError(message: string): GraphQLError {
  return createExposedError(message);
}

export function getExposedError(error: unknown): GraphQLError | null {
  if (
    error instanceof GraphQLError &&
    typeof error.extensions?.code === 'string' &&
    exposedErrorCodes.get(error.message) === error.extensions.code
  ) {
    return createExposedError(error.message);
  }

  // IQL parse failures survive masking by message prefix: wrappers may drop
  // extensions or re-class the error across module copies, but the message
  // text is always preserved.
  const iqlMessage = error instanceof Error && error.message.startsWith(IQL_PARSE_ERROR_PREFIX)
    ? error.message
    : error instanceof GraphQLError &&
        error.originalError instanceof Error &&
        error.originalError.message.startsWith(IQL_PARSE_ERROR_PREFIX)
      ? error.originalError.message
      : null;
  if (iqlMessage) {
    return new GraphQLError(iqlMessage, {
      extensions: { code: 'IQL_PARSE' },
    });
  }

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const exposedCause = cause ? getExposedError(cause) : null;

    if (exposedCause) {
      return exposedCause;
    }

    if (exposedErrorCodes.has(error.message)) {
      return createExposedError(error.message);
    }
  }

  return null;
}

/**
 * Checks whether an error is a Prisma error caused by invalid input
 * (e.g., passing a non-UUID string to a UUID column). These should be
 * treated as graceful failures rather than server crashes.
 *
 * Covers:
 * - PrismaClientValidationError (malformed input like non-UUID strings)
 * - PrismaClientKnownRequestError with code P2023 (inconsistent column data)
 * - PrismaClientKnownRequestError with code P2025 (record not found)
 */
export function isPrismaInvalidInputError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const tag = (error as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];

  if (tag === 'PrismaClientValidationError') {
    return true;
  }

  if (tag === 'PrismaClientKnownRequestError') {
    const code = (error as { code?: string }).code;

    return code === 'P2023' || code === 'P2025';
  }

  return false;
}

function createExposedError(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code: exposedErrorCodes.get(message) ?? 'BAD_USER_INPUT',
    },
  });
}
