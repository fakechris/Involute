import { resolveShareScope } from './project-sharing.js';
import type { Issue, Prisma } from '@prisma/client';
import type { GraphQLContext } from './auth.js';
import { assertExecutionAuthority } from './work-execution.js';
import { writeActorFromViewer } from './work-service.js';
import { createValidationError } from './errors.js';
type Tx = Prisma.TransactionClient;

export async function deliveryPermissionContext(tx: Tx, context: GraphQLContext, work: Issue, scope: 'propose' | 'claim' | 'report') {
  if (!context.viewer) throw createValidationError('An authenticated actor is required.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${context.viewer.id}::uuid FOR SHARE`;
  const viewer = await tx.user.findUnique({ where: { id: context.viewer.id } });
  if (!viewer || viewer.deactivatedAt || viewer.actorKind !== context.viewer.actorKind) throw createValidationError('Delivery actor is no longer active.');
  if (viewer.actorKind === 'AGENT') await assertExecutionAuthority(tx, { ...writeActorFromViewer(viewer), agentCredentialId: context.agentCredentialId ?? null }, work, scope);
  await tx.$queryRaw`SELECT id FROM "WorkShare" WHERE "userId" = ${viewer.id}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "TeamMembership" WHERE "userId" = ${viewer.id}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${work.teamId}::uuid FOR SHARE`;

  const { shareScope: _cachedShareScope, ...freshContext } = context;
  return { ...freshContext, viewer, shareScope: await resolveShareScope(tx, viewer.id) };
}
