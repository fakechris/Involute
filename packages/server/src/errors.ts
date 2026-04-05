import { GraphQLError } from 'graphql';

export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated';
export const TEAM_NOT_FOUND_MESSAGE = 'Team not found.';
export const ISSUE_NOT_FOUND_MESSAGE = 'Issue not found.';
export const COMMENT_NOT_FOUND_MESSAGE = 'Comment not found.';
export const WORKFLOW_STATE_NOT_FOUND_MESSAGE = 'Workflow state not found.';
export const ISSUE_LABEL_NOT_FOUND_MESSAGE = 'One or more issue labels were not found.';
export const ASSIGNEE_NOT_FOUND_MESSAGE = 'Assignee not found.';
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

const exposedErrorCodes = new Map<string, string>([
  [NOT_AUTHENTICATED_MESSAGE, 'UNAUTHENTICATED'],
  [TEAM_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [COMMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [WORKFLOW_STATE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ISSUE_LABEL_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [ASSIGNEE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PARENT_ISSUE_NOT_FOUND_MESSAGE, 'NOT_FOUND'],
  [PARENT_ISSUE_TEAM_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_SELF_REFERENCE_MESSAGE, 'BAD_USER_INPUT'],
  [PARENT_ISSUE_CYCLE_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_TEAM_CREATE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [WORKFLOW_STATE_TEAM_UPDATE_MISMATCH_MESSAGE, 'BAD_USER_INPUT'],
  [TEAM_HAS_NO_WORKFLOW_STATES_MESSAGE, 'BAD_USER_INPUT'],
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
  if (error instanceof GraphQLError && exposedErrorCodes.has(error.message)) {
    return error;
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
