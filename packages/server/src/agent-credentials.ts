import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';

export const AGENT_TOKEN_PREFIX = 'inv_agent_';

export function createAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function resolveAgentPrincipal(
  prisma: PrismaClient,
  token: string | null,
  now = new Date(),
): Promise<User | null> {
  if (!token?.startsWith(AGENT_TOKEN_PREFIX)) {
    return null;
  }

  const credential = await prisma.agentCredential.findUnique({
    where: { tokenHash: hashAgentToken(token) },
    include: { user: true },
  });

  if (
    !credential ||
    credential.user.actorKind !== 'AGENT' ||
    credential.revokedAt ||
    (credential.expiresAt && credential.expiresAt <= now)
  ) {
    return null;
  }

  return credential.user;
}
