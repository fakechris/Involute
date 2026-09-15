import type { AgentRequestState } from '@prisma/client';

/**
 * A2A task states, borrowed rather than invented (docs/54 §B2). The wire
 * spelling is A2A's exactly — including the hyphen in `input-required`, which
 * a Prisma enum identifier cannot carry, hence this mapping.
 */
export const A2A_REQUEST_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
] as const;

export type A2aRequestState = (typeof A2A_REQUEST_STATES)[number];

const TO_WIRE: Record<AgentRequestState, A2aRequestState> = {
  SUBMITTED: 'submitted',
  WORKING: 'working',
  INPUT_REQUIRED: 'input-required',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
};

const FROM_WIRE: Record<A2aRequestState, AgentRequestState> = {
  'submitted': 'SUBMITTED',
  'working': 'WORKING',
  'input-required': 'INPUT_REQUIRED',
  'completed': 'COMPLETED',
  'failed': 'FAILED',
  'canceled': 'CANCELED',
};

/** States a request can no longer leave. */
export const TERMINAL_REQUEST_STATES: readonly AgentRequestState[] = [
  'COMPLETED',
  'FAILED',
  'CANCELED',
];

/** States from which a consumer may take (or renew) the claim. */
export const CLAIMABLE_REQUEST_STATES: readonly AgentRequestState[] = [
  'SUBMITTED',
  'WORKING',
  'INPUT_REQUIRED',
];

export function toWireState(state: AgentRequestState): A2aRequestState {
  return TO_WIRE[state];
}

export function fromWireState(value: string): AgentRequestState | null {
  return FROM_WIRE[value as A2aRequestState] ?? null;
}

export function isTerminalState(state: AgentRequestState): boolean {
  return TERMINAL_REQUEST_STATES.includes(state);
}
