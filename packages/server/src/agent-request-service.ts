import { createHash, randomBytes } from 'node:crypto';

import {
  CLAIMABLE_REQUEST_STATES,
  isTerminalState,
  toWireState,
  type A2aRequestState,
} from './agent-request-state.js';
import { createNotFoundError, createValidationError } from './errors.js';
import { syncCommentMentions } from './mention-service.js';

import type {
  AgentRequest,
  AgentRequestState,
  Prisma,
  PrismaClient,
  WorkEvidenceKind,
} from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Same idea as the outbox flush lease: a dead consumer must not hold a request forever. */
export const REQUEST_CLAIM_LEASE_MS = 60_000;
export const DEFAULT_REQUEST_DEADLINE_MS = 24 * 60 * 60 * 1_000;
export const MAX_INBOX_PAGE = 50;

export const REQUEST_NOT_FOUND_MESSAGE = 'Agent request not found.';
export const REQUEST_NOT_CLAIMABLE_MESSAGE =
  'Agent request is not claimable: it is already claimed by another consumer, or it has reached a terminal state.';
export const REQUEST_NOT_HELD_MESSAGE =
  'Agent request is not held by this actor with a live claim.';
export const CLAIM_SUPERSEDED_MESSAGE =
  'Claim superseded: a newer execution of this actor holds the request. Re-read the inbox and claim again.';
export const CLAIM_TOKEN_REQUIRED_MESSAGE =
  'A claim token is required to answer; it was returned by agent_request_claim.';

const CLAIM_TOKEN_PREFIX = 'inv_claim_';

function mintClaimToken(): string {
  return `${CLAIM_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function hashClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export const REQUEST_ALREADY_TERMINAL_MESSAGE =
  'Agent request has already reached a terminal state and cannot be answered again.';
export const ANSWER_REQUIRES_BODY_MESSAGE = 'An answer must have a body.';

export interface CreateAgentRequestInput {
  body: string;
  deadlineAt?: Date | null;
  idempotencyKey?: string | null;
  payingPrincipal?: string | null;
  requestedByActorId: string;
  rootCommentId: string;
  targetActorId: string;
  workId: string;
}

export async function createAgentRequest(
  db: DatabaseClient,
  input: CreateAgentRequestInput,
  now: Date = new Date(),
): Promise<AgentRequest> {
  const deadlineAt = input.deadlineAt ?? new Date(now.getTime() + DEFAULT_REQUEST_DEADLINE_MS);

  // The idempotency key is what makes a replayed comment write (or a retried
  // transaction) land one request rather than two.
  if (input.idempotencyKey) {
    const existing = await db.agentRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return existing;
    }
  }

  return db.agentRequest.create({
    data: {
      body: input.body,
      deadlineAt,
      idempotencyKey: input.idempotencyKey ?? null,
      payingPrincipal: input.payingPrincipal ?? null,
      requestedByActorId: input.requestedByActorId,
      rootCommentId: input.rootCommentId,
      state: 'SUBMITTED',
      targetActorId: input.targetActorId,
      workId: input.workId,
    },
  });
}

export interface AgentInboxItem {
  body: string;
  claimedBy: string | null;
  createdAt: Date;
  deadlineAt: Date;
  id: string;
  requestedByActorId: string;
  rootCommentId: string;
  state: A2aRequestState;
  workId: string;
  workIdentifier: string;
}

export interface AgentInboxPage {
  cursor: string | null;
  items: AgentInboxItem[];
}

/**
 * Requests addressed to one actor. Keyset pagination on `(createdAt, id)` so a
 * consumer polling `since` never skips a request that was inserted while it was
 * reading the previous page.
 */
export async function readAgentInbox(
  db: DatabaseClient,
  input: {
    actorId: string;
    cursor?: string | null;
    first?: number | null;
    since?: Date | null;
    states?: AgentRequestState[] | null;
  },
): Promise<AgentInboxPage> {
  const take = Math.min(Math.max(input.first ?? 20, 1), MAX_INBOX_PAGE);
  const where: Prisma.AgentRequestWhereInput = {
    targetActorId: input.actorId,
    state: { in: input.states ?? ['SUBMITTED', 'WORKING', 'INPUT_REQUIRED'] },
  };

  if (input.since) {
    where.createdAt = { gt: input.since };
  }

  const requests = await db.agentRequest.findMany({
    where,
    include: { work: { select: { identifier: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = requests.slice(0, take);
  const hasMore = requests.length > take;

  return {
    cursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    items: page.map((request) => ({
      body: request.body,
      claimedBy: request.claimedBy,
      createdAt: request.createdAt,
      deadlineAt: request.deadlineAt,
      id: request.id,
      requestedByActorId: request.requestedByActorId,
      rootCommentId: request.rootCommentId,
      state: toWireState(request.state),
      workId: request.workId,
      workIdentifier: request.work.identifier,
    })),
  };
}

export interface ClaimedAgentRequest {
  /** Present to renew, and to answer. Persist it with the execution; it is not recoverable. */
  claimToken: string;
  request: AgentRequest;
}

/**
 * Takes the claim for one *execution*, or renews the one this execution holds.
 *
 * A claim belongs to an execution, not to an actor. Two sessions can carry the
 * same actor credential, and the first version let either of them renew by
 * actor alone — so a stalled session could wake up and answer a request that a
 * fresh session had already re-claimed (INV-573 P1). Now every take mints a new
 * generation and a token; renewing and answering require the token. An
 * execution that lost its token waits for its own lease to lapse and then takes
 * a new generation, exactly like any other consumer.
 *
 * Both moves are single-statement CAS, so two consumers racing on the same
 * request cannot both succeed regardless of interleaving.
 */
export async function claimAgentRequest(
  prisma: PrismaClient,
  input: { actorId: string; claimToken?: string | null; id: string; leaseMs?: number },
  now: Date = new Date(),
): Promise<ClaimedAgentRequest> {
  const leaseMs = input.leaseMs ?? REQUEST_CLAIM_LEASE_MS;
  const expiresAt = new Date(now.getTime() + leaseMs);

  // Renewal: same execution, proven by the token, lease still live.
  if (input.claimToken) {
    const renewed = await prisma.agentRequest.updateMany({
      where: {
        id: input.id,
        targetActorId: input.actorId,
        claimedBy: input.actorId,
        claimTokenHash: hashClaimToken(input.claimToken),
        claimExpiresAt: { gt: now },
        state: { in: [...CLAIMABLE_REQUEST_STATES] },
      },
      data: { claimExpiresAt: expiresAt },
    });

    if (renewed.count === 1) {
      return {
        claimToken: input.claimToken,
        request: await prisma.agentRequest.findUniqueOrThrow({ where: { id: input.id } }),
      };
    }
  }

  // Take: unclaimed, or the previous holder's lease has lapsed. Deliberately
  // *not* "or held by this same actor" — that is the hole.
  const claimToken = mintClaimToken();
  const taken = await prisma.agentRequest.updateMany({
    where: {
      id: input.id,
      targetActorId: input.actorId,
      state: { in: [...CLAIMABLE_REQUEST_STATES] },
      OR: [
        { claimedBy: null },
        { claimExpiresAt: { lt: now } },
      ],
    },
    data: {
      claimExpiresAt: expiresAt,
      claimGeneration: { increment: 1 },
      claimTokenHash: hashClaimToken(claimToken),
      claimedAt: now,
      claimedBy: input.actorId,
      state: 'WORKING',
    },
  });

  if (taken.count === 0) {
    const existing = await prisma.agentRequest.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
    }
    if (input.claimToken && existing.claimedBy === input.actorId) {
      throw createValidationError(CLAIM_SUPERSEDED_MESSAGE);
    }
    throw createValidationError(REQUEST_NOT_CLAIMABLE_MESSAGE);
  }

  return {
    claimToken,
    request: await prisma.agentRequest.findUniqueOrThrow({ where: { id: input.id } }),
  };
}

export interface AnswerEvidenceInput {
  kind: WorkEvidenceKind;
  summary?: string | null;
  url: string;
}

export interface AnswerAgentRequestInput {
  actorId: string;
  body: string;
  /** From agent_request_claim. Proves this is the execution that holds the claim. */
  claimToken: string;
  evidence?: AnswerEvidenceInput[] | null;
  id: string;
  /** `completed` (default), `failed`, or `input-required` when asking back. */
  state?: Extract<A2aRequestState, 'completed' | 'failed' | 'input-required'>;
}

export interface AnsweredAgentRequest {
  commentId: string;
  request: AgentRequest;
}

/**
 * Posts the answer and moves the request, in one transaction.
 *
 * Two rules decide the shape here:
 *
 * 1. The answer comment is authored by the *answering actor*, not by whatever
 *    process is carrying its token (docs/54 §E3). Otherwise every answer looks
 *    like it came from the same person again.
 * 2. `completed` is reached only after `answeredCommentId` is set. A failed
 *    answer therefore cannot leave the request looking answered (A3).
 */
export async function answerAgentRequest(
  prisma: PrismaClient,
  input: AnswerAgentRequestInput,
  now: Date = new Date(),
): Promise<AnsweredAgentRequest> {
  const body = input.body.trim();
  if (!body) {
    throw createValidationError(ANSWER_REQUIRES_BODY_MESSAGE);
  }
  if (!input.claimToken) {
    throw createValidationError(CLAIM_TOKEN_REQUIRED_MESSAGE);
  }
  const presentedTokenHash = hashClaimToken(input.claimToken);

  const wireState = input.state ?? 'completed';
  const nextState: AgentRequestState = wireState === 'completed'
    ? 'COMPLETED'
    : wireState === 'failed'
      ? 'FAILED'
      : 'INPUT_REQUIRED';

  return prisma.$transaction(async (tx) => {
    const request = await tx.agentRequest.findUnique({ where: { id: input.id } });

    if (!request) {
      throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
    }

    if (isTerminalState(request.state)) {
      throw createValidationError(REQUEST_ALREADY_TERMINAL_MESSAGE);
    }

    // Holding a live claim *for this execution* is the right to answer. The
    // actor alone is not enough: a stalled session of the same actor must not
    // be able to answer after a fresh session re-claimed.
    const sameActor = request.claimedBy === input.actorId;
    const sameExecution = sameActor && request.claimTokenHash === presentedTokenHash;
    const leaseLive = request.claimExpiresAt !== null && request.claimExpiresAt > now;

    if (sameActor && !sameExecution) {
      throw createValidationError(CLAIM_SUPERSEDED_MESSAGE);
    }
    if (!sameExecution || !leaseLive) {
      throw createValidationError(REQUEST_NOT_HELD_MESSAGE);
    }

    // The answer lands in the thread the question was asked in, so two
    // parallel questions on one work item do not cross (INV-561).
    const comment = await tx.comment.create({
      data: {
        body,
        issueId: request.workId,
        parentCommentId: request.rootCommentId,
        userId: input.actorId,
      },
    });

    await syncCommentMentions(tx, comment.id, comment.body);

    for (const item of input.evidence ?? []) {
      await tx.workEvidence.create({
        data: {
          actorId: input.actorId,
          kind: item.kind,
          summary: item.summary ?? null,
          url: item.url,
          workId: request.workId,
        },
      });
    }

    // CAS again rather than a plain update: the row may have moved between the
    // read above and here.
    const moved = await tx.agentRequest.updateMany({
      where: {
        id: request.id,
        claimedBy: input.actorId,
        claimTokenHash: presentedTokenHash,
        state: { in: [...CLAIMABLE_REQUEST_STATES] },
      },
      data: {
        answeredCommentId: comment.id,
        // Handing back invalidates the execution's token: the next holder
        // takes a fresh generation.
        ...(nextState === 'INPUT_REQUIRED'
          ? { claimExpiresAt: null, claimTokenHash: null, claimedBy: null }
          : {}),
        state: nextState,
      },
    });

    if (moved.count === 0) {
      throw createValidationError(REQUEST_NOT_HELD_MESSAGE);
    }

    return {
      commentId: comment.id,
      request: await tx.agentRequest.findUniqueOrThrow({ where: { id: request.id } }),
    };
  });
}

export async function cancelAgentRequest(
  prisma: PrismaClient,
  input: { id: string },
  now: Date = new Date(),
): Promise<AgentRequest> {
  const moved = await prisma.agentRequest.updateMany({
    where: { id: input.id, state: { in: [...CLAIMABLE_REQUEST_STATES] } },
    data: { canceledAt: now, state: 'CANCELED' },
  });

  if (moved.count === 0) {
    const existing = await prisma.agentRequest.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
    }
    throw createValidationError(REQUEST_ALREADY_TERMINAL_MESSAGE);
  }

  return prisma.agentRequest.findUniqueOrThrow({ where: { id: input.id } });
}
