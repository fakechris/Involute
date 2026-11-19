import type { Prisma } from '@prisma/client';

import type { WriteActor } from './work-service.js';

/**
 * Deleting work cascades its audit trail away, and the undo tombstone
 * (INV-840) is swept after a week. A WorkDeletion keeps only what milestone
 * burndown replays (INV-1929): the scope fields of each audit and of the
 * final state, and who deleted it, when and from where.
 */

type Tx = Prisma.TransactionClient;

export interface DeletedScopeSnapshot {
  parentId: string | null;
  commitmentStatus: string | null;
  stateId: string | null;
  kind: string | null;
}

export interface DeletedScopeAudit {
  id: string;
  revision: number;
  createdAt: string;
  before: DeletedScopeSnapshot | null;
  after: DeletedScopeSnapshot;
  surface: string | null;
  actorKind: string;
  actorId: string | null;
  reason: string | null;
}

export function scopeSnapshotOf(value: unknown): DeletedScopeSnapshot {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const field = (key: string) => typeof row[key] === 'string' ? row[key] as string : null;
  return {
    parentId: field('parentId'),
    commitmentStatus: field('commitmentStatus'),
    stateId: field('stateId'),
    kind: field('kind'),
  };
}

/** Record a deletion before the row and its audits cascade away. */
export async function writeWorkDeletion(tx: Tx, issueId: string, actor: WriteActor): Promise<void> {
  const issue = await tx.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      id: true, teamId: true, identifier: true, repository: true, revision: true,
      parentId: true, commitmentStatus: true, stateId: true, kind: true,
      audits: {
        orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, revision: true, createdAt: true, before: true, after: true, surface: true, actorKind: true, actorId: true, reason: true },
      },
    },
  });
  const audits: DeletedScopeAudit[] = issue.audits.map(audit => ({
    id: audit.id,
    revision: audit.revision,
    createdAt: audit.createdAt.toISOString(),
    before: audit.before === null ? null : scopeSnapshotOf(audit.before),
    after: scopeSnapshotOf(audit.after),
    surface: audit.surface,
    actorKind: audit.actorKind,
    actorId: audit.actorId,
    reason: audit.reason,
  }));
  const final: DeletedScopeSnapshot = scopeSnapshotOf(issue);
  const parentIds = new Set<string>();
  for (const snapshot of [final, ...audits.flatMap(audit => [audit.before, audit.after])]) {
    if (snapshot?.parentId) parentIds.add(snapshot.parentId);
  }
  await tx.workDeletion.create({
    data: {
      workId: issue.id,
      teamId: issue.teamId,
      identifier: issue.identifier,
      repository: issue.repository,
      parentIds: [...parentIds],
      audits: audits as unknown as Prisma.InputJsonValue,
      final: final as unknown as Prisma.InputJsonValue,
      revision: issue.revision,
      actorKind: actor.actorKind,
      actorId: actor.actorId ?? null,
      surface: actor.surface ?? null,
      reason: actor.reason ?? null,
    },
  });
}

/** A restore undoes the row, not the fact that it was deleted for a while. */
export async function markWorkDeletionRestored(tx: Tx, workId: string): Promise<void> {
  await tx.workDeletion.updateMany({ where: { workId, restoredAt: null }, data: { restoredAt: new Date() } });
}
