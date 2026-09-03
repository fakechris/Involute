import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';

export const AGENT_TOKEN_PREFIX = 'inv_agent_';

// Linear-mapped scopes: `read` is always granted (like Linear's default read
// scope). Write capabilities are granted per credential at issuance time.
// `commit`/`reject`/`accept` stay human-only via actorKind gates, so they have
// no scope.
export const AGENT_SCOPES = ['read', 'propose', 'claim', 'report', 'update', 'link'] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = AGENT_SCOPES;

export function parseAgentScopes(value: string | null | undefined): AgentScope[] {
  if (!value || value.trim() === '') {
    return [...DEFAULT_AGENT_SCOPES];
  }
  const scopes = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const unknown = scopes.filter((scope) => !(AGENT_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    throw new Error(`Unknown agent scope(s): ${unknown.join(', ')}. Expected one of: ${AGENT_SCOPES.join(', ')}.`);
  }
  if (!scopes.includes('read')) {
    scopes.unshift('read');
  }
  return [...new Set(scopes)] as AgentScope[];
}

export function createAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AgentPrincipal {
  scopes: string[];
  user: User;
}

export async function resolveAgentPrincipal(
  prisma: PrismaClient,
  token: string | null,
  now = new Date(),
): Promise<AgentPrincipal | null> {
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

  return { scopes: credential.scopes, user: credential.user };
}
