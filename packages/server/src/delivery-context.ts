import type { GraphQLContext } from './auth.js';
import { assertCanReadIssue, assertCanWriteIssue, buildReadableIssueWhere } from './access-control.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import { createValidationError } from './errors.js';
import { approvedDelivery } from './delivery-grant.js';
import { hasTechnicalDeliveryProof } from './delivery-readiness.js';

export async function deliveryContext(context: GraphQLContext, id: string) {
  const initial = await findWorkByIdOrIdentifier(context.prisma, id);
  if (!initial) throw createValidationError('Delivery work not found.');
  const workId = initial.deliveryRootId ?? initial.id;
  await assertCanReadIssue(context.prisma, context, workId);
  const work = await context.prisma.issue.findUniqueOrThrow({ where: { id: workId } });
  const grant = await context.prisma.deliveryPackage.findUnique({ where: { workId } });
  let authorizationValid = false;
  let authorizationMessage = 'No approved delivery package';
  try { await approvedDelivery(context.prisma, workId); authorizationValid = true; authorizationMessage = 'Approved'; }
  catch (error) { authorizationMessage = error instanceof Error ? error.message : 'Authorization unavailable'; }
  const executions = await context.prisma.issue.findMany({ where: { AND: [{ deliveryRootId: workId, deliveryGrantRevision: grant?.revision ?? -1 }, buildReadableIssueWhere(context) ?? {}] }, orderBy: [{ deliveryGrantRevision: 'desc' }, { deliveryUnitKey: 'asc' }] });
  const units = [];
  for (const issue of executions) units.push({ issue, technicalReady: await hasTechnicalDeliveryProof(context.prisma, issue) });
  let viewerCanWrite = false;
  try { await assertCanWriteIssue(context.prisma, context, workId); viewerCanWrite = true; } catch { /* Read-only views omit controls. */ }
  return { work, grant, units, authorizationValid, authorizationMessage, viewerCanWrite };
}

export async function pendingDeliveryChanges(context: GraphQLContext, input: { first?: number | null; after?: string | null; repository?: string | null } = {}) {
  const first = input.first ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > 100) throw createValidationError('Choose first between 1 and 100.');
  if (input.after && !/^[0-9a-f-]{36}$/i.test(input.after)) throw createValidationError('Invalid delivery queue cursor.');
  const nodes = await context.prisma.deliveryChangeSet.findMany({ where: { status: 'PENDING', ...(input.after ? { id: { gt: input.after } } : {}), work: { AND: [buildReadableIssueWhere(context) ?? {}, ...(input.repository ? [{ repository: input.repository }] : [])] } }, orderBy: { id: 'asc' }, take: first + 1 });
  const page = nodes.slice(0, first);
  return { nodes: page, pageInfo: { hasNextPage: nodes.length > first, endCursor: page.at(-1)?.id ?? null } };
}
