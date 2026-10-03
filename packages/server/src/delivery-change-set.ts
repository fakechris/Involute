import { deliveryPermissionContext } from './delivery-permissions.js';
import { hashIdempotencyRequest } from './idempotency.js';
import type { Issue, Prisma, PrismaClient } from '@prisma/client';
import type { GraphQLContext } from './auth.js';
import { assertCanWriteIssue } from './access-control.js';
import { createValidationError } from './errors.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import { parseDeliveryPolicy } from './delivery-policy.js';
import { deliveryContractDigest } from './delivery-grant.js';
import { lockWorkGraph } from './graph-integrity.js';
import { commitWork } from './claim-service.js';
import { updateIssue } from './issue-service.js';
import { createWorkLink } from './link-service.js';
import { claimIssueRevision, recordWorkAudit, selectIssueSnapshot, writeActorFromViewer } from './work-service.js';

const CONTRACT_FIELDS = ['acceptance', 'scope', 'constraints', 'outcome', 'verification'] as const;
type ContractChange = Partial<Record<typeof CONTRACT_FIELDS[number], string | null>>;
interface Changes { contract: ContractChange; policy?: unknown; mergeSourceIds: string[] }
interface Before { policy: unknown; contracts: Record<string, ContractChange>; revisions: Record<string, number>; links: Array<{ id: string; fromId: string; toId: string; type: string }>; packageRevision: number }
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Tx = Prisma.TransactionClient;

function changes(raw: unknown): Changes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw createValidationError('A delivery change needs an object.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['contract', 'policy', 'mergeSourceIds'].includes(key))) throw createValidationError('Unknown delivery change field.');
  const contract = value.contract ?? {};
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || Object.entries(contract).some(([key, val]) => !(CONTRACT_FIELDS as readonly string[]).includes(key) || (val !== null && typeof val !== 'string'))) throw createValidationError('Invalid contract changes.');
  const sourceIds = value.mergeSourceIds ?? [];
  if (!Array.isArray(sourceIds) || sourceIds.length > 50 || sourceIds.some((id) => typeof id !== 'string' || !id.trim())) throw createValidationError('Invalid merge sources.');
  if (!Object.keys(contract).length && value.policy === undefined && !sourceIds.length) throw createValidationError('The change set is empty.');
  return { contract: contract as ContractChange, ...(value.policy === undefined ? {} : { policy: value.policy }), mergeSourceIds: [...new Set(sourceIds)] };
}

async function snapshot(tx: Tx, root: Issue, input: Changes): Promise<Before> {
  const ids = [root.id, ...input.mergeSourceIds];
  const links = input.mergeSourceIds.length ? await tx.workLink.findMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] }, select: { id: true, fromId: true, toId: true, type: true }, orderBy: { id: 'asc' } }) : [];
  const children = input.mergeSourceIds.length ? await tx.issue.findMany({ where: { parentId: { in: input.mergeSourceIds } }, select: { id: true } }) : [];
  const nodes = await tx.issue.findMany({ where: { id: { in: [...ids, ...links.flatMap((link) => [link.fromId, link.toId]), ...children.map((child) => child.id)] } }, select: { id: true, revision: true, acceptance: true, scope: true, constraints: true, outcome: true, verification: true }, orderBy: { id: 'asc' } });
  const grant = await tx.deliveryPackage.findUnique({ where: { workId: root.id } });
  return { policy: grant?.policy ?? null, contracts: Object.fromEntries(nodes.filter((node) => ids.includes(node.id)).map((node) => [node.id, Object.fromEntries(CONTRACT_FIELDS.map((field) => [field, node[field]]))])), revisions: Object.fromEntries(nodes.map((node) => [node.id, node.revision])), links, packageRevision: grant?.revision ?? 0 };
}

async function writable(context: GraphQLContext, ids: string[]) {
  for (const id of ids) await assertCanWriteIssue(context.prisma, context, id);
}


export async function proposeDeliveryChange(context: GraphQLContext, input: { workId: string; expectedRevision: number; reason: string; changes: unknown }) {
  if (!context.viewer || !input.reason.trim()) throw createValidationError('An authenticated proposer and a reason are required.');
  const root = await findWorkByIdOrIdentifier(context.prisma, input.workId);
  if (!root) throw createValidationError('Delivery work not found.');
  await writable(context, [root.id]);
  const requested = changes(input.changes);
  for (let index = 0; index < requested.mergeSourceIds.length; index++) {
    const source = await findWorkByIdOrIdentifier(context.prisma, requested.mergeSourceIds[index]!);
    if (!source || source.id === root.id || source.teamId !== root.teamId || source.repository !== root.repository || source.kind !== 'ISSUE' || source.deliveryRootId || source.supersededById) throw createValidationError('Merge sources must be independent issues in the same repository and team.');
    requested.mergeSourceIds[index] = source.id;
  }
  requested.mergeSourceIds = [...new Set(requested.mergeSourceIds)];
  if (requested.mergeSourceIds.length && root.kind !== 'ISSUE') throw createValidationError('Issues can only be consolidated into an issue.');
  if (root.deliveryRootId || root.supersededById) throw createValidationError('Change the delivery package or replacement, not an inherited or superseded task.');
  return context.prisma.$transaction(async (tx) => {
    await lockWorkGraph(tx, root.teamId);
    await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${root.id}::uuid FOR NO KEY UPDATE`;
    const current = await tx.issue.findUniqueOrThrow({ where: { id: root.id } });
    if (current.revision !== input.expectedRevision) throw createValidationError('Revision conflict; refresh before proposing.');
    const sourceIds = requested.mergeSourceIds.slice().sort();
    await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ANY(${sourceIds}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    const sourceRows = await tx.issue.findMany({ where: { id: { in: sourceIds } } });
    if (sourceRows.some((source) => source.teamId !== current.teamId || source.repository !== current.repository || source.kind !== 'ISSUE' || source.deliveryRootId || source.supersededById)) throw createValidationError('A merge source changed; refresh the proposal.');
    if (requested.mergeSourceIds.length) {
      const sources = await tx.issue.findMany({ where: { id: { in: requested.mergeSourceIds } }, orderBy: { id: 'asc' } });
      if (await tx.deliveryPackage.count({ where: { workId: { in: requested.mergeSourceIds } } })) throw createValidationError('Delivery packages must be revoked and reorganized explicitly, not merged as leaf work.');
      for (const field of CONTRACT_FIELDS) {
        if (field in requested.contract) continue;
        const values = [...new Set([current[field], ...sources.map((source) => source[field])].filter((value): value is string => Boolean(value?.trim())))];
        if (values.length > 1) requested.contract[field] = values.join('\n\n');
        else if (!current[field] && values.length) requested.contract[field] = values[0]!;
      }
    }
    const updatedContract = { ...current, ...requested.contract };
    if (!updatedContract.acceptance?.trim()) throw createValidationError('Acceptance cannot be cleared.');
    if (requested.policy !== undefined) requested.policy = parseDeliveryPolicy(requested.policy, updatedContract);

    const freshContext = await deliveryPermissionContext(tx, context, current, 'propose');
    const before = await snapshot(tx, current, requested);
    await writable(freshContext, Object.keys(before.revisions));
    return tx.deliveryChangeSet.create({ data: { workId: current.id, proposedById: context.viewer!.id, reason: input.reason.trim(), changes: json(requested), before: json(before) } });
  });
}

export async function decideDeliveryChange(context: GraphQLContext, input: { id: string; approve: boolean; note?: string | null; ownerId?: string | null }) {
  if (context.viewer?.actorKind !== 'HUMAN') throw createValidationError('Only a person may approve or reject a delivery change set.');
  const hint = await context.prisma.deliveryChangeSet.findUniqueOrThrow({ where: { id: input.id }, include: { work: true } });
  await writable(context, [hint.workId]);
  return context.prisma.$transaction(async (tx) => {
    await lockWorkGraph(tx, hint.work.teamId);
    await tx.$queryRaw`SELECT id FROM "DeliveryChangeSet" WHERE id = ${input.id}::uuid FOR UPDATE`;
    const set = await tx.deliveryChangeSet.findUniqueOrThrow({ where: { id: input.id } });
    const expected = set.before as unknown as Before;
    const lockedIds = Object.keys(expected.revisions).sort();
    await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ANY(${lockedIds}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    const permissionWork = await tx.issue.findUniqueOrThrow({ where: { id: set.workId } });
    const freshContext = await deliveryPermissionContext(tx, context, permissionWork, 'claim');
    if (freshContext.viewer.actorKind !== 'HUMAN') throw createValidationError('Only a person may approve or reject a delivery change set.');
    await writable(freshContext, [set.workId]);
    if (set.status !== 'PENDING') throw createValidationError('This delivery change has already been decided.');
    if (!input.approve) {
      if (!input.note?.trim()) throw createValidationError('Declining a delivery change needs a reason.');
      return tx.deliveryChangeSet.update({ where: { id: set.id }, data: { status: 'REJECTED', decidedById: context.viewer!.id, decidedAt: new Date(), decisionNote: input.note.trim() } });
    }
    const requested = changes(set.changes);
    let root = await tx.issue.findUniqueOrThrow({ where: { id: set.workId } });
    if (root.commitmentStatus === 'REJECTED') throw createValidationError('Restore the rejected candidate before approving delivery.');
    const before = set.before as unknown as Before;
    const current = await snapshot(tx, root, requested);
    if (hashIdempotencyRequest(current) !== hashIdempotencyRequest(before)) throw createValidationError('Delivery change conflicts with current work, links or authorization; nothing was applied.');
    await writable(freshContext, Object.keys(before.revisions));
    const actor = { ...writeActorFromViewer(context.viewer, 'delivery-change'), reason: set.reason };
    const rootState = await tx.workflowState.findUniqueOrThrow({ where: { id: root.stateId } });
    if (['COMPLETED', 'CANCELED'].includes(rootState.type) || root.supersededById || root.deliveryRootId) throw createValidationError('Reopen the delivery package before approving a change.');
    // Mark this decision inside the transaction so ordinary commitment cannot bypass approval.
    await tx.deliveryChangeSet.update({ where: { id: set.id }, data: { status: 'APPLYING' } });
    if (root.commitmentStatus === 'CANDIDATE') {
      root = await commitWork(tx, root.id, { expectedRevision: root.revision, assigneeId: input.ownerId ?? root.assigneeId ?? context.viewer!.id }, actor);
    }
    let target = Object.keys(requested.contract).length ? await updateIssue(tx, root.id, { ...requested.contract, expectedRevision: root.revision }, actor) : root;
    if (requested.mergeSourceIds.length) {
      if (await tx.workClaim.count({ where: { workId: { in: [root.id, ...requested.mergeSourceIds] }, leaseUntil: { gt: new Date() } } })) throw createValidationError('Release active execution claims before consolidating work.');
      const sourceIds = requested.mergeSourceIds;
      const incident = await tx.workLink.findMany({ where: { type: { not: 'CONTAINS' }, OR: [{ fromId: { in: sourceIds } }, { toId: { in: sourceIds } }] } });
      await tx.workLink.deleteMany({ where: { id: { in: incident.map((link) => link.id) } } });
      for (const link of incident) {
        const fromId = sourceIds.includes(link.fromId) ? root.id : link.fromId;
        const toId = sourceIds.includes(link.toId) ? root.id : link.toId;
        if (fromId !== toId) await createWorkLink(tx, { fromId, toId, type: link.type, actor });
      }
      const children = await tx.issue.findMany({ where: { parentId: { in: sourceIds } } });
      for (const child of children) await updateIssue(tx, child.id, { parentId: root.id, expectedRevision: child.revision }, actor);
      for (const id of sourceIds) {
        const source = await tx.issue.findUniqueOrThrow({ where: { id } });
        await claimIssueRevision(tx, id, source.revision);
        const reviewState = await tx.workflowState.findFirstOrThrow({ where: { teamId: source.teamId, type: 'REVIEW' } });
        const after = await tx.issue.update({ where: { id }, data: { supersededById: root.id, stateId: reviewState.id } });
        await tx.workEvidence.updateMany({ where: { workId: id }, data: { supersededByWorkId: root.id } });
        await createWorkLink(tx, { fromId: id, toId: root.id, type: 'DUPLICATE_OF', actor });
        await recordWorkAudit(tx, { workId: id, before: selectIssueSnapshot(source), after: selectIssueSnapshot(after), actor });
      }
    }
    if (requested.policy !== undefined) {
      const policy = parseDeliveryPolicy(requested.policy, target);
      await tx.deliveryPackage.upsert({ where: { workId: target.id }, create: { workId: target.id, policy: json(policy), contractDigest: deliveryContractDigest(target), approvedById: context.viewer!.id }, update: { revision: { increment: 1 }, policy: json(policy), contractDigest: deliveryContractDigest(target), approvedById: context.viewer!.id, approvedAt: new Date(), revokedAt: null } });
    }
    if (target.revision === root.revision) {
      await claimIssueRevision(tx, target.id, target.revision);
      target = await tx.issue.findUniqueOrThrow({ where: { id: target.id } });
      await recordWorkAudit(tx, { workId: target.id, before: selectIssueSnapshot(root), after: selectIssueSnapshot(target), actor });
    }
    return tx.deliveryChangeSet.update({ where: { id: set.id }, data: { status: 'APPLIED', decidedById: context.viewer!.id, decidedAt: new Date(), decisionNote: input.note?.trim() ?? null } });
  });
}
