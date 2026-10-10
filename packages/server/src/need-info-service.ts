import {
  createAgentRequest,
  recordRequestAudit,
  settleNeedInfoAnswered,
} from './agent-request-service.js';
import { canAnswerOnTeam } from './agent-request-handoff.js';
import {
  createNotFoundError,
  createValidationError,
  NEEDINFO_QUESTION_REQUIRED_MESSAGE,
  NEEDINFO_TARGET_NOT_FOUND_MESSAGE,
  NEEDINFO_TARGET_SELF_MESSAGE,
  NEEDINFO_TARGET_SERVICE_MESSAGE,
  NEEDINFO_AGENT_TO_AGENT_MESSAGE,
  NEEDINFO_TARGET_CANNOT_ANSWER_MESSAGE,
  NEEDINFO_ALREADY_OPEN_MESSAGE,
  NEEDINFO_NOT_A_NEEDINFO_MESSAGE,
  NEEDINFO_WITHDRAW_NOT_REQUESTER_MESSAGE,
  NEEDINFO_WITHDRAW_REASON_REQUIRED_MESSAGE,
  NEEDINFO_CLOSED_MESSAGE,
  NEEDINFO_IDEMPOTENCY_MISMATCH_MESSAGE,
  ISSUE_NOT_FOUND_MESSAGE,
  REQUEST_NOT_FOUND_MESSAGE,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { syncCommentMentions } from './mention-service.js';
import { normalizeHandle } from './mention-parser.js';
import { resolveAttentionNotifications } from './notification-service.js';

import type { AgentRequest, AgentRequestState, Comment, Prisma, PrismaClient, User } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

// Refusal texts live in errors.ts, where GraphQL learns to expose them as `message`.
export {
  NEEDINFO_QUESTION_REQUIRED_MESSAGE,
  NEEDINFO_TARGET_NOT_FOUND_MESSAGE,
  NEEDINFO_TARGET_SELF_MESSAGE,
  NEEDINFO_TARGET_SERVICE_MESSAGE,
  NEEDINFO_AGENT_TO_AGENT_MESSAGE,
  NEEDINFO_TARGET_CANNOT_ANSWER_MESSAGE,
  NEEDINFO_ALREADY_OPEN_MESSAGE,
  NEEDINFO_NOT_A_NEEDINFO_MESSAGE,
  NEEDINFO_WITHDRAW_NOT_REQUESTER_MESSAGE,
  NEEDINFO_WITHDRAW_REASON_REQUIRED_MESSAGE,
  NEEDINFO_CLOSED_MESSAGE,
  NEEDINFO_IDEMPOTENCY_MISMATCH_MESSAGE,
} from './errors.js';

/**
 * needinfo (INV-1119): "this work is waiting for X to answer". Built on the
 * AgentRequest ledger rather than a new model — a request already has a named
 * target (human targets exist since hand-offs, INV-596), a thread, an answer
 * comment, a deadline, an audit trail, a place in Needs you (AGENT_REQUEST)
 * and in agent_inbox. What a needinfo adds is the `needInfo` flag and two
 * rules: anyone may raise one to a named person, and *any* comment its target
 * writes on the work answers it (Bugzilla's needinfo?), not only a reply
 * through the answer form.
 */

/** A person may take days to answer; long enough not to nag, short enough that an SLA pause ends. */
export const NEEDINFO_DEADLINE_MS = 7 * 24 * 60 * 60_000;
const OPEN_STATES: AgentRequestState[] = ['SUBMITTED', 'WORKING'];

export interface NeedInfoActor {
  actorId: string;
  actorKind: User['actorKind'];
  globalRole: User['globalRole'];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An actor named by id, `@handle` or email. Deactivated actors resolve to nothing. */
export async function resolveActorRef(db: DatabaseClient, ref: string) {
  const value = ref.trim();
  if (!value) return null;
  const select = { actorKind: true, deactivatedAt: true, globalRole: true, handle: true, id: true, name: true } as const;
  const actor = UUID.test(value)
    ? await db.user.findUnique({ where: { id: value }, select })
    : value.includes('@') && !value.startsWith('@')
      ? await db.user.findUnique({ where: { email: value.toLowerCase() }, select })
      : await db.user.findUnique({ where: { handle: normalizeHandle(value) }, select });
  return actor && !actor.deactivatedAt ? actor : null;
}

export interface RequestNeedInfoInput {
  by: NeedInfoActor;
  idempotencyKey?: string | null;
  question: string;
  target: string;
  workId: string;
}

export interface RaisedNeedInfo {
  comment: Comment;
  request: AgentRequest;
}

/**
 * Raise a needinfo: a root comment with the question, authored by the asker,
 * and a request addressed to the target, in one transaction. The target is
 * told — a person in their inbox and Needs you, an agent in agent_inbox and on
 * its push channel.
 */
export async function requestNeedInfo(
  prisma: PrismaClient,
  input: RequestNeedInfoInput,
  now: Date = new Date(),
): Promise<RaisedNeedInfo> {
  const question = input.question.trim();
  if (!question) throw createValidationError(NEEDINFO_QUESTION_REQUIRED_MESSAGE);

  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.agentRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        if (!existing.needInfo || existing.workId !== input.workId || existing.requestedByActorId !== input.by.actorId) {
          throw createValidationError(NEEDINFO_IDEMPOTENCY_MISMATCH_MESSAGE);
        }
        return { comment: await tx.comment.findUniqueOrThrow({ where: { id: existing.rootCommentId } }), request: existing };
      }
    }
    const work = await tx.issue.findUnique({ where: { id: input.workId }, select: { id: true, identifier: true, teamId: true, title: true } });
    if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    const target = await resolveActorRef(tx, input.target);
    if (!target) throw createNotFoundError(NEEDINFO_TARGET_NOT_FOUND_MESSAGE);
    if (target.id === input.by.actorId) throw createValidationError(NEEDINFO_TARGET_SELF_MESSAGE);
    if (target.actorKind === 'SERVICE') throw createValidationError(NEEDINFO_TARGET_SERVICE_MESSAGE);
    if (input.by.actorKind !== 'HUMAN' && target.actorKind !== 'HUMAN') throw createValidationError(NEEDINFO_AGENT_TO_AGENT_MESSAGE);
    if (!(await canAnswerOnTeam(tx, target, work.teamId, now))) throw createValidationError(NEEDINFO_TARGET_CANNOT_ANSWER_MESSAGE);
    const open = await tx.agentRequest.findFirst({
      where: { needInfo: true, state: { in: OPEN_STATES }, targetActorId: target.id, workId: work.id },
      select: { id: true },
    });
    if (open) throw createValidationError(NEEDINFO_ALREADY_OPEN_MESSAGE);

    // The name, not an @handle: a mention would open a second request to an agent.
    const comment = await tx.comment.create({
      data: { body: `**Needinfo for ${target.name}:** ${question}`, issueId: work.id, userId: input.by.actorId },
    });
    await syncCommentMentions(tx, comment.id, comment.body);
    const request = await createAgentRequest(tx, {
      body: question,
      deadlineAt: new Date(now.getTime() + NEEDINFO_DEADLINE_MS),
      idempotencyKey: input.idempotencyKey ?? null,
      needInfo: true,
      requestedByActorId: input.by.actorId,
      rootCommentId: comment.id,
      targetActorId: target.id,
      workId: work.id,
    }, now);
    await recordRequestAudit(tx, { actor: { actorId: input.by.actorId, actorKind: input.by.actorKind }, event: 'needinfo', request });

    const payload = {
      question,
      requestId: request.id,
      requestedByActorId: input.by.actorId,
      rootCommentId: comment.id,
      targetActorId: target.id,
    };
    const event = await enqueueWorkEvent(tx, { payload, type: 'needinfo.requested', workId: work.id, workIdentifier: work.identifier });
    // A Notification row is also what wakes an agent's push channel (INV-992).
    await tx.notification.createMany({
      data: [{
        payload: { ...payload, identifier: work.identifier, title: work.title },
        sourceEventId: event.id,
        teamId: work.teamId,
        type: 'needinfo.requested',
        userId: target.id,
        workId: work.id,
      }],
      skipDuplicates: true,
    });
    return { comment, request };
  });
}

/**
 * Any comment the target writes on the work answers their open needinfo
 * there (INV-1119) — that is what makes it a needinfo rather than a request
 * that waits for the answer form. Runs inside the comment's transaction.
 */
export async function answerNeedInfoByComment(
  tx: Prisma.TransactionClient,
  comment: Pick<Comment, 'id' | 'issueId' | 'userId'>,
): Promise<number> {
  const open = await tx.agentRequest.findMany({
    where: { needInfo: true, state: { in: OPEN_STATES }, targetActorId: comment.userId, workId: comment.issueId },
    orderBy: { createdAt: 'asc' },
  });
  if (open.length === 0) return 0;
  const author = await tx.user.findUnique({ where: { id: comment.userId }, select: { actorKind: true } });
  let answered = 0;
  for (const request of open) {
    const moved = await tx.agentRequest.updateMany({
      where: { id: request.id, state: { in: OPEN_STATES } },
      data: {
        // answeredCommentId is unique: the first request takes the comment.
        answeredCommentId: answered === 0 ? comment.id : null,
        claimExpiresAt: null,
        claimTokenHash: null,
        claimedBy: null,
        state: 'COMPLETED',
      },
    });
    if (moved.count === 0) continue;
    answered += 1;
    await recordRequestAudit(tx, {
      actor: { actorId: comment.userId, actorKind: author?.actorKind ?? 'HUMAN', reason: 'answered by a comment on the work' },
      event: 'answered',
      request,
    });
    await settleNeedInfoAnswered(tx, request, { answeredById: comment.userId, commentId: comment.id });
  }
  return answered;
}

/** Whoever raised a needinfo withdraws it; an admin may, with a reason. */
export async function withdrawNeedInfo(
  prisma: PrismaClient,
  input: { by: NeedInfoActor; id: string; reason?: string | null },
  now: Date = new Date(),
): Promise<AgentRequest> {
  return prisma.$transaction(async (tx) => {
    const request = await tx.agentRequest.findUnique({ where: { id: input.id }, include: { work: { select: { id: true, identifier: true } } } });
    if (!request) throw createNotFoundError(REQUEST_NOT_FOUND_MESSAGE);
    if (!request.needInfo) throw createValidationError(NEEDINFO_NOT_A_NEEDINFO_MESSAGE);
    const reason = input.reason?.trim() || null;
    const override = request.requestedByActorId !== input.by.actorId;
    if (override) {
      if (input.by.actorKind !== 'HUMAN' || input.by.globalRole !== 'ADMIN') throw createValidationError(NEEDINFO_WITHDRAW_NOT_REQUESTER_MESSAGE);
      if (!reason) throw createValidationError(NEEDINFO_WITHDRAW_REASON_REQUIRED_MESSAGE);
    }
    const moved = await tx.agentRequest.updateMany({
      where: { id: request.id, state: { in: [...OPEN_STATES, 'INPUT_REQUIRED'] } },
      data: { canceledAt: now, claimExpiresAt: null, claimTokenHash: null, claimedBy: null, state: 'CANCELED' },
    });
    if (moved.count === 0) throw createValidationError(NEEDINFO_CLOSED_MESSAGE);
    await recordRequestAudit(tx, {
      actor: { actorId: input.by.actorId, actorKind: input.by.actorKind, ...(reason ? { reason: override ? `override: ${reason}` : reason } : {}) },
      event: 'canceled',
      request,
    });
    await enqueueWorkEvent(tx, {
      payload: { reason, requestId: request.id, targetActorId: request.targetActorId, withdrawnById: input.by.actorId },
      type: 'needinfo.withdrawn',
      workId: request.work.id,
      workIdentifier: request.work.identifier,
    });
    await resolveAttentionNotifications(tx, {
      kind: 'AGENT_REQUEST',
      payload: { key: 'requestId', value: request.id },
      resolution: 'withdrawn',
      resolvedById: input.by.actorId,
      types: ['needinfo.requested'],
    });
    return tx.agentRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
}

/**
 * Spans during which a bug waited on its reporter through a needinfo
 * (INV-1119), keyed by work id; `to` is null while it is still open. The
 * reporter is the actor on the bug's first audit row (resolveProposerId).
 * A closed request's updatedAt is when it closed: terminal rows are not
 * written again.
 */
export async function loadReporterWaits(
  db: DatabaseClient,
  workIds: string[],
): Promise<Map<string, Array<{ from: Date; to: Date | null }>>> {
  const waits = new Map<string, Array<{ from: Date; to: Date | null }>>();
  if (workIds.length === 0) return waits;
  const requests = await db.agentRequest.findMany({
    where: { needInfo: true, workId: { in: workIds } },
    select: { createdAt: true, state: true, targetActorId: true, updatedAt: true, workId: true },
  });
  if (requests.length === 0) return waits;
  const audits = await db.workAudit.findMany({
    where: { workId: { in: [...new Set(requests.map((request) => request.workId))] } },
    orderBy: [{ workId: 'asc' }, { revision: 'asc' }, { createdAt: 'asc' }],
    distinct: ['workId'],
    select: { actorId: true, workId: true },
  });
  const reporter = new Map(audits.map((audit) => [audit.workId, audit.actorId]));
  for (const request of requests) {
    if (!reporter.get(request.workId) || reporter.get(request.workId) !== request.targetActorId) continue;
    const open = OPEN_STATES.includes(request.state) || request.state === 'INPUT_REQUIRED';
    const list = waits.get(request.workId) ?? [];
    list.push({ from: request.createdAt, to: open ? null : request.updatedAt });
    waits.set(request.workId, list);
  }
  return waits;
}
