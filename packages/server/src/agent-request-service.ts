import { createHash, randomBytes } from 'node:crypto';

import {
  CLAIMABLE_REQUEST_STATES,
  isTerminalState,
  toWireState,
  type A2aRequestState,
} from './agent-request-state.js';
import { createNotFoundError, createValidationError, exposeErrorMessages } from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { syncCommentMentions } from './mention-service.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';
import { attachDecisionReceipt, type ReceiptInput } from './decision-receipt.js';

import type {
  AgentRequest,
  AgentRequestState,
  Prisma,
  PrismaClient,
  WorkEvidenceKind,
} from '@prisma/client';
import { resolveAttentionNotifications } from './notification-service.js';

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
  /** A needinfo raised explicitly to a named person (INV-1119). */
  needInfo?: boolean;
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
      needInfo: input.needInfo ?? false,
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
  /** Set only on a request handed off from another (INV-609); null otherwise. */
  handOff: HandOffOrigin | null;
  /** A needinfo (INV-1119): any comment you write on the work answers it. */
  needInfo: boolean;
}

/**
 * Where a handed-off request came from (INV-609), so whoever receives it can
 * answer in their own name and say who they stand in for (docs/54 §D).
 */
export interface HandOffOrigin {
  handedOffFromId: string;
  /** The previous target's handle — "standing in for @ada". Null if it had none. */
  handedOffFromHandle: string | null;
  hopCount: number;
  rootRequestId: string | null;
}

/** The hand-off origin of each request that has one, keyed by request id. */
export async function readHandOffOrigins(
  db: DatabaseClient,
  requests: Array<Pick<AgentRequest, 'id' | 'handedOffFromId' | 'hopCount' | 'rootRequestId'>>,
): Promise<Map<string, HandOffOrigin>> {
  const handedOff = requests.filter((request) => request.handedOffFromId);
  const origins = new Map<string, HandOffOrigin>();
  if (handedOff.length === 0) return origins;
  const previous = await db.agentRequest.findMany({
    where: { id: { in: handedOff.map((request) => request.handedOffFromId!) } },
    select: { id: true, targetActor: { select: { handle: true } } },
  });
  const handles = new Map(previous.map((request) => [request.id, request.targetActor.handle]));
  for (const request of handedOff) {
    origins.set(request.id, {
      handedOffFromId: request.handedOffFromId!,
      handedOffFromHandle: handles.get(request.handedOffFromId!) ?? null,
      hopCount: request.hopCount,
      rootRequestId: request.rootRequestId,
    });
  }
  return origins;
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
    /** Only requests on this team's work — the acting credential's binding (INV-594). */
    teamId?: string | null;
  },
): Promise<AgentInboxPage> {
  const take = Math.min(Math.max(input.first ?? 20, 1), MAX_INBOX_PAGE);
  const where: Prisma.AgentRequestWhereInput = {
    targetActorId: input.actorId,
    state: { in: input.states ?? ['SUBMITTED', 'WORKING', 'INPUT_REQUIRED'] },
    ...(input.teamId ? { work: { teamId: input.teamId } } : {}),
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
  const origins = await readHandOffOrigins(db, page);

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
      handOff: origins.get(request.id) ?? null,
      needInfo: request.needInfo,
    })),
  };
}

export type AgentRequestEvent = 'claimed' | 'renewed' | 'answered' | 'canceled' | 'expired' | 'handed-off' | 'replied' | 'needinfo';

/**
 * Audit a request event on its work item (INV-587). The issue itself is not
 * changed, so `before` and `after` are the same snapshot — that is also what
 * keeps these rows from reading as "this actor proposed the work" (a creation
 * audit is the one with no `before`). The event, the request and the claim
 * generation are what a receipt (INV-588) will attach to.
 */
export async function recordRequestAudit(
  tx: Prisma.TransactionClient,
  input: {
    actor: WriteActor;
    claimGeneration?: number | null;
    event: AgentRequestEvent;
    request: Pick<AgentRequest, 'id' | 'workId'>;
  },
): Promise<string> {
  const work = await tx.issue.findUniqueOrThrow({ where: { id: input.request.workId } });
  const snapshot = selectIssueSnapshot(work);
  return recordWorkAudit(tx, {
    actor: {
      ...input.actor,
      reason: input.actor.reason ? `${input.event}; ${input.actor.reason}` : input.event,
      sourceMessageId: input.request.id,
      surface: `agent_request.${input.event}`,
    },
    after: snapshot,
    before: snapshot,
    claimGeneration: input.claimGeneration ?? null,
    workId: input.request.workId,
  });
}

async function actorKindOf(db: DatabaseClient, actorId: string): Promise<WriteActor['actorKind']> {
  const actor = await db.user.findUnique({ where: { id: actorId }, select: { actorKind: true } });
  return actor?.actorKind ?? 'AGENT';
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
  input: { actorId: string; claimToken?: string | null; id: string; leaseMs?: number; sessionId?: string | null },
  now: Date = new Date(),
): Promise<ClaimedAgentRequest> {
  const leaseMs = input.leaseMs ?? REQUEST_CLAIM_LEASE_MS;
  const expiresAt = new Date(now.getTime() + leaseMs);

  return prisma.$transaction(async (tx) => {
    // Renewal: same execution, proven by the token, lease still live.
    if (input.claimToken) {
      const renewed = await tx.agentRequest.updateMany({
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
        const request = await tx.agentRequest.findUniqueOrThrow({ where: { id: input.id } });
        await recordRequestAudit(tx, {
          actor: { actorId: input.actorId, actorKind: await actorKindOf(tx, input.actorId), sessionId: input.sessionId ?? null },
          claimGeneration: request.claimGeneration,
          event: 'renewed',
          request,
        });
        return { claimToken: input.claimToken, request };
      }
    }

    // Take: unclaimed, or the previous holder's lease has lapsed. Deliberately
    // *not* "or held by this same actor" — that is the hole.
    const claimToken = mintClaimToken();
    const taken = await tx.agentRequest.updateMany({
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
      const existing = await tx.agentRequest.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
      }
      if (input.claimToken && existing.claimedBy === input.actorId) {
        throw createValidationError(CLAIM_SUPERSEDED_MESSAGE);
      }
      throw createValidationError(REQUEST_NOT_CLAIMABLE_MESSAGE);
    }

    const request = await tx.agentRequest.findUniqueOrThrow({ where: { id: input.id } });
    await recordRequestAudit(tx, {
      actor: { actorId: input.actorId, actorKind: await actorKindOf(tx, input.actorId), sessionId: input.sessionId ?? null },
      claimGeneration: request.claimGeneration,
      event: 'claimed',
      request,
    });
    return { claimToken, request };
  });
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
  /** The execution's session id, recorded on the audit for later context. */
  sessionId?: string | null;
  /** What the answerer knew and why — attached to the answer's audit (INV-588). */
  receipt?: ReceiptInput | null;
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

    const answeredAuditId = await recordRequestAudit(tx, {
      actor: { actorId: input.actorId, actorKind: await actorKindOf(tx, input.actorId), sessionId: input.sessionId ?? null },
      claimGeneration: request.claimGeneration,
      event: 'answered',
      request,
    });

    if (input.receipt) {
      await attachDecisionReceipt(tx, { auditId: answeredAuditId, receipt: input.receipt });
    }
    if (request.needInfo && nextState !== 'INPUT_REQUIRED') {
      await settleNeedInfoAnswered(tx, request, { answeredById: input.actorId, commentId: comment.id });
    }
    if (nextState === 'INPUT_REQUIRED') {
      await notifyRequesterAskedBack(tx, request, { commentId: comment.id, askedById: input.actorId });
    }

    return {
      commentId: comment.id,
      request: await tx.agentRequest.findUniqueOrThrow({ where: { id: request.id } }),
    };
  });
}

export const HUMAN_ANSWER_NOT_TARGET_MESSAGE =
  'Only the person this request is addressed to may answer it. An admin may answer on their behalf with an override reason.';
export const HUMAN_ANSWER_OVERRIDE_REASON_REQUIRED_MESSAGE = 'Answering on someone else\'s behalf requires an override reason.';

export interface HumanAnswerInput {
  body: string;
  by: { actorId: string; actorKind: WriteActor['actorKind']; globalRole: 'ADMIN' | 'USER' | 'GUEST' };
  id: string;
  /** Required when an ADMIN answers a request addressed to someone else. Recorded on the audit. */
  overrideReason?: string | null;
  /**
   * `completed` (default); `failed` when it cannot be done; `input-required`
   * to ask the requester back — the same choices an agent has (INV-794).
   */
  state?: 'completed' | 'failed' | 'input-required' | null;
}

/**
 * A request handed to a person is completed by that person (INV-596).
 *
 * No claim token: a human holds no execution. The right to answer is being
 * the request's current target — or being an ADMIN who says, on the record,
 * why they are answering for someone else. Comment, answeredCommentId, the
 * move to COMPLETED, the audit and the event land in one transaction; the
 * move is a CAS on state, so a late or repeated submission is refused rather
 * than producing a second answer. An ordinary thread reply stays an ordinary
 * reply: the system never guesses that a comment was meant as the answer.
 */
export async function answerAgentRequestAsHuman(
  prisma: PrismaClient,
  input: HumanAnswerInput,
): Promise<AnsweredAgentRequest> {
  const body = input.body.trim();
  if (!body) {
    throw createValidationError(ANSWER_REQUIRES_BODY_MESSAGE);
  }
  if (input.by.actorKind !== 'HUMAN') {
    throw createValidationError(HUMAN_ANSWER_NOT_TARGET_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.agentRequest.findUnique({
      where: { id: input.id },
      include: { targetActor: { select: { actorKind: true, id: true } }, work: { select: { id: true, identifier: true, teamId: true } } },
    });
    if (!request) {
      throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
    }
    if (isTerminalState(request.state)) {
      throw createValidationError(REQUEST_ALREADY_TERMINAL_MESSAGE);
    }
    if (request.state === 'INPUT_REQUIRED') {
      throw createValidationError(REQUEST_AWAITING_REPLY_MESSAGE);
    }

    const isTarget = request.targetActorId === input.by.actorId;
    const override = !isTarget;
    if (override) {
      if (input.by.globalRole !== 'ADMIN') {
        throw createValidationError(HUMAN_ANSWER_NOT_TARGET_MESSAGE);
      }
      if (!input.overrideReason?.trim()) {
        throw createValidationError(HUMAN_ANSWER_OVERRIDE_REASON_REQUIRED_MESSAGE);
      }
    }

    const comment = await tx.comment.create({
      data: { body, issueId: request.workId, parentCommentId: request.rootCommentId, userId: input.by.actorId },
    });
    await syncCommentMentions(tx, comment.id, comment.body);

    const humanState: AgentRequestState =
      input.state === 'failed' ? 'FAILED' : input.state === 'input-required' ? 'INPUT_REQUIRED' : 'COMPLETED';
    // Not while it waits on the requester: their reply would then be refused.
    const moved = await tx.agentRequest.updateMany({
      where: { id: request.id, state: { in: CLAIMABLE_REQUEST_STATES.filter((state) => state !== 'INPUT_REQUIRED') } },
      data: {
        answeredCommentId: comment.id,
        claimExpiresAt: null,
        claimTokenHash: null,
        claimedBy: null,
        state: humanState,
      },
    });
    if (moved.count === 0) {
      throw createValidationError(REQUEST_ALREADY_TERMINAL_MESSAGE);
    }

    await recordRequestAudit(tx, {
      actor: {
        actorId: input.by.actorId,
        actorKind: 'HUMAN',
        ...(override ? { reason: `override: ${input.overrideReason!.trim()}` } : {}),
      },
      event: 'answered',
      request,
    });

    await enqueueWorkEvent(tx, {
      payload: {
        answeredByActorId: input.by.actorId,
        commentId: comment.id,
        override: override ? input.overrideReason!.trim() : null,
        requestId: request.id,
        rootCommentId: request.rootCommentId,
        targetActorId: request.targetActorId,
      },
      type: 'agent.request_answered',
      workId: request.work.id,
      workIdentifier: request.work.identifier,
    });
    // The person it was handed to has answered it (INV-1093).
    await resolveAttentionNotifications(tx, {
      kind: 'AGENT_REQUEST',
      payload: { key: 'requestId', value: request.id },
      resolution: 'answered',
      resolvedById: input.by.actorId,
      types: ['agent.request_handed_off'],
    });
    if (request.needInfo && humanState !== 'INPUT_REQUIRED') {
      await settleNeedInfoAnswered(tx, request, { answeredById: input.by.actorId, commentId: comment.id });
    }
    if (humanState === 'INPUT_REQUIRED') {
      await notifyRequesterAskedBack(tx, request, { commentId: comment.id, askedById: input.by.actorId });
    }

    return {
      commentId: comment.id,
      request: await tx.agentRequest.findUniqueOrThrow({ where: { id: request.id } }),
    };
  });
}

export async function cancelAgentRequest(
  prisma: PrismaClient,
  input: { by: WriteActor; id: string },
  now: Date = new Date(),
): Promise<AgentRequest> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.agentRequest.updateMany({
      where: { id: input.id, state: { in: [...CLAIMABLE_REQUEST_STATES] } },
      data: { canceledAt: now, state: 'CANCELED' },
    });

    if (moved.count === 0) {
      const existing = await tx.agentRequest.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
      }
      throw createValidationError(REQUEST_ALREADY_TERMINAL_MESSAGE);
    }

    const request = await tx.agentRequest.findUniqueOrThrow({ where: { id: input.id } });
    await recordRequestAudit(tx, { actor: input.by, event: 'canceled', request });
    return request;
  });
}

/**
 * A needinfo was answered (INV-1119): the notification that asked for it is
 * resolved for its target, and whoever asked — person or agent — is told, so
 * an agent waiting on a person reads the answer in agent_inbox (and is woken
 * on its push channel) instead of polling the thread.
 */
export async function settleNeedInfoAnswered(
  tx: Prisma.TransactionClient,
  request: Pick<AgentRequest, 'id' | 'workId' | 'requestedByActorId' | 'targetActorId' | 'rootCommentId'>,
  input: { answeredById: string; commentId: string },
): Promise<void> {
  await resolveAttentionNotifications(tx, {
    kind: 'AGENT_REQUEST',
    payload: { key: 'requestId', value: request.id },
    resolution: 'answered',
    resolvedById: input.answeredById,
    types: ['needinfo.requested'],
  });
  const work = await tx.issue.findUniqueOrThrow({ where: { id: request.workId }, select: { id: true, identifier: true, teamId: true, title: true } });
  const payload = {
    answeredById: input.answeredById,
    commentId: input.commentId,
    requestId: request.id,
    rootCommentId: request.rootCommentId,
    targetActorId: request.targetActorId,
  };
  const event = await enqueueWorkEvent(tx, { payload, type: 'needinfo.answered', workId: work.id, workIdentifier: work.identifier });
  if (request.requestedByActorId === input.answeredById) return;
  const requester = await tx.user.findUnique({ where: { id: request.requestedByActorId }, select: { deactivatedAt: true, id: true } });
  if (!requester || requester.deactivatedAt) return;
  await tx.notification.createMany({
    data: [{
      payload: { ...payload, identifier: work.identifier, title: work.title },
      sourceEventId: event.id,
      teamId: work.teamId,
      type: 'needinfo.answered',
      userId: requester.id,
      workId: work.id,
    }],
    skipDuplicates: true,
  });
}

/**
 * The target asked the requester back (INV-794): tell the requester, who can
 * then reply in the thread from the work page (agentRequestReply).
 */
async function notifyRequesterAskedBack(
  tx: Prisma.TransactionClient,
  request: Pick<AgentRequest, 'id' | 'workId' | 'requestedByActorId' | 'rootCommentId'>,
  input: { commentId: string; askedById: string },
): Promise<void> {
  const [requester, work] = await Promise.all([
    tx.user.findUnique({ where: { id: request.requestedByActorId }, select: { id: true, actorKind: true } }),
    tx.issue.findUniqueOrThrow({ where: { id: request.workId }, select: { id: true, identifier: true, teamId: true, title: true } }),
  ]);
  const payload = { requestId: request.id, commentId: input.commentId, askedById: input.askedById, rootCommentId: request.rootCommentId };
  const event = await enqueueWorkEvent(tx, {
    payload,
    type: 'agent.request_input_required',
    workId: work.id,
    workIdentifier: work.identifier,
  });
  if (requester?.actorKind !== 'HUMAN' || requester.id === input.askedById) return;
  await tx.notification.createMany({
    data: [{
      payload: { ...payload, identifier: work.identifier, title: work.title },
      sourceEventId: event.id,
      teamId: work.teamId,
      type: 'agent.request_input_required',
      userId: requester.id,
      workId: work.id,
    }],
    skipDuplicates: true,
  });
}

export const REPLY_NOT_REQUESTER_MESSAGE =
  'Only the person who asked may reply to this request. An admin may reply on their behalf with an override reason.';
export const REQUEST_AWAITING_REPLY_MESSAGE = 'This request asked back and is waiting for the reply of the person who asked.';
export const REPLY_REQUIRES_INPUT_REQUIRED_MESSAGE = 'Only a request that asked back (input-required) takes a reply.';

/**
 * The requester answers a question asked back (INV-794): the reply lands in
 * the request's thread and the request goes back to SUBMITTED for its target
 * to pick up again. Only the requester, or an ADMIN on the record.
 */
export async function replyToAgentRequest(
  prisma: PrismaClient,
  input: { id: string; body: string; by: HumanAnswerInput['by']; overrideReason?: string | null },
): Promise<AgentRequest> {
  const body = input.body.trim();
  if (!body) throw createValidationError(ANSWER_REQUIRES_BODY_MESSAGE);
  if (input.by.actorKind !== 'HUMAN') throw createValidationError(REPLY_NOT_REQUESTER_MESSAGE);

  return prisma.$transaction(async (tx) => {
    const request = await tx.agentRequest.findUnique({ where: { id: input.id }, include: { work: { select: { id: true, identifier: true } } } });
    if (!request) throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
    if (request.state !== 'INPUT_REQUIRED') throw createValidationError(REPLY_REQUIRES_INPUT_REQUIRED_MESSAGE);
    const override = request.requestedByActorId !== input.by.actorId;
    if (override) {
      if (input.by.globalRole !== 'ADMIN') throw createValidationError(REPLY_NOT_REQUESTER_MESSAGE);
      if (!input.overrideReason?.trim()) throw createValidationError(HUMAN_ANSWER_OVERRIDE_REASON_REQUIRED_MESSAGE);
    }
    const comment = await tx.comment.create({
      data: { body, issueId: request.workId, parentCommentId: request.rootCommentId, userId: input.by.actorId },
    });
    await syncCommentMentions(tx, comment.id, comment.body);
    const moved = await tx.agentRequest.updateMany({
      where: { id: request.id, state: 'INPUT_REQUIRED' },
      data: { state: 'SUBMITTED', answeredCommentId: null },
    });
    if (moved.count === 0) throw createValidationError(REPLY_REQUIRES_INPUT_REQUIRED_MESSAGE);
    await recordRequestAudit(tx, {
      actor: { actorId: input.by.actorId, actorKind: 'HUMAN', ...(override ? { reason: `override: ${input.overrideReason!.trim()}` } : {}) },
      event: 'replied',
      request,
    });
    await enqueueWorkEvent(tx, {
      payload: { requestId: request.id, commentId: comment.id, repliedByActorId: input.by.actorId, targetActorId: request.targetActorId },
      type: 'agent.request_replied',
      workId: request.work.id,
      workIdentifier: request.work.identifier,
    });
    await resolveAttentionNotifications(tx, {
      kind: 'AGENT_REQUEST',
      payload: { key: 'requestId', value: request.id },
      resolution: 'replied',
      resolvedById: input.by.actorId,
      types: ['agent.request_input_required'],
    });
    return tx.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
}

// Refusals reach the web as `message` (they were masked as "Unexpected error.").
exposeErrorMessages([REQUEST_NOT_FOUND_MESSAGE], 'NOT_FOUND');
exposeErrorMessages([
  REQUEST_NOT_CLAIMABLE_MESSAGE,
  REQUEST_NOT_HELD_MESSAGE,
  CLAIM_SUPERSEDED_MESSAGE,
  CLAIM_TOKEN_REQUIRED_MESSAGE,
  REQUEST_ALREADY_TERMINAL_MESSAGE,
  ANSWER_REQUIRES_BODY_MESSAGE,
  HUMAN_ANSWER_NOT_TARGET_MESSAGE,
  HUMAN_ANSWER_OVERRIDE_REASON_REQUIRED_MESSAGE,
  REPLY_NOT_REQUESTER_MESSAGE,
  REQUEST_AWAITING_REPLY_MESSAGE,
  REPLY_REQUIRES_INPUT_REQUIRED_MESSAGE,
]);
