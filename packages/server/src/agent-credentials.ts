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

export interface IssueAgentCredentialInput {
  email?: string | null;
  expiresAt?: Date | null;
  name: string;
  scopes?: AgentScope[] | null;
  teamKey: string;
}

export interface IssuedAgentCredential {
  credential: {
    createdAt: Date;
    expiresAt: Date | null;
    id: string;
    name: string;
    scopes: string[];
    userId: string;
  };
  token: string;
}

// Owner self-service issuance (also used by the operator CLI script): one
// credential per agent user, EDITOR on exactly the selected team, plaintext
// token returned once. Mirrors Linear's "OAuth app + user consent" pairing at
// a team level: a human with manage rights approves scopes, the agent gets a
// confined token.
export async function issueAgentCredential(
  prisma: PrismaClient | import('@prisma/client').Prisma.TransactionClient,
  input: IssueAgentCredentialInput,
): Promise<IssuedAgentCredential> {
  const team = await prisma.team.findUnique({ where: { key: input.teamKey } })
    ?? await prisma.team.findFirst({ where: { id: input.teamKey } }).catch(() => null);
  if (!team) {
    throw new Error(`Team not found: ${input.teamKey}.`);
  }
  const name = input.name.trim();
  if (!name) {
    throw new Error('Agent name is required.');
  }
  const normalizedEmail = (input.email?.trim().toLowerCase())
    || `agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${randomBytes(4).toString('hex')}@agents.involute.local`;
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing && existing.actorKind !== 'AGENT') {
    throw new Error(`User ${normalizedEmail} already exists and is not an AGENT.`);
  }
  const user = existing ?? await prisma.user.create({
    data: { actorKind: 'AGENT', email: normalizedEmail, name },
  });
  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId: team.id, userId: user.id } },
    create: { role: 'EDITOR', teamId: team.id, userId: user.id },
    update: { role: 'EDITOR' },
  });
  const token = createAgentToken();
  const credential = await prisma.agentCredential.create({
    data: {
      expiresAt: input.expiresAt ?? null,
      name,
      scopes: input.scopes ?? [...DEFAULT_AGENT_SCOPES],
      tokenHash: hashAgentToken(token),
      userId: user.id,
    },
    select: { createdAt: true, expiresAt: true, id: true, name: true, scopes: true, userId: true },
  });
  return { credential, token };
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
