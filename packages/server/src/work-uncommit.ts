import type { Issue, Prisma } from '@prisma/client';

import { findWorkByIdOrIdentifier } from './context-service.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  WORK_UNCOMMIT_CLAIMED_MESSAGE,
  WORK_UNCOMMIT_FORBIDDEN_MESSAGE,
  WORK_UNCOMMIT_NO_SNAPSHOT_MESSAGE,
  WORK_UNCOMMIT_NOT_COMMITTED_MESSAGE,
  WORK_UNCOMMIT_RUN_MESSAGE,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { syncContainsFromParentId } from './link-service.js';
import { claimIssueRevision, recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

type DatabaseClient = Prisma.TransactionClient;

interface CommitSnapshot {
  acceptance: string | null;
  assigneeId: string | null;
  constraints: string | null;
  outcome: string | null;
  parentId: string | null;
  priority: number;
  repository: string | null;
  scope: string | null;
  source: string | null;
  stateId: string;
  verification: string | null;
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A person reverses one commit (INV-844). The pre-commit snapshot is the audit
 * written by that commit. A later edit, claim, or run refuses this item.
 */
export async function uncommitWork(
  prisma: import('@prisma/client').PrismaClient,
  id: string,
  input: { expectedRevision: number },
  actor: WriteActor,
): Promise<Issue> {
  if (actor.actorKind !== 'HUMAN' || !actor.actorId) {
    throw createValidationError(WORK_UNCOMMIT_FORBIDDEN_MESSAGE);
  }

  return prisma.$transaction(async (transaction) => {
    const work = await findWorkByIdOrIdentifier(transaction, id);
    if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    if (work.commitmentStatus !== 'COMMITTED') throw createValidationError(WORK_UNCOMMIT_NOT_COMMITTED_MESSAGE);
    if (work.revision !== input.expectedRevision) throw createValidationError(WORK_REVISION_CONFLICT_MESSAGE);
    if (await transaction.workClaim.findUnique({ where: { workId: work.id }, select: { id: true } })) {
      throw createValidationError(WORK_UNCOMMIT_CLAIMED_MESSAGE);
    }
    if (await transaction.workRun.count({ where: { workId: work.id } })) {
      throw createValidationError(WORK_UNCOMMIT_RUN_MESSAGE);
    }

    const snapshot = await commitSnapshot(transaction, work.id, work.revision);
    await claimIssueRevision(transaction, work.id, input.expectedRevision);
    const restored = await transaction.issue.update({
      where: { id: work.id },
      data: {
        acceptance: snapshot.acceptance,
        assigneeId: snapshot.assigneeId,
        commitmentStatus: 'CANDIDATE',
        constraints: snapshot.constraints,
        outcome: snapshot.outcome,
        parentId: snapshot.parentId,
        priority: snapshot.priority,
        repository: snapshot.repository,
        scope: snapshot.scope,
        source: snapshot.source,
        stateId: snapshot.stateId,
        verification: snapshot.verification,
      },
    });
    await syncContainsFromParentId(transaction, restored.id, snapshot.parentId, actor);
    await recordWorkAudit(transaction, {
      actor: { ...actor, reason: 'Returned to candidate: undo commit' },
      after: selectIssueSnapshot(restored),
      before: selectIssueSnapshot(work),
      workId: work.id,
    });
    await enqueueWorkEvent(transaction, {
      payload: { actorId: actor.actorId, restoredFromRevision: input.expectedRevision },
      type: 'work.uncommitted',
      workId: restored.id,
      workIdentifier: restored.identifier,
    });
    return restored;
  });
}

async function commitSnapshot(transaction: DatabaseClient, workId: string, revision: number): Promise<CommitSnapshot> {
  const audit = await transaction.workAudit.findFirst({
    where: { workId, revision },
    orderBy: { createdAt: 'desc' },
  });
  const before = asRecord(audit?.before ?? null);
  const after = asRecord(audit?.after ?? null);
  if (!before || !after || before.commitmentStatus !== 'CANDIDATE' || after.commitmentStatus !== 'COMMITTED') {
    throw createValidationError(WORK_UNCOMMIT_NO_SNAPSHOT_MESSAGE);
  }
  if (typeof before.stateId !== 'string' || typeof before.priority !== 'number') {
    throw createValidationError(WORK_UNCOMMIT_NO_SNAPSHOT_MESSAGE);
  }
  return {
    acceptance: nullableString(before.acceptance),
    assigneeId: nullableString(before.assigneeId),
    constraints: nullableString(before.constraints),
    outcome: nullableString(before.outcome),
    parentId: nullableString(before.parentId),
    priority: before.priority,
    repository: nullableString(before.repository),
    scope: nullableString(before.scope),
    source: nullableString(before.source),
    stateId: before.stateId,
    verification: nullableString(before.verification),
  };
}
