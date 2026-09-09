// packages/server/src/github-webhook-state-machine.ts
// Dual-Track CAS State Machine for GitHub Webhook events.
//
// Channel A: Monotonic forward CAS — atomic single-statement updateMany with
//            relation filter on strictly lower-rank workflow states and LWW guard.
// Channel B: Restricted provenance rollback — atomic single-statement updateMany
//            requiring state: { type: 'REVIEW' } and stateSourcePrId: prId.
//
// Terminal absorbing states: COMPLETED, CANCELED — no event can move out of these.

import type { Prisma, WorkflowStateType } from '@prisma/client';

export const LOWER_RANK_TYPES_OF: Record<WorkflowStateType, WorkflowStateType[]> = {
  BACKLOG: [],
  UNSTARTED: ['BACKLOG'],
  STARTED: ['BACKLOG', 'UNSTARTED'],
  REVIEW: ['BACKLOG', 'UNSTARTED', 'STARTED'],
  COMPLETED: ['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW'],
  CANCELED: ['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW'],
};

const STATE_TYPE_RANK: Record<string, number> = {
  BACKLOG: 0,
  UNSTARTED: 1,
  STARTED: 2,
  REVIEW: 3,
  COMPLETED: 4,
  CANCELED: 5,
};

type TransactionClient = Prisma.TransactionClient;

export interface StateTransitionResult {
  applied: boolean;
  duplicate?: boolean;
  reason: string;
  issueId: string;
  previousStateType?: string;
  newStateType?: string;
}

export interface MonotonicForwardInput {
  issueId: string;
  teamId: string;
  targetStateType: WorkflowStateType;
  eventSourceKey: string;
  eventType: string;
  /** PR id that caused this transition (set stateSourcePrId when moving to REVIEW) */
  sourcePrId?: string;
  payload?: Prisma.InputJsonValue | undefined;
  eventTimestamp?: string | Date;
}

export interface ProvenanceRollbackInput {
  issueId: string;
  teamId: string;
  prId: string;
  eventSourceKey: string;
  eventType: string;
  payload?: Prisma.InputJsonValue | undefined;
  eventTimestamp?: string | Date;
}

/**
 * Record webhook event in WebhookEventLog with physical unique constraint.
 * Checks findUnique first to avoid PostgreSQL transaction abort (25P02) on duplicate delivery.
 * Catches P2002 as fallback for concurrent collisions.
 */
async function recordEventLog(
  tx: TransactionClient,
  input: {
    issueId: string;
    eventSourceKey: string;
    eventType: string;
    payload?: Prisma.InputJsonValue | undefined;
  },
): Promise<boolean> {
  const existing = await tx.webhookEventLog.findUnique({
    where: {
      issueId_eventSourceKey: {
        issueId: input.issueId,
        eventSourceKey: input.eventSourceKey,
      },
    },
  });
  if (existing) {
    return false;
  }

  try {
    await tx.webhookEventLog.create({
      data: {
        issueId: input.issueId,
        eventSourceKey: input.eventSourceKey,
        eventType: input.eventType,
        payload: input.payload ?? {},
      },
    });
    return true;
  } catch (error: unknown) {
    const prismaError = error as { code?: string; message?: string };
    if (prismaError?.code === 'P2002' || prismaError?.message?.includes('unique constraint')) {
      return false; // Duplicate delivery
    }
    throw error;
  }
}

/**
 * Channel A: Atomic Monotonic Forward CAS
 *
 * Executes single-statement conditional updateMany:
 * - State must be strictly lower rank than targetStateType
 * - Absorbing states (COMPLETED, CANCELED) are never in LOWER_RANK_TYPES_OF
 * - LWW guard: lastAppliedEventTime must be null or <= incoming eventTimestamp
 */
export async function applyMonotonicForward(
  tx: TransactionClient,
  input: MonotonicForwardInput,
): Promise<StateTransitionResult> {
  const isNewEvent = await recordEventLog(tx, {
    issueId: input.issueId,
    eventSourceKey: input.eventSourceKey,
    eventType: input.eventType,
    payload: input.payload,
  });

  if (!isNewEvent) {
    return {
      applied: false,
      duplicate: true,
      reason: `Event already processed: ${input.eventSourceKey}`,
      issueId: input.issueId,
    };
  }

  // Resolve target workflow state for this team
  const targetState = await tx.workflowState.findFirst({
    where: {
      teamId: input.teamId,
      type: input.targetStateType,
    },
  });

  if (!targetState) {
    return {
      applied: false,
      reason: `No workflow state of type ${input.targetStateType} found for team ${input.teamId}`,
      issueId: input.issueId,
    };
  }

  const eventDate = input.eventTimestamp ? new Date(input.eventTimestamp) : new Date();
  const lowerTypes = LOWER_RANK_TYPES_OF[input.targetStateType];

  // Atomic CAS update: executes at the DB engine level, safe under concurrent executions
  const updateResult = await tx.issue.updateMany({
    where: {
      id: input.issueId,
      state: {
        type: { in: lowerTypes },
      },
      OR: [
        { lastAppliedEventTime: null },
        { lastAppliedEventTime: { lte: eventDate } },
      ],
    },
    data: {
      stateId: targetState.id,
      stateSourcePrId: input.targetStateType === 'REVIEW' ? (input.sourcePrId ?? null) : null,
      lastAppliedEventTime: eventDate,
    },
  });

  if (updateResult.count > 0) {
    return {
      applied: true,
      reason: `Atomic CAS transitioned to ${input.targetStateType}`,
      issueId: input.issueId,
      newStateType: input.targetStateType,
    };
  }

  // If atomic update matched 0 rows, inspect current state to determine descriptive reason
  const current = await tx.issue.findUnique({
    where: { id: input.issueId },
    include: { state: true },
  });

  if (!current) {
    return {
      applied: false,
      reason: `Issue not found: ${input.issueId}`,
      issueId: input.issueId,
    };
  }

  const currentType = current.state.type;
  const currentRank = STATE_TYPE_RANK[currentType] ?? -1;
  const targetRank = STATE_TYPE_RANK[input.targetStateType] ?? -1;

  if (currentType === 'COMPLETED' || currentType === 'CANCELED') {
    return {
      applied: false,
      reason: `Issue is in absorbing terminal state: ${currentType}`,
      issueId: input.issueId,
      previousStateType: currentType,
    };
  }

  if (current.lastAppliedEventTime && eventDate < current.lastAppliedEventTime) {
    return {
      applied: false,
      reason: `Out-of-order event: incoming time ${eventDate.toISOString()} is older than lastAppliedEventTime ${current.lastAppliedEventTime.toISOString()}`,
      issueId: input.issueId,
      previousStateType: currentType,
    };
  }

  return {
    applied: false,
    reason: `Current state ${currentType} (rank ${currentRank}) >= target ${input.targetStateType} (rank ${targetRank})`,
    issueId: input.issueId,
    previousStateType: currentType,
  };
}

/**
 * Channel B: Atomic Restricted Provenance Rollback CAS
 *
 * Executes single-statement conditional updateMany:
 * - State must be currently REVIEW
 * - stateSourcePrId must match input.prId exactly
 * - LWW guard: lastAppliedEventTime must be null or <= incoming eventTimestamp
 */
export async function applyProvenanceRollback(
  tx: TransactionClient,
  input: ProvenanceRollbackInput,
): Promise<StateTransitionResult> {
  const isNewEvent = await recordEventLog(tx, {
    issueId: input.issueId,
    eventSourceKey: input.eventSourceKey,
    eventType: input.eventType,
    payload: input.payload,
  });

  if (!isNewEvent) {
    return {
      applied: false,
      duplicate: true,
      reason: `Event already processed: ${input.eventSourceKey}`,
      issueId: input.issueId,
    };
  }

  // Resolve STARTED state for this team
  const startedState = await tx.workflowState.findFirst({
    where: {
      teamId: input.teamId,
      type: 'STARTED',
    },
  });

  if (!startedState) {
    return {
      applied: false,
      reason: `No STARTED workflow state found for team ${input.teamId}`,
      issueId: input.issueId,
    };
  }

  const eventDate = input.eventTimestamp ? new Date(input.eventTimestamp) : new Date();

  // Atomic CAS rollback: executes at the DB engine level
  const rollbackResult = await tx.issue.updateMany({
    where: {
      id: input.issueId,
      state: {
        type: 'REVIEW',
      },
      stateSourcePrId: input.prId,
      OR: [
        { lastAppliedEventTime: null },
        { lastAppliedEventTime: { lte: eventDate } },
      ],
    },
    data: {
      stateId: startedState.id,
      stateSourcePrId: null,
      lastAppliedEventTime: eventDate,
    },
  });

  if (rollbackResult.count > 0) {
    return {
      applied: true,
      reason: `Atomic CAS provenance rollback: REVIEW → STARTED (source PR ${input.prId})`,
      issueId: input.issueId,
      previousStateType: 'REVIEW',
      newStateType: 'STARTED',
    };
  }

  // If 0 rows updated, inspect issue for descriptive reason
  const current = await tx.issue.findUnique({
    where: { id: input.issueId },
    include: { state: true },
  });

  if (!current) {
    return {
      applied: false,
      reason: `Issue not found: ${input.issueId}`,
      issueId: input.issueId,
    };
  }

  const currentType = current.state.type;

  if (currentType !== 'REVIEW') {
    return {
      applied: false,
      reason: `Provenance rollback requires current state REVIEW, got ${currentType}`,
      issueId: input.issueId,
      previousStateType: currentType,
    };
  }

  if (current.stateSourcePrId !== input.prId) {
    return {
      applied: false,
      reason: `Provenance mismatch: stateSourcePrId=${current.stateSourcePrId} != prId=${input.prId}`,
      issueId: input.issueId,
      previousStateType: currentType,
    };
  }

  if (current.lastAppliedEventTime && eventDate < current.lastAppliedEventTime) {
    return {
      applied: false,
      reason: `Out-of-order event: incoming time ${eventDate.toISOString()} is older than lastAppliedEventTime ${current.lastAppliedEventTime.toISOString()}`,
      issueId: input.issueId,
      previousStateType: currentType,
    };
  }

  return {
    applied: false,
    reason: `Provenance rollback condition not met`,
    issueId: input.issueId,
    previousStateType: currentType,
  };
}
