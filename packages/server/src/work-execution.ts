import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createValidationError } from './errors.js';

export const WORK_EXECUTION_REQUIRED = 'This execution does not hold the work lease. Supply the claim_token returned by work_claim; a lost token requires a new lease after expiry.';
export function mintWorkToken(): string { return randomBytes(32).toString('base64url'); }
export function hashWorkToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function assertWorkToken(hash: string | null, token?: string | null): void {
  if (!hash || !token) throw createValidationError(WORK_EXECUTION_REQUIRED);
  const actual = Buffer.from(hashWorkToken(token));
  const expected = Buffer.from(hash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw createValidationError(WORK_EXECUTION_REQUIRED);
}


/** Recheck authority after waiting for the work lock, and hold it until commit. */
export async function assertExecutionAuthority(
  tx: import('@prisma/client').Prisma.TransactionClient,
  actor: import('./work-service.js').WriteActor,
  teamId: string,
  scope: 'claim' | 'report',
): Promise<void> {
  if (actor.actorKind !== 'AGENT') return;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.actorId}::uuid FOR SHARE`;
  const user = actor.actorId ? await tx.user.findUnique({ where: { id: actor.actorId } }) : null;
  if (!user || user.deactivatedAt || user.actorKind !== 'AGENT') throw createValidationError('Execution actor is no longer active.');
  if (!actor.agentCredentialId) return; // Internal service callers have no HTTP credential.
  await tx.$queryRaw`SELECT id FROM "AgentCredential" WHERE id = ${actor.agentCredentialId}::uuid FOR SHARE`;
  const credential = await tx.agentCredential.findUnique({ where: { id: actor.agentCredentialId } });
  if (!credential || credential.userId !== user.id || credential.teamId !== teamId || credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt <= new Date()) || !credential.scopes.includes(scope)) {
    throw createValidationError('Execution credential no longer permits this action.');
  }
  await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${teamId}::uuid FOR SHARE`;
  const team = await tx.team.findUnique({ where: { id: teamId } });
  if (!team || team.archivedAt) throw createValidationError('Execution team is archived or unavailable.');
}
