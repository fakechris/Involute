import { Prisma } from '@prisma/client';
import type { ActorKind, Issue, PrismaClient, WorkLinkType, WorkShareRole } from '@prisma/client';

import { createNotFoundError, createValidationError } from './errors.js';
import { lockWorkGraph } from './graph-integrity.js';
import { INTERNAL_WRITE_ACTOR, recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

/**
 * Undoing a deletion (INV-840). Deleting work is a hard delete and its rows
 * cascade away, so `deleteIssue` first writes what the item looked like into
 * a WorkTombstone keyed by the original id. `restoreDeletedIssue` puts the
 * same id, identifier, fields, labels, comments, links, shares, audit trail
 * and the children's parent back, then drops the tombstone. Leases, runs,
 * evidence and notifications are not brought back: a restored item starts
 * its delivery again.
 */

type Tx = Prisma.TransactionClient;

export interface WorkTombstoneSnapshot {
  version: 1;
  issue: Omit<Issue, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };
  labelIds: string[];
  childIds: string[];
  comments: Array<{
    id: string;
    body: string;
    userId: string;
    parentCommentId: string | null;
    createdAt: string;
    updatedAt: string;
    mentionActorIds: string[];
  }>;
  links: Array<{ id: string; type: string; fromId: string; toId: string; actorId: string | null; createdAt: string }>;
  shares: Array<{ id: string; userId: string; role: string; createdById: string | null; createdAt: string }>;
  audits: Array<{
    id: string;
    revision: number;
    actorKind: string;
    actorId: string | null;
    surface: string | null;
    sessionId: string | null;
    sourceMessageId: string | null;
    reason: string | null;
    claimGeneration: number | null;
    before: Prisma.JsonValue | null;
    after: Prisma.JsonValue;
    createdAt: string;
    /** The decision receipt attached to this audit row, if any (cascades with it). */
    receipt: {
      id: string;
      actorId: string;
      sessionId: string | null;
      runtime: string | null;
      contractRevision: number;
      reasoning: string;
      evidence: Prisma.JsonValue;
      inputs: Prisma.JsonValue;
      createdAt: string;
    } | null;
  }>;
}

/** How long a deletion stays undoable. The session undo stack is gone on reload; this bounds the server copy. */
export const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const TOMBSTONE_NOT_FOUND_MESSAGE = 'Nothing to restore: this work was not deleted in a way that can be undone, or it was already restored.';
export const TOMBSTONE_ID_TAKEN_MESSAGE = 'This work cannot be restored: its id or identifier is in use again.';
export const TOMBSTONE_EXPIRED_MESSAGE = 'This work was deleted more than 7 days ago and can no longer be restored.';

/** Capture everything `restoreDeletedIssue` needs, before the row is deleted. */
export async function writeWorkTombstone(tx: Tx, issueId: string, deletedById: string | null): Promise<void> {
  const issue = await tx.issue.findUniqueOrThrow({
    where: { id: issueId },
    include: {
      labels: { select: { id: true } },
      children: { select: { id: true } },
      comments: { include: { mentions: { select: { actorId: true } } }, orderBy: { createdAt: 'asc' } },
      outgoingLinks: true,
      incomingLinks: true,
      shares: true,
      audits: { orderBy: { createdAt: 'asc' }, include: { receipt: true } },
    },
  });
  const { labels, children, comments, outgoingLinks, incomingLinks, shares, audits, ...row } = issue;
  const snapshot: WorkTombstoneSnapshot = {
    version: 1,
    issue: { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastAppliedEventTime: row.lastAppliedEventTime, snoozedUntil: row.snoozedUntil },
    labelIds: labels.map((label) => label.id),
    childIds: children.map((child) => child.id),
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      userId: comment.userId,
      parentCommentId: comment.parentCommentId,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      mentionActorIds: comment.mentions.map((mention) => mention.actorId),
    })),
    links: [...outgoingLinks, ...incomingLinks].map((link) => ({
      id: link.id, type: link.type, fromId: link.fromId, toId: link.toId, actorId: link.actorId, createdAt: link.createdAt.toISOString(),
    })),
    shares: shares.map((share) => ({ id: share.id, userId: share.userId, role: share.role, createdById: share.createdById, createdAt: share.createdAt.toISOString() })),
    audits: audits.map((audit) => ({
      id: audit.id,
      revision: audit.revision,
      actorKind: audit.actorKind,
      actorId: audit.actorId,
      surface: audit.surface,
      sessionId: audit.sessionId,
      sourceMessageId: audit.sourceMessageId,
      reason: audit.reason,
      claimGeneration: audit.claimGeneration,
      before: audit.before,
      after: audit.after,
      createdAt: audit.createdAt.toISOString(),
      receipt: audit.receipt
        ? {
            id: audit.receipt.id,
            actorId: audit.receipt.actorId,
            sessionId: audit.receipt.sessionId,
            runtime: audit.receipt.runtime,
            contractRevision: audit.receipt.contractRevision,
            reasoning: audit.receipt.reasoning,
            evidence: audit.receipt.evidence,
            inputs: audit.receipt.inputs,
            createdAt: audit.receipt.createdAt.toISOString(),
          }
        : null,
    })),
  };
  await tx.workTombstone.upsert({
    where: { id: issueId },
    create: { id: issueId, teamId: issue.teamId, identifier: issue.identifier, snapshot: snapshot as unknown as Prisma.InputJsonValue, deletedById },
    update: { teamId: issue.teamId, identifier: issue.identifier, snapshot: snapshot as unknown as Prisma.InputJsonValue, deletedById, deletedAt: new Date() },
  });
}

export async function findWorkTombstone(prisma: PrismaClient, id: string) {
  return prisma.workTombstone.findUnique({ where: { id }, select: { id: true, teamId: true, identifier: true, deletedAt: true } });
}

export function isTombstoneExpired(deletedAt: Date, now = new Date()): boolean {
  return now.getTime() - deletedAt.getTime() > TOMBSTONE_RETENTION_MS;
}

/** Drop snapshots past retention. Returns how many were removed. */
export async function sweepExpiredTombstones(prisma: PrismaClient, now = new Date()): Promise<number> {
  const result = await prisma.workTombstone.deleteMany({ where: { deletedAt: { lt: new Date(now.getTime() - TOMBSTONE_RETENTION_MS) } } });
  return result.count;
}

/** Put a deleted item back under its original id. Returns the restored row. */
export async function restoreDeletedIssue(
  prisma: PrismaClient,
  id: string,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  return prisma.$transaction(async (tx) => {
    const tombstone = await tx.workTombstone.findUnique({ where: { id } });
    if (!tombstone) throw createNotFoundError(TOMBSTONE_NOT_FOUND_MESSAGE);
    if (isTombstoneExpired(tombstone.deletedAt)) throw createValidationError(TOMBSTONE_EXPIRED_MESSAGE);
    await lockWorkGraph(tx, tombstone.teamId);
    const snapshot = tombstone.snapshot as unknown as WorkTombstoneSnapshot;
    const { issue } = snapshot;

    const taken = await tx.issue.findFirst({ where: { OR: [{ id }, { identifier: issue.identifier }] }, select: { id: true } });
    if (taken) throw createValidationError(TOMBSTONE_ID_TAKEN_MESSAGE);
    const state = await tx.workflowState.findFirst({ where: { id: issue.stateId, teamId: issue.teamId }, select: { id: true } });
    if (!state) throw createValidationError('This work cannot be restored: its workflow state no longer exists.');

    // References that may have gone away since the deletion are dropped, not
    // invented: a missing parent leaves the item at the top of its team.
    const finders = {
      issue: (targetId: string) => tx.issue.findUnique({ where: { id: targetId }, select: { id: true } }),
      user: (targetId: string) => tx.user.findUnique({ where: { id: targetId }, select: { id: true } }),
      project: (targetId: string) => tx.project.findUnique({ where: { id: targetId }, select: { id: true } }),
      cycle: (targetId: string) => tx.cycle.findUnique({ where: { id: targetId }, select: { id: true } }),
    };
    const exists = async (table: keyof typeof finders, targetId: string | null) =>
      targetId !== null && (await finders[table](targetId)) !== null;
    const parentId = (await exists('issue', issue.parentId)) ? issue.parentId : null;
    const assigneeId = (await exists('user', issue.assigneeId)) ? issue.assigneeId : null;
    const projectId = (await exists('project', issue.projectId)) ? issue.projectId : null;
    const cycleId = (await exists('cycle', issue.cycleId)) ? issue.cycleId : null;
    const supersededById = (await exists('issue', issue.supersededById)) ? issue.supersededById : null;

    const restored = await tx.issue.create({
      data: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        stateId: issue.stateId,
        teamId: issue.teamId,
        assigneeId,
        parentId,
        priority: issue.priority,
        // Tombstones written before INV-1115 have no severity.
        severity: issue.severity ?? null,
        // Tombstones written before INV-1122 have no reproducibility.
        reproducibility: issue.reproducibility ?? null,
        // Tombstones written before INV-1121 have no found-in SHA.
        foundInSha: issue.foundInSha ?? null,
        // Tombstones written before INV-1118 have no resolution.
        resolution: issue.resolution ?? null,
        // Tombstones written before INV-1125 have no incident timestamps.
        impactStartedAt: issue.impactStartedAt ?? null,
        detectedAt: issue.detectedAt ?? null,
        mitigatedAt: issue.mitigatedAt ?? null,
        resolvedAt: issue.resolvedAt ?? null,
        kind: issue.kind,
        commitmentStatus: issue.commitmentStatus,
        revision: issue.revision + 1,
        snoozedUntil: issue.snoozedUntil,
        source: issue.source,
        outcome: issue.outcome,
        scope: issue.scope,
        constraints: issue.constraints,
        acceptance: issue.acceptance,
        verification: issue.verification,
        repository: issue.repository,
        alias: issue.alias,
        projectId,
        cycleId,
        deliveryRootId: issue.deliveryRootId,
        deliveryUnitKey: issue.deliveryUnitKey,
        deliveryGrantRevision: issue.deliveryGrantRevision,
        supersededById,
        stateSourcePrId: issue.stateSourcePrId,
        lastAppliedEventTime: issue.lastAppliedEventTime,
        createdAt: new Date(issue.createdAt),
        labels: { connect: (await tx.issueLabel.findMany({ where: { id: { in: snapshot.labelIds } }, select: { id: true } })) },
      },
    });

    // Children were detached by the deletion; those still detached come back.
    // One that was given a new parent since keeps it, and its old CONTAINS
    // link is not replayed below.
    const reattached = new Set<string>();
    for (const childId of snapshot.childIds) {
      const child = await tx.issue.findUnique({ where: { id: childId } });
      if (!child || child.parentId !== null) continue;
      const after = await tx.issue.update({ where: { id: childId }, data: { parentId: id, revision: { increment: 1 } } });
      await recordWorkAudit(tx, { actor, before: selectIssueSnapshot(child), after: selectIssueSnapshot(after), workId: childId });
      reattached.add(childId);
    }
    if (parentId) {
      await tx.workLink.upsert({
        where: { fromId_toId_type: { fromId: parentId, toId: id, type: 'CONTAINS' } },
        create: { fromId: parentId, toId: id, type: 'CONTAINS', actorId: actor.actorId ?? null },
        update: {},
      });
    }

    const userIds = new Set((await tx.user.findMany({ where: { id: { in: [...new Set(snapshot.comments.flatMap((comment) => [comment.userId, ...comment.mentionActorIds]))] } }, select: { id: true } })).map((user) => user.id));
    const restoredCommentIds = new Set<string>();
    // Roots first: a reply only comes back once its thread root has.
    const orderedComments = [...snapshot.comments].sort((a, b) => Number(a.parentCommentId !== null) - Number(b.parentCommentId !== null));
    for (const comment of orderedComments) {
      if (!userIds.has(comment.userId)) continue;
      if (comment.parentCommentId && !restoredCommentIds.has(comment.parentCommentId)) continue;
      await tx.comment.create({
        data: {
          id: comment.id,
          body: comment.body,
          userId: comment.userId,
          issueId: id,
          parentCommentId: comment.parentCommentId,
          createdAt: new Date(comment.createdAt),
          updatedAt: new Date(comment.updatedAt),
          mentions: { create: comment.mentionActorIds.filter((actorId) => userIds.has(actorId)).map((actorId) => ({ actorId })) },
        },
      });
      restoredCommentIds.add(comment.id);
    }

    for (const link of snapshot.links) {
      if (link.type === 'CONTAINS' && link.toId === id) continue; // handled with parentId above
      if (link.type === 'CONTAINS' && link.fromId === id && !reattached.has(link.toId)) continue; // child moved on
      const other = link.fromId === id ? link.toId : link.fromId;
      if (!(await exists('issue', other))) continue;
      await tx.workLink.upsert({
        where: { fromId_toId_type: { fromId: link.fromId, toId: link.toId, type: link.type as WorkLinkType } },
        create: { id: link.id, fromId: link.fromId, toId: link.toId, type: link.type as WorkLinkType, actorId: (await exists('user', link.actorId)) ? link.actorId : null, createdAt: new Date(link.createdAt) },
        update: {},
      });
    }

    for (const share of snapshot.shares) {
      if (!(await exists('user', share.userId))) continue;
      await tx.workShare.create({
        data: { id: share.id, workId: id, userId: share.userId, role: share.role as WorkShareRole, createdById: (await exists('user', share.createdById)) ? share.createdById : null, createdAt: new Date(share.createdAt) },
      });
    }

    for (const audit of snapshot.audits) {
      if (!(await exists('user', audit.actorId)) && audit.actorId !== null) continue;
      await tx.workAudit.create({
        data: {
          id: audit.id,
          workId: id,
          revision: audit.revision,
          actorKind: audit.actorKind as ActorKind,
          actorId: audit.actorId,
          surface: audit.surface,
          sessionId: audit.sessionId,
          sourceMessageId: audit.sourceMessageId,
          reason: audit.reason,
          claimGeneration: audit.claimGeneration,
          before: audit.before === null ? Prisma.JsonNull : (audit.before as Prisma.InputJsonValue),
          after: audit.after as Prisma.InputJsonValue,
          createdAt: new Date(audit.createdAt),
        },
      });
      const receipt = audit.receipt;
      if (receipt && (await exists('user', receipt.actorId))) {
        await tx.decisionReceipt.create({
          data: {
            id: receipt.id,
            auditId: audit.id,
            actorId: receipt.actorId,
            sessionId: receipt.sessionId,
            runtime: receipt.runtime,
            contractRevision: receipt.contractRevision,
            reasoning: receipt.reasoning,
            evidence: receipt.evidence as Prisma.InputJsonValue,
            inputs: receipt.inputs as Prisma.InputJsonValue,
            createdAt: new Date(receipt.createdAt),
          },
        });
      }
    }
    await recordWorkAudit(tx, { actor: { ...actor, reason: actor.reason ?? 'Restored after deletion (INV-840)' }, before: null, after: selectIssueSnapshot(restored), workId: id });

    await tx.workTombstone.delete({ where: { id } });
    return restored;
  });
}
