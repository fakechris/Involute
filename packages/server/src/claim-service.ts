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
  WORK_OWNER_MUST_BE_HUMAN_MESSAGE,
  WORK_RELATED_NOT_FOUND_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
} from './errors.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { createWorkLink } from './link-service.js';
import { INTERNAL_WRITE_ACTOR, recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_CLAIM_LEASE_SECONDS = 2 * 60 * 60;
export const ACCEPT_STATE_NAMES = ['Done', 'Canceled'] as const;

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

  if (input.idempotencyKey) {
    const existing = await prisma.workIdempotency.findUnique({
      where: {
        operation_key: {
          key: input.idempotencyKey,
          operation: 'propose',
        },
      },
      include: {
        work: true,
      },
    });

    if (existing) {
      return existing.work;
    }
  }

  const { createIssue } = await import('./issue-service.js');
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

  const created = await createIssue(prisma, createInput, actor);

  if (input.relatedWorkId) {
    const related = await findWorkByIdOrIdentifier(prisma, input.relatedWorkId);

    if (!related) {
      throw createNotFoundError(WORK_RELATED_NOT_FOUND_MESSAGE);
    }

    await createWorkLink(prisma, {
      actor,
      fromId: created.id,
      toId: related.id,
      type: input.relatedWorkType ?? 'DISCOVERED_DURING',
    });
  }

  if (input.idempotencyKey) {
    try {
      await prisma.workIdempotency.create({
        data: {
          actorId: actor.actorId ?? null,
          key: input.idempotencyKey,
          operation: 'propose',
          workId: created.id,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const raced = await prisma.workIdempotency.findUnique({
          where: {
            operation_key: {
              key: input.idempotencyKey,
              operation: 'propose',
            },
          },
          include: { work: true },
        });

        if (raced) {
          return raced.work;
        }
      }

      throw error;
    }
  }

  await enqueueWorkEvent(prisma, {
    payload: {
      title: created.title,
      actorId: actor.actorId ?? null,
    },
    type: 'work.proposed',
    workId: created.id,
    workIdentifier: created.identifier,
  });

  return created;
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
      select: { id: true, actorKind: true },
    });

    if (!owner || owner.actorKind !== 'HUMAN') {
      throw createValidationError(WORK_OWNER_MUST_BE_HUMAN_MESSAGE);
    }

    const readyState = await transaction.workflowState.findFirst({
      where: {
        teamId: existing.teamId,
        name: 'Ready',
      },
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
        revision: { increment: 1 },
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

    const reason = nonEmpty(input.reason);
    const actorForAudit: WriteActor = { ...actor };
    if (reason) {
      actorForAudit.reason = reason;
    }

    const updated = await transaction.issue.update({
      where: { id: existing.id },
      data: {
        commitmentStatus: 'REJECTED',
        revision: { increment: 1 },
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

  if (input.idempotencyKey) {
    const existingKey = await prisma.workIdempotency.findUnique({
      where: {
        operation_key: {
          key: input.idempotencyKey,
          operation: 'claim',
        },
      },
    });

    if (existingKey) {
      const existing = await prisma.workClaim.findUnique({
        where: { workId: existingKey.workId },
        include: { work: true },
      });

      if (existing) {
        return { claim: existing, work: existing.work };
      }
    }
  }

  const result = await prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, id);

    if (work.commitmentStatus !== 'COMMITTED') {
      throw createValidationError(WORK_NOT_COMMITTED_MESSAGE);
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

    if (input.idempotencyKey) {
      await transaction.workIdempotency.upsert({
        where: {
          operation_key: {
            key: input.idempotencyKey,
            operation: 'claim',
          },
        },
        create: {
          actorId: actor.actorId ?? null,
          key: input.idempotencyKey,
          operation: 'claim',
          workId: work.id,
        },
        update: {
          workId: work.id,
        },
      });
    }

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

export function isAcceptStateName(name: string): boolean {
  return (ACCEPT_STATE_NAMES as readonly string[]).includes(name);
}
