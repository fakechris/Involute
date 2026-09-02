import type { ActorKind, Issue, Prisma, PrismaClient, User, WorkClaim, WorkLinkType } from '@prisma/client';

import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_ALREADY_CLAIMED_MESSAGE,
  WORK_ACCEPT_FORBIDDEN_MESSAGE,
  WORK_CLAIM_REQUIRES_ACTOR_MESSAGE,
  WORK_COMMIT_FORBIDDEN_MESSAGE,
  WORK_REJECT_FORBIDDEN_MESSAGE,
  WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE,
  WORK_COMMIT_REQUIRES_OWNER_MESSAGE,
  WORK_NOT_CANDIDATE_MESSAGE,
  WORK_NOT_COMMITTED_MESSAGE,
  WORK_NOT_READY_MESSAGE,
  WORK_OWNER_MUST_BE_HUMAN_MESSAGE,
  WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE,
  WORK_RELATED_NOT_FOUND_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE,
} from './errors.js';
import { findWorkByIdOrIdentifier, isWorkReadyForClaim } from './context-service.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { createWorkLink } from './link-service.js';
import { createIssueInTransaction } from './issue-service.js';
import {
  completeWorkIdempotency,
  hashIdempotencyRequest,
  reserveWorkIdempotency,
} from './idempotency.js';
import {
  claimIssueRevision,
  INTERNAL_WRITE_ACTOR,
  recordWorkAudit,
  selectIssueSnapshot,
  type WriteActor,
} from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_CLAIM_LEASE_SECONDS = 2 * 60 * 60;

export type WorkPermission = 'propose' | 'commit' | 'reject' | 'claim' | 'update' | 'accept';

export interface ProposeWorkInput {
  acceptance?: string | null;
  constraints?: string | null;
  description?: string | null;
  idempotencyKey?: string | null;
  kind?: Issue['kind'] | null;
  outcome?: string | null;
  relatedWorkId?: string | null;
  relatedWorkType?: WorkLinkType | null;
  repository?: string | null;
  scope?: string | null;
  teamId: string;
  title: string;
  verification?: string | null;
}

export interface CommitWorkInput {
  acceptance?: string | null;
  assigneeId?: string | null;
  expectedRevision: number;
  outcome?: string | null;
  scope?: string | null;
  constraints?: string | null;
  verification?: string | null;
}

export interface ClaimWorkInput {
  idempotencyKey?: string | null;
  leaseSeconds?: number | null;
}

export interface RejectWorkInput {
  expectedRevision: number;
  reason?: string | null;
}

export function assertActorCan(actorKind: ActorKind | null | undefined, permission: WorkPermission): void {
  if (actorKind !== 'AGENT') {
    return;
  }

  if (permission === 'commit') {
    throw createValidationError(WORK_COMMIT_FORBIDDEN_MESSAGE);
  }

  if (permission === 'reject') {
    throw createValidationError(WORK_REJECT_FORBIDDEN_MESSAGE);
  }

  if (permission === 'accept') {
    throw createValidationError(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  }
}

export async function proposeWork(
  prisma: PrismaClient,
  input: ProposeWorkInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  assertActorCan(actor.actorKind, 'propose');

  return prisma.$transaction(async (transaction) => {
    let idempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'propose',
        requestHash: hashIdempotencyRequest({ ...input, idempotencyKey: null }),
        teamId: input.teamId,
      });
      if (!reservation.created) {
        if (!reservation.record.workId) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        return transaction.issue.findUniqueOrThrow({ where: { id: reservation.record.workId } });
      }
      idempotencyId = reservation.record.id;
    }

    const createInput: import('./issue-service.js').CreateIssueInput = {
      commitmentStatus: 'CANDIDATE',
      teamId: input.teamId,
      title: input.title,
    };
    if (input.acceptance !== undefined) createInput.acceptance = input.acceptance;
    if (input.constraints !== undefined) createInput.constraints = input.constraints;
    if (input.description !== undefined) createInput.description = input.description;
    if (input.kind !== undefined && input.kind !== null) createInput.kind = input.kind;
    if (input.outcome !== undefined) createInput.outcome = input.outcome;
    if (input.repository !== undefined) createInput.repository = input.repository;
    if (input.scope !== undefined) createInput.scope = input.scope;
    if (input.verification !== undefined) createInput.verification = input.verification;

    const created = await createIssueInTransaction(transaction, createInput, actor);
    if (input.relatedWorkId) {
      const related = await findWorkByIdOrIdentifier(transaction, input.relatedWorkId);
      if (!related) throw createNotFoundError(WORK_RELATED_NOT_FOUND_MESSAGE);
      await createWorkLink(transaction, {
        actor,
        fromId: created.id,
        toId: related.id,
        type: input.relatedWorkType ?? 'DISCOVERED_DURING',
      });
    }
    if (idempotencyId) {
      await completeWorkIdempotency(transaction, idempotencyId, created.id);
    }
    await enqueueWorkEvent(transaction, {
      payload: { title: created.title, actorId: actor.actorId ?? null },
      type: 'work.proposed',
      workId: created.id,
      workIdentifier: created.identifier,
    });
    return created;
  });
}

export async function commitWork(
  prisma: PrismaClient,
  id: string,
  input: CommitWorkInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  assertActorCan(actor.actorKind, 'commit');

  return prisma.$transaction(async (transaction) => {
    const existing = await requireWork(transaction, id);

    if (existing.commitmentStatus !== 'CANDIDATE') {
      throw createValidationError(WORK_NOT_CANDIDATE_MESSAGE);
    }

    if (existing.revision !== input.expectedRevision) {
      throw createValidationError(WORK_REVISION_CONFLICT_MESSAGE);
    }

    await claimIssueRevision(transaction, existing.id, input.expectedRevision);

    const acceptance = nonEmpty(input.acceptance) ?? nonEmpty(existing.acceptance);
    if (!acceptance) {
      throw createValidationError(WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE);
    }

    const assigneeId = input.assigneeId === undefined ? existing.assigneeId : input.assigneeId;
    if (!assigneeId) {
      throw createValidationError(WORK_COMMIT_REQUIRES_OWNER_MESSAGE);
    }

    const owner = await transaction.user.findUnique({
      where: { id: assigneeId },
      select: {
        id: true,
        actorKind: true,
        memberships: {
          where: { teamId: existing.teamId },
          take: 1,
          select: { id: true },
        },
      },
    });

    if (!owner || owner.actorKind !== 'HUMAN') {
      throw createValidationError(WORK_OWNER_MUST_BE_HUMAN_MESSAGE);
    }
    if (owner.memberships.length === 0) {
      throw createValidationError(WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE);
    }

    const readyState = await transaction.workflowState.findFirst({
      where: {
        teamId: existing.teamId,
        type: 'UNSTARTED',
      },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    const updated = await transaction.issue.update({
      where: { id: existing.id },
      data: {
        acceptance,
        assigneeId: owner.id,
        commitmentStatus: 'COMMITTED',
        constraints: input.constraints === undefined ? existing.constraints : input.constraints,
        outcome: input.outcome === undefined ? existing.outcome : input.outcome,
        scope: input.scope === undefined ? existing.scope : input.scope,
        ...(readyState ? { stateId: readyState.id } : {}),
        verification: input.verification === undefined ? existing.verification : input.verification,
      },
    });

    await recordWorkAudit(transaction, {
      actor,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(existing),
      workId: existing.id,
    });

    await enqueueWorkEvent(transaction, {
      payload: {
        acceptance: updated.acceptance,
        assigneeId: updated.assigneeId,
        actorId: actor.actorId ?? null,
      },
      type: 'work.committed',
      updatedFrom: { commitmentStatus: existing.commitmentStatus, revision: existing.revision },
      workId: updated.id,
      workIdentifier: updated.identifier,
    });

    return updated;
  });
}

export async function rejectWork(
  prisma: PrismaClient,
  id: string,
  input: RejectWorkInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  assertActorCan(actor.actorKind, 'reject');

  return prisma.$transaction(async (transaction) => {
    const existing = await requireWork(transaction, id);

    if (existing.commitmentStatus !== 'CANDIDATE') {
      throw createValidationError(WORK_NOT_CANDIDATE_MESSAGE);
    }

    if (existing.revision !== input.expectedRevision) {
      throw createValidationError(WORK_REVISION_CONFLICT_MESSAGE);
    }


    await claimIssueRevision(transaction, existing.id, input.expectedRevision);

    const reason = nonEmpty(input.reason);
    const actorForAudit: WriteActor = { ...actor };
    if (reason) {
      actorForAudit.reason = reason;
    }

    const updated = await transaction.issue.update({
      where: { id: existing.id },
      data: {
        commitmentStatus: 'REJECTED',
      },
    });

    await recordWorkAudit(transaction, {
      actor: actorForAudit,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(existing),
      workId: existing.id,
    });

    await enqueueWorkEvent(transaction, {
      payload: {
        actorId: actor.actorId ?? null,
        reason,
      },
      type: 'work.rejected',
      updatedFrom: { commitmentStatus: existing.commitmentStatus, revision: existing.revision },
      workId: updated.id,
      workIdentifier: updated.identifier,
    });

    return updated;
  });
}

export async function claimWork(
  prisma: PrismaClient,
  id: string,
  input: ClaimWorkInput = {},
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<{ claim: WorkClaim; work: Issue }> {
  assertActorCan(actor.actorKind, 'claim');

  if (!actor.actorId) {
    throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);
  }

  const result = await prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, id);

    if (work.commitmentStatus !== 'COMMITTED') {
      throw createValidationError(WORK_NOT_COMMITTED_MESSAGE);
    }

    const currentClaim = await transaction.workClaim.findUnique({ where: { workId: work.id } });
    if (currentClaim && currentClaim.leaseUntil > new Date() && currentClaim.actorId !== actor.actorId) {
      throw createValidationError(WORK_ALREADY_CLAIMED_MESSAGE);
    }
    const renewingOwnClaim = Boolean(
      currentClaim && currentClaim.actorId === actor.actorId && currentClaim.leaseUntil > new Date(),
    );
    if (!renewingOwnClaim && !(await isWorkReadyForClaim(transaction, work.id))) {
      throw createValidationError(WORK_NOT_READY_MESSAGE);
    }

    let idempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'claim',
        requestHash: hashIdempotencyRequest({
          leaseSeconds: input.leaseSeconds ?? null,
          workId: work.id,
        }),
        teamId: work.teamId,
      });
      if (!reservation.created) {
        if (reservation.record.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
        }
        const existing = await transaction.workClaim.findUnique({
          where: { workId: work.id },
          include: { work: true },
        });
        if (!existing || existing.actorId !== actor.actorId) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        return { claim: existing, work: existing.work };
      }
      idempotencyId = reservation.record.id;
    }

    const leaseUntil = new Date(
      Date.now() + (input.leaseSeconds && input.leaseSeconds > 0
        ? input.leaseSeconds
        : DEFAULT_CLAIM_LEASE_SECONDS) * 1000,
    );
    const claim = await upsertWorkClaim(transaction, {
      actorId: actor.actorId as string,
      conflict: 'throw',
      leaseUntil,
      workId: work.id,
    });

    if (idempotencyId) await completeWorkIdempotency(transaction, idempotencyId, work.id);

    await enqueueWorkEvent(transaction, {
      payload: {
        actorId: actor.actorId,
        leaseUntil: claim.leaseUntil.toISOString(),
      },
      type: 'work.claimed',
      workId: work.id,
      workIdentifier: work.identifier,
    });

    return { claim, work };
  });

  return result;
}

async function upsertWorkClaim(
  prisma: DatabaseClient,
  input: {
    actorId: string;
    conflict: 'throw' | 'skip';
    leaseUntil: Date;
    workId: string;
  },
): Promise<WorkClaim> {
  await prisma.workClaim.deleteMany({
    where: {
      workId: input.workId,
      leaseUntil: { lte: new Date() },
    },
  });

  const existing = await prisma.workClaim.findUnique({
    where: { workId: input.workId },
  });

  if (existing) {
    if (existing.actorId === input.actorId) {
      return prisma.workClaim.update({
        where: { workId: input.workId },
        data: { leaseUntil: input.leaseUntil },
      });
    }

    if (input.conflict === 'skip') {
      return existing;
    }

    throw createValidationError(WORK_ALREADY_CLAIMED_MESSAGE);
  }

  try {
    return await prisma.workClaim.create({
      data: {
        actorId: input.actorId,
        leaseUntil: input.leaseUntil,
        workId: input.workId,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await prisma.workClaim.findUnique({
        where: { workId: input.workId },
      });

      if (raced?.actorId === input.actorId) {
        return prisma.workClaim.update({
          where: { workId: input.workId },
          data: { leaseUntil: input.leaseUntil },
        });
      }

      if (input.conflict === 'skip' && raced) {
        return raced;
      }

      throw createValidationError(WORK_ALREADY_CLAIMED_MESSAGE);
    }

    throw error;
  }
}

async function requireWork(prisma: DatabaseClient, id: string): Promise<Issue> {
  const work = await findWorkByIdOrIdentifier(prisma, id);

  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  return work;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const tag = (error as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
  return tag === 'PrismaClientKnownRequestError' && (error as { code?: string }).code === 'P2002';
}

export function isAcceptStateType(type: string): boolean {
  return type === 'COMPLETED' || type === 'CANCELED';
}
