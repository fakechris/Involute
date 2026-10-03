import type { Prisma } from '@prisma/client';
import type { GraphQLContext } from './auth.js';
import { assertCanReadIssue, assertCanWriteIssue, buildReadableIssueWhere } from './access-control.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import { assertDeliveryExecution } from './delivery-grant.js';
import { deliveryPermissionContext } from './delivery-permissions.js';
import { assertWorkToken } from './work-execution.js';
import { lockWorkGraph } from './graph-integrity.js';
import { createValidationError } from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { executorVisibleState, parseExecutorReceipt, receiptAssessment } from './executor-protocol.js';
import { digest } from './evidence-contract.js';
import { snapshotContract } from './evidence-contract.js';

export const EXECUTOR_OPERATIONS = ['dispatch', 'recover', 'ack', 'checkpoint', 'stop', 'stop_ack', 'prepare_effect', 'start_effect', 'receipt'] as const;
export interface ExecutorInput {
  workId: string;
  operation: typeof EXECUTOR_OPERATIONS[number];
  expectedRevision?: number;
  generation?: number;
  runId?: string;
  claimToken?: string;
  checkpoint?: string;
  effect?: { key: string; action: 'merge' | 'deploy'; environment?: string; commitSha: string; paths: string[] };
  effectId?: string;
  receipt?: unknown;
  idempotencyKey?: string;
}
function refuse(message: string): never { throw createValidationError(message); }
const bounded = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;

export async function executorContext(context: GraphQLContext, id: string) {
  const work = await findWorkByIdOrIdentifier(context.prisma, id);
  if (!work) return refuse('Executor work not found.');
  await assertCanReadIssue(context.prisma, context, work.id);
  const readable = await context.prisma.issue.findMany({ where: { AND: [{ OR: [{ id: work.id }, { deliveryRootId: work.id }] }, buildReadableIssueWhere(context) ?? {}] }, select: { id: true } });
  const rows = await context.prisma.executorDispatch.findMany({ where: { workId: { in: readable.map((item) => item.id) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, include: { receipts: { orderBy: { createdAt: 'desc' }, take: 20 }, effects: { orderBy: { createdAt: 'desc' }, take: 100 } } });
  let viewerCanWrite = false;
  try { await assertCanWriteIssue(context.prisma, context, work.id); viewerCanWrite = true; } catch { /* no controls */ }
  const dispatches = await Promise.all(rows.map(async (row) => {
    let visibleState = executorVisibleState(row);
    if (visibleState === 'RUNNING') {
      try {
        const task = await context.prisma.issue.findUniqueOrThrow({ where: { id: row.workId } });
        const binding = await assertDeliveryExecution(context.prisma, task);
        const run = row.runId ? await context.prisma.workRun.findUnique({ where: { id: row.runId } }) : null;
        const claim = await context.prisma.workClaim.findUnique({ where: { workId: row.workId } });
        if (!binding || binding.grant.revision !== row.grantRevision || binding.unit.executorActorId !== row.executorActorId || !run || run.executionRevokedAt || !claim || claim.id !== run.claimId || claim.leaseUntil <= new Date()) visibleState = 'UNKNOWN';
      } catch { visibleState = 'UNKNOWN'; }
    }
    return { ...row, visibleState, receipts: row.receipts.map((item) => {
    const receipt = parseExecutorReceipt(item.payload);
    const effect = row.effects.find((effect) => effect.id === item.effectId);
    return { ...item, assessment: receiptAssessment(receipt, effect?.commitSha) };
  }) }; }));
  return { protocolVersion: 1, work: { id: work.id, repository: work.repository }, viewerCanWrite, dispatches };
}

/** This kernel records authority and receipts; it never executes a remote shell. */
export async function executorUpdate(context: GraphQLContext, input: ExecutorInput) {
  if (!context.viewer || !EXECUTOR_OPERATIONS.includes(input.operation)) return refuse('Invalid executor operation.');
  const hint = await findWorkByIdOrIdentifier(context.prisma, input.workId);
  if (!hint?.deliveryRootId) return refuse('An executor requires an approved delivery implementation unit.');
  await assertCanWriteIssue(context.prisma, context, hint.id);
  return context.prisma.$transaction(async (tx) => {
    await lockWorkGraph(tx, hint.teamId);
    const ids = [hint.deliveryRootId!, hint.id].sort();
    await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    const work = await tx.issue.findUniqueOrThrow({ where: { id: hint.id } });
    const fresh = await deliveryPermissionContext(tx, context, work, ['dispatch', 'recover', 'stop'].includes(input.operation) ? 'claim' : 'report');
    await assertCanWriteIssue(context.prisma, fresh, work.id);
    const row = await tx.executorDispatch.findUnique({ where: { workId_grantRevision: { workId: work.id, grantRevision: work.deliveryGrantRevision! } } });
    // Stop remains possible after grant revocation; stopping does not grant execution authority.
    const binding = ['stop', 'stop_ack'].includes(input.operation) ? null : await assertDeliveryExecution(tx, work);
    const executorId = binding?.unit.executorActorId ?? row?.executorActorId;
    if (!executorId) return refuse('Approve an explicit executor in the delivery candidate first.');
    const actor = await tx.user.findUnique({ where: { id: executorId } });
    if (input.operation !== 'stop' && (!actor || actor.actorKind !== 'AGENT' || actor.deactivatedAt)) return refuse('The approved executor is unavailable.');
    if (input.operation === 'dispatch') {
      if (row) return row;
      const created = await tx.executorDispatch.create({ data: { workId: work.id, rootId: work.deliveryRootId!, grantRevision: work.deliveryGrantRevision!, executorActorId: executorId } });
      await event(tx, work, created.id, created.generation, fresh.viewer.id, 'executor.dispatched');
      return created;
    }
    if (!row || row.revision !== input.expectedRevision || row.generation !== input.generation) return refuse('Executor revision or generation changed; refresh before retrying.');
    if (input.operation === 'recover') {
      if (!['UNKNOWN', 'STOPPED'].includes(executorVisibleState(row))) return refuse('Only an expired or stopped execution can be recovered.');
      if (await tx.workClaim.count({ where: { workId: work.id, leaseUntil: { gt: new Date() } } })) return refuse('An execution lease is still active.');
      if (await tx.executorEffect.count({ where: { dispatchId: row.id, generation: row.generation, state: 'STARTED' } })) return refuse('An external effect has an unknown result; reconcile it before starting another execution.');
      if (row.generation >= (binding!.unit.maxAttempts ?? 1)) return refuse('The approved execution attempt budget is exhausted; propose a candidate change.');
      if (row.runId) await tx.workRun.update({ where: { id: row.runId }, data: { executionRevokedAt: new Date() } });
      const updated = await tx.executorDispatch.update({ where: { id: row.id }, data: { state: 'QUEUED', generation: { increment: 1 }, revision: { increment: 1 }, runId: null, leaseUntil: null } });
      await event(tx, work, row.id, updated.generation, fresh.viewer.id, 'executor.dispatched');
      return updated;
    }
    if (input.operation === 'stop') {
      if (['STOPPED', 'DELIVERED'].includes(row.state)) return row;
      const updated = await tx.executorDispatch.update({ where: { id: row.id }, data: { state: row.state === 'QUEUED' ? 'STOPPED' : 'STOP_REQUESTED', revision: { increment: 1 } } });
      await event(tx, work, row.id, row.generation, fresh.viewer.id, 'executor.stop_requested');
      return updated;
    }
    if (fresh.viewer.id !== executorId || fresh.viewer.actorKind !== 'AGENT') return refuse('Only the approved executor may acknowledge or report this dispatch.');
    const runId = input.operation === 'ack' ? input.runId : row.runId;
    const run = runId ? await tx.workRun.findUnique({ where: { id: runId } }) : null;
    if (!run || run.workId !== work.id || run.actorId !== executorId || run.executionRevokedAt || run.contractRevision !== snapshotContract(work).contractRevision) return refuse('The executor run is missing, stale or revoked.');
    assertWorkToken(run.executionTokenHash, input.claimToken);
    if (input.operation === 'stop_ack') {
      if (!['STOP_REQUESTED', 'STOPPED'].includes(row.state)) return refuse('No stop was requested for this execution.');
      const uncertain = await tx.executorEffect.count({ where: { dispatchId: row.id, generation: row.generation, state: 'STARTED' } });
      const updated = await tx.executorDispatch.update({ where: { id: row.id }, data: { state: uncertain ? 'UNKNOWN' : 'STOPPED', leaseUntil: null, ...(uncertain ? { checkpoint: 'Runtime stop acknowledged; external effect outcome remains unknown.' } : {}), revision: { increment: 1 } } });
      await event(tx, work, row.id, row.generation, fresh.viewer.id, 'executor.stopped');
      return updated;
    }
    if (input.operation === 'receipt' && bounded(input.idempotencyKey, 100)) {
      const existing = await tx.executorDeliveryReceipt.findUnique({ where: { dispatchId_generation_idempotencyKey: { dispatchId: row.id, generation: row.generation, idempotencyKey: input.idempotencyKey } } });
      if (existing) {
        let incoming;
        try { incoming = parseExecutorReceipt(input.receipt); } catch { return refuse('Invalid version 1 executor receipt.'); }
        if (existing.effectId !== (input.effectId ?? null) || digest(existing.payload) !== digest(incoming)) return refuse('The receipt idempotency key was reused with different facts.');
        return existing;
      }
    }
    const claim = await tx.workClaim.findUnique({ where: { workId: work.id } });
    if (!claim || claim.id !== run.claimId || claim.actorId !== executorId || claim.leaseUntil <= new Date()) return refuse('An active execution lease is required.');
    assertWorkToken(claim.executionTokenHash, input.claimToken);
    if (input.operation === 'ack') {
      if (row.state !== 'QUEUED' || run.status !== 'RUNNING') return refuse('Only a queued dispatch can be acknowledged with a running execution.');
      const updated = await tx.executorDispatch.update({ where: { id: row.id }, data: { state: 'RUNNING', runId: run.id, leaseUntil: claim.leaseUntil, revision: { increment: 1 } } });
      await event(tx, work, row.id, row.generation, fresh.viewer.id, 'executor.acknowledged');
      return updated;
    }
    if (row.state !== 'RUNNING' || row.runId !== run.id || executorVisibleState(row) !== 'RUNNING') return refuse('The executor is stopped, expired or no longer running.');
    if (input.operation === 'checkpoint') {
      if (!bounded(input.checkpoint, 8000)) return refuse('A checkpoint must contain 1–8000 characters.');
      return tx.executorDispatch.update({ where: { id: row.id }, data: { checkpoint: input.checkpoint, leaseUntil: claim.leaseUntil, revision: { increment: 1 } } });
    }
    if (input.operation === 'prepare_effect') {
      const effect = input.effect;
      if (!effect || !bounded(effect.key, 100) || !['merge', 'deploy'].includes(effect.action) || !/^[a-f0-9]{40}$/.test(effect.commitSha) || !Array.isArray(effect.paths) || !effect.paths.length || effect.paths.length > 1000) return refuse('Invalid executor effect intent.');
      if (effect.action === 'merge' && effect.commitSha !== run.commitSha) return refuse('The merge intent must match the bound PR head.');
      if (!binding!.unit.actions.includes(effect.action) || (effect.action === 'deploy' && (!effect.environment || !binding!.policy.environments.includes(effect.environment))) || (effect.action === 'merge' && effect.environment)) return refuse('The effect action or environment was not approved.');
      if (!effect.paths.every((path) => typeof path === 'string' && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part && part !== '.' && part !== '..') && binding!.unit.paths.some((allowed) => path === allowed || allowed.endsWith('/') && path.startsWith(allowed)))) return refuse('The effect changes paths outside the approved scope.');
      const existing = await tx.executorEffect.findUnique({ where: { dispatchId_generation_key: { dispatchId: row.id, generation: row.generation, key: effect.key } } });
      if (existing) {
        if (existing.action !== effect.action || existing.commitSha !== effect.commitSha || existing.environment !== (effect.environment ?? null) || JSON.stringify(existing.paths) !== JSON.stringify(effect.paths)) return refuse('The effect idempotency key was reused with different arguments.');
        return existing;
      }
      return tx.executorEffect.create({ data: { dispatchId: row.id, generation: row.generation, ...effect } });
    }
    if (input.operation === 'start_effect') {
      const effect = input.effectId ? await tx.executorEffect.findUnique({ where: { id: input.effectId } }) : null;
      if (!effect || effect.dispatchId !== row.id || effect.generation !== row.generation || effect.state !== 'PREPARED') return refuse('This effect has already started or is unavailable; reconcile an unknown result instead of replaying it.');
      // Re-read authorization AFTER all executor preparation awaits, immediately before its effect callback.
      if (!binding!.unit.actions.includes(effect.action as 'merge' | 'deploy') || effect.action === 'deploy' && !binding!.policy.environments.includes(effect.environment!)) return refuse('The effect action or environment was not approved.');
      return tx.executorEffect.update({ where: { id: effect.id }, data: { state: 'STARTED', startedAt: new Date() } });
    }
    if (input.operation === 'receipt') {
      if (!bounded(input.idempotencyKey, 100)) return refuse('A receipt idempotency key is required.');
      let receipt;
      try { receipt = parseExecutorReceipt(input.receipt); } catch { return refuse('Invalid version 1 executor receipt.'); }
      if (receipt.repository !== work.repository || receipt.commitSha !== run.commitSha || receipt.pullRequestNumber !== run.pullRequestNumber) return refuse('Receipt provenance does not match the bound run.');
      if (Date.parse(receipt.observedAt) > Date.now() + 60_000 || Date.parse(receipt.observedAt) < run.startedAt.getTime()) return refuse('The receipt observation time is outside this execution.');
      if (receipt.environment !== null && !binding!.policy.environments.includes(receipt.environment)) return refuse('The receipt environment was not approved.');
      const effect = input.effectId ? await tx.executorEffect.findFirst({ where: { id: input.effectId, dispatchId: row.id, generation: row.generation, action: 'deploy', environment: receipt.environment, state: 'STARTED' } }) : null;
      if (receipt.environment && !effect || input.effectId && !effect) return refuse('No deployment intent was started for this receipt.');
      const existing = await tx.executorDeliveryReceipt.findUnique({ where: { dispatchId_generation_idempotencyKey: { dispatchId: row.id, generation: row.generation, idempotencyKey: input.idempotencyKey } } });
      if (existing) {
        if (digest(existing.payload) !== digest(receipt)) return refuse('The receipt idempotency key was reused with different facts.');
        return existing;
      }
      const created = await tx.executorDeliveryReceipt.create({ data: { dispatchId: row.id, generation: row.generation, runId: run.id, actorId: executorId, effectId: effect?.id ?? null, idempotencyKey: input.idempotencyKey, payload: receipt as unknown as Prisma.InputJsonValue } });
      await tx.executorDispatch.update({ where: { id: row.id }, data: { state: 'DELIVERED', revision: { increment: 1 } } });
      await event(tx, work, row.id, row.generation, fresh.viewer.id, 'executor.delivered');
      return created;
    }
    return refuse('Invalid executor operation.');
  });
}
async function event(tx: Prisma.TransactionClient, work: { id: string; identifier: string }, dispatchId: string, generation: number, actorId: string, type: 'executor.dispatched' | 'executor.acknowledged' | 'executor.stop_requested' | 'executor.stopped' | 'executor.delivered') {
  await enqueueWorkEvent(tx, { type, workId: work.id, workIdentifier: work.identifier, payload: { dispatchId, generation, actorId, protocolVersion: 1 } });
}
