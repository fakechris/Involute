import { GraphQLError } from 'graphql';

export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated';
export const TEAM_NOT_FOUND_MESSAGE = 'Team not found.';
export const ISSUE_NOT_FOUND_MESSAGE = 'Issue not found.';
export const COMMENT_NOT_FOUND_MESSAGE = 'Comment not found.';
export const MEMBERSHIP_NOT_FOUND_MESSAGE = 'Team membership not found.';
export const WORKFLOW_STATE_NOT_FOUND_MESSAGE = 'Workflow state not found.';
export const ISSUE_LABEL_NOT_FOUND_MESSAGE = 'One or more issue labels were not found.';
export const ASSIGNEE_NOT_FOUND_MESSAGE = 'Assignee not found.';
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
export const WORK_LINK_NOT_FOUND_MESSAGE = 'Work link not found.';
export const WORK_LINK_SELF_REFERENCE_MESSAGE = 'Work cannot link to itself.';
export const WORK_LINK_CYCLE_MESSAGE = 'Work link cannot create a cycle.';
export const WORK_LINK_TEAM_MISMATCH_MESSAGE = 'Work links must stay within the same team.';
export const WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE = 'Work link endpoint not found.';
export const WORK_COMMIT_FORBIDDEN_MESSAGE = 'Agents cannot commit work.';
export const WORK_REJECT_FORBIDDEN_MESSAGE = 'Agents cannot reject work.';
export const WORK_ACCEPT_FORBIDDEN_MESSAGE = 'Agents cannot accept or cancel work.';
export const WORK_NOT_CANDIDATE_MESSAGE = 'Only candidate work can be committed or rejected.';
export const WORK_NOT_COMMITTED_MESSAGE = 'Only committed work can be claimed.';
export const WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE =
  'Committed work requires acceptance criteria.';
export const WORK_COMMIT_REQUIRES_OWNER_MESSAGE = 'Committed work requires a human owner.';
export const WORK_OWNER_MUST_BE_HUMAN_MESSAGE = 'Work owner must be a human assignee.';
export const WORK_REVISION_CONFLICT_MESSAGE = 'Work revision does not match expected_revision.';
export const WORK_ALREADY_CLAIMED_MESSAGE = 'Work is already claimed.';
export const WORK_CLAIM_REQUIRES_ACTOR_MESSAGE = 'Claiming work requires an authenticated actor.';
export const WORK_RELATED_NOT_FOUND_MESSAGE = 'Related work not found.';
export const WORK_RUN_NOT_FOUND_MESSAGE = 'Work run not found.';
export const WORK_EVIDENCE_KIND_INVALID_MESSAGE = 'Unknown evidence kind.';
export const WORK_RUN_STATUS_INVALID_MESSAGE = 'Unknown run status.';

const exposedErrorCodes = new Map<string, string>([
  [NOT_AUTHENTICATED_MESSAGE, 'UNAUTHENTICATED'],
  [TEAM_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [COMMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [MEMBERSHIP_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORKFLOW_STATE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_LABEL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ASSIGNEE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
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
  [WORK_LINK_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_LINK_SELF_REFERENCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_CYCLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_TEAM_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_COMMIT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_REJECT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_ACCEPT_FORBIDDEN_MESSAGE, 'FORBIDDEN'],
  [WORK_NOT_CANDIDATE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_NOT_COMMITTED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_COMMIT_REQUIRES_OWNER_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_OWNER_MUST_BE_HUMAN_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_REVISION_CONFLICT_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_ALREADY_CLAIMED_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_CLAIM_REQUIRES_ACTOR_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RELATED_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_RUN_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORK_EVIDENCE_KIND_INVALID_MESSAGE, 'BAD_USER_INPUT'],
  [WORK_RUN_STATUS_INVALID_MESSAGE, 'BAD_USER_INPUT'],
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
