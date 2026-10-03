import type { Issue, Prisma } from '@prisma/client';
import { approvedDelivery, assertDeliveryExecution } from './delivery-grant.js';
import { hasTechnicalDeliveryProof } from './delivery-readiness.js';
import { snapshotContract } from './evidence-contract.js';
import { createValidationError } from './errors.js';
import { claimIssueRevision, recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';
import { enqueueWorkEvent } from './event-outbox.js';

export async function prepareDeliveryAcceptance(tx: Prisma.TransactionClient, work: Issue) {
  const grant = await tx.deliveryPackage.findUnique({ where: { workId: work.id } });
  if (!grant) return [];
  const { policy } = await approvedDelivery(tx, work.id);
  const tasks = await tx.issue.findMany({ where: { deliveryRootId: work.id, deliveryGrantRevision: grant.revision }, orderBy: { id: 'asc' } });
  if (tasks.length !== policy.units.length) throw createValidationError('The package still has implementation units that have not been created.');
  const ids = tasks.map((task) => task.id);
  await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
  const prepared = [];
  for (const hint of tasks) {
    const task = await tx.issue.findUniqueOrThrow({ where: { id: hint.id } });
    const binding = await assertDeliveryExecution(tx, task);
    if (binding?.unit.executorActorId) {
      const dispatch = await tx.executorDispatch.findUnique({ where: { workId_grantRevision: { workId: task.id, grantRevision: grant.revision } } });
      if (dispatch && await tx.executorEffect.count({ where: { dispatchId: dispatch.id, state: 'STARTED' } })) throw createValidationError('An implementation unit has an unresolved external effect.');
      if (!dispatch || dispatch.state !== 'DELIVERED' || !await tx.executorDeliveryReceipt.count({ where: { dispatchId: dispatch.id, generation: dispatch.generation, runId: dispatch.runId ?? '', final: true } })) throw createValidationError('An implementation unit has no current executor delivery receipt.');
    }
    const run = await tx.workRun.findFirst({ where: { workId: task.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (binding?.unit.executorActorId && (await tx.executorDispatch.findUnique({ where: { workId_grantRevision: { workId: task.id, grantRevision: grant.revision } } }))?.runId !== run?.id) throw createValidationError('An implementation unit has no current executor delivery receipt.');
    const claim = await tx.workClaim.findUnique({ where: { workId: task.id } });
    if (!binding || !run || run.status !== 'COMPLETED' || run.executionRevokedAt || !run.claimSnapshotId || run.contractRevision !== snapshotContract(task).contractRevision || (claim && claim.leaseUntil > new Date())) throw createValidationError('An implementation unit is not ready for final acceptance.');
    if (binding.unit.checks.length && !(await hasTechnicalDeliveryProof(tx, task))) throw createValidationError('An implementation unit lacks current verified CI evidence.');
    if (!binding.unit.checks.length && !(await tx.workEvidence.count({ where: { workId: task.id, runId: run.id, retractedAt: null } }))) throw createValidationError('An implementation unit has no delivery evidence for review.');
    prepared.push({ task, runId: run.id });
  }
  return prepared;
}

export async function acceptDeliveryChildren(tx: Prisma.TransactionClient, tasks: Awaited<ReturnType<typeof prepareDeliveryAcceptance>>, root: Issue, stateId: string, actor: WriteActor) {
  for (const { task, runId } of tasks) {
    await claimIssueRevision(tx, task.id, task.revision);
    const after = await tx.issue.update({ where: { id: task.id }, data: { stateId } });
    const decision = await tx.workReviewDecision.create({ data: { workId: task.id, runId, reviewerId: actor.actorId!, decision: 'ACCEPTED', fromRevision: task.revision, toRevision: after.revision, reason: `Accepted with delivery package ${root.identifier}.` } });
    await recordWorkAudit(tx, { workId: task.id, before: selectIssueSnapshot(task), after: selectIssueSnapshot(after), actor: { ...actor, reason: `Accepted with delivery package ${root.identifier}.` } });
    await enqueueWorkEvent(tx, { type: 'work.accepted', workId: task.id, workIdentifier: task.identifier, payload: { decisionId: decision.id, packageWorkId: root.id, reviewerId: actor.actorId, runId } });
  }
}

export async function returnDeliveryChildren(tx: Prisma.TransactionClient, root: Issue, stateId: string, actor: WriteActor, reason: string | null) {
  const grant = await tx.deliveryPackage.findUnique({ where: { workId: root.id } });
  if (!grant) return;
  const tasks = await tx.issue.findMany({ where: { deliveryRootId: root.id, deliveryGrantRevision: grant.revision }, orderBy: { id: 'asc' } });
  const ids = tasks.map((task) => task.id);
  await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
  if (await tx.workClaim.count({ where: { workId: { in: ids }, leaseUntil: { gt: new Date() } } })) throw createValidationError('Release active implementation claims before returning the package for changes.');
  for (const hint of tasks) {
    const task = await tx.issue.findUniqueOrThrow({ where: { id: hint.id } });
    const run = await tx.workRun.findFirst({ where: { workId: task.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    await claimIssueRevision(tx, task.id, task.revision);
    const after = await tx.issue.update({ where: { id: task.id }, data: { stateId } });
    await tx.workRun.updateMany({ where: { workId: task.id, executionRevokedAt: null }, data: { executionRevokedAt: new Date() } });
    const binding = await assertDeliveryExecution(tx, task);
    const dispatch = await tx.executorDispatch.findUnique({ where: { workId_grantRevision: { workId: task.id, grantRevision: grant.revision } } });
    if (dispatch) {
      const retry = dispatch.state === 'DELIVERED' && dispatch.generation < (binding?.unit.maxAttempts ?? 1);
      await tx.executorDispatch.update({ where: { id: dispatch.id }, data: { state: retry ? 'QUEUED' : 'EXHAUSTED', generation: { increment: 1 }, revision: { increment: 1 }, runId: null, leaseUntil: null, feedback: reason ?? 'Returned for changes' } });
      await enqueueWorkEvent(tx, { type: retry ? 'executor.dispatched' : 'executor.exhausted', workId: task.id, workIdentifier: task.identifier, payload: { dispatchId: dispatch.id, generation: dispatch.generation + 1, feedback: reason, actorId: actor.actorId, protocolVersion: 1 } });
    }
    const decision = await tx.workReviewDecision.create({ data: { workId: task.id, runId: run?.id ?? null, reviewerId: actor.actorId!, decision: 'REJECTED', fromRevision: task.revision, toRevision: after.revision, reason: reason ?? `Returned with delivery package ${root.identifier}.` } });
    await recordWorkAudit(tx, { workId: task.id, before: selectIssueSnapshot(task), after: selectIssueSnapshot(after), actor: { ...actor, reason: decision.reason } });
    await enqueueWorkEvent(tx, { type: 'work.review_rejected', workId: task.id, workIdentifier: task.identifier, payload: { decisionId: decision.id, packageWorkId: root.id, reviewerId: actor.actorId, reason: decision.reason } });
  }
}
