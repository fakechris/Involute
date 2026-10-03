import { enqueueWorkEvent } from './event-outbox.js';
import type { GraphQLContext } from './auth.js';
import { assertCanWriteIssue } from './access-control.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import { approvedDelivery } from './delivery-grant.js';
import { executionContract } from './delivery-policy.js';
import { createValidationError } from './errors.js';
import { lockWorkGraph } from './graph-integrity.js';
import { createIssueInTransaction } from './issue-service.js';
import { createWorkLink } from './link-service.js';
import { deliveryPermissionContext } from './delivery-permissions.js';
import { recordWorkAudit, selectIssueSnapshot, writeActorFromViewer } from './work-service.js';

export async function createDeliveryExecution(context: GraphQLContext, input: { workId: string; unitKey: string; expectedGrantRevision: number }) {
  if (!context.viewer) throw createValidationError('An authenticated execution actor is required.');
  const hint = await findWorkByIdOrIdentifier(context.prisma, input.workId);
  if (!hint) throw createValidationError('Delivery package not found.');
  await assertCanWriteIssue(context.prisma, context, hint.id);
  const actor = { ...writeActorFromViewer(context.viewer, 'delivery-execution'), agentCredentialId: context.agentCredentialId ?? null };
  return context.prisma.$transaction(async (tx) => {
    await lockWorkGraph(tx, hint.teamId);
    await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${hint.id}::uuid FOR NO KEY UPDATE`;
    const { work, grant, policy } = await approvedDelivery(tx, hint.id);
    const freshContext = await deliveryPermissionContext(tx, context, work, 'claim');
    await assertCanWriteIssue(context.prisma, freshContext, work.id);
    if (grant.revision !== input.expectedGrantRevision) throw createValidationError('Delivery authorization revision changed; refresh the package.');
    if (!policy.units.some((unit) => unit.key === input.unitKey)) throw createValidationError('This implementation unit was not approved.');
    const state = await tx.workflowState.findFirstOrThrow({ where: { teamId: work.teamId, type: 'UNSTARTED' }, orderBy: { position: 'asc' } });
    const instantiate = async (key: string): Promise<import('@prisma/client').Issue> => {
      const existing = await tx.issue.findUnique({ where: { deliveryRootId_deliveryUnitKey_deliveryGrantRevision: { deliveryRootId: work.id, deliveryUnitKey: key, deliveryGrantRevision: grant.revision } } });
      if (existing) return existing;
      const unit = policy.units.find((candidate) => candidate.key === key)!;
      const predecessors = [];
      for (const dependency of unit.dependsOn) predecessors.push(await instantiate(dependency));
      const contract = executionContract(policy, key, work);
      const created = await createIssueInTransaction(tx, { ...contract, teamId: work.teamId, parentId: work.id, assigneeId: work.assigneeId, stateId: state.id, priority: work.priority, commitmentStatus: 'COMMITTED', kind: 'ISSUE', source: 'delivery-execution', description: `### 1. 目标与架构定位\n实施交付包 ${work.identifier} 中已批准的单元 ${key}。\n### 2. 核心功能与交付范围\n${contract.scope}\n允许路径：${unit.paths.join(', ')}\n### 3. 验收标准与验证方案\n${contract.acceptance}\n${contract.verification ?? ''}` }, actor);
      const bound = await tx.issue.update({ where: { id: created.id }, data: { deliveryRootId: work.id, deliveryUnitKey: key, deliveryGrantRevision: grant.revision } });
      await recordWorkAudit(tx, { workId: bound.id, before: selectIssueSnapshot(created), after: selectIssueSnapshot(bound), actor: { ...actor, reason: `Bound to approved delivery ${work.identifier} generation ${grant.revision}, unit ${key}.` } });
      for (const predecessor of predecessors) await createWorkLink(tx, { fromId: predecessor.id, toId: bound.id, type: 'BLOCKS', actor });
      if (unit.executorActorId) {
        const dispatch = await tx.executorDispatch.create({ data: { workId: bound.id, rootId: work.id, grantRevision: grant.revision, executorActorId: unit.executorActorId } });
        await enqueueWorkEvent(tx, { type: 'executor.dispatched', workId: bound.id, workIdentifier: bound.identifier, payload: { dispatchId: dispatch.id, generation: 1, actorId: actor.actorId, protocolVersion: 1 } });
      }
      return bound;
    };
    return instantiate(input.unitKey);
  });
}
