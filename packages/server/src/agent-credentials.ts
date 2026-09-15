import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';

import { HANDLE_PATTERN, MAX_HANDLE_LENGTH, isValidHandle, normalizeHandle } from './mention-parser.js';

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
  return parseAgentScopeList(value.split(','));
}

// Explicit scope lists (e.g. GraphQL `scopes: []`) never inherit the default:
// an empty list means read-only. Only omitted scopes get the full default.
export function parseAgentScopeList(scopes: readonly string[]): AgentScope[] {
  const normalized = scopes.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const unknown = normalized.filter((scope) => !(AGENT_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    throw new Error(`Unknown agent scope(s): ${unknown.join(', ')}. Expected one of: ${AGENT_SCOPES.join(', ')}.`);
  }
  if (!normalized.includes('read')) {
    normalized.unshift('read');
  }
  return [...new Set(normalized)] as AgentScope[];
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
  handle?: string | null;
  name: string;
  scopes?: AgentScope[] | null | undefined;
  teamKey: string;
}

// An agent that cannot be spelled cannot be mentioned (INV-558), so issuance
// always lands a handle. Explicit `--handle` wins; otherwise the name is
// slugified, with a numeric suffix on collision.
export async function allocateAgentHandle(
  prisma: PrismaClient | import('@prisma/client').Prisma.TransactionClient,
  requested: string | null | undefined,
  fallbackName: string,
): Promise<string> {
  const explicit = requested ? normalizeHandle(requested) : '';

  if (explicit) {
    if (!isValidHandle(explicit)) {
      throw new Error(`Invalid agent handle: ${explicit}. Expected ${HANDLE_PATTERN}.`);
    }
    const taken = await prisma.user.findUnique({ where: { handle: explicit } });
    if (taken) {
      throw new Error(`Agent handle already taken: ${explicit}.`);
    }
    return explicit;
  }

  const base = normalizeHandle(fallbackName).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, MAX_HANDLE_LENGTH) || 'agent';

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0
      ? base
      : `${base.slice(0, MAX_HANDLE_LENGTH - String(suffix).length - 1)}-${suffix}`;
    if (!isValidHandle(candidate)) {
      continue;
    }
    const taken = await prisma.user.findUnique({ where: { handle: candidate } });
    if (!taken) {
      return candidate;
    }
  }

  throw new Error(`Could not allocate a free handle for agent "${fallbackName}".`);
}

export interface IssuedAgentCredential {
  credential: {
    createdAt: Date;
    expiresAt: Date | null;
    id: string;
    name: string;
    scopes: string[];
    teamId: string | null;
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
    data: {
      actorKind: 'AGENT',
      email: normalizedEmail,
      handle: await allocateAgentHandle(prisma, input.handle, name),
      name,
    },
  });
  // Backfill: agents issued before INV-558 have no handle, so re-issuing a
  // credential is how they become mentionable. A no-op rename is not a clash.
  const requestedHandle = input.handle ? normalizeHandle(input.handle) : '';
  if (existing && requestedHandle !== existing.handle && (!existing.handle || requestedHandle)) {
    const handle = await allocateAgentHandle(prisma, input.handle, name);
    await prisma.user.update({ where: { id: existing.id }, data: { handle } });
    existing.handle = handle;
  }
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
      teamId: team.id,
      tokenHash: hashAgentToken(token),
      userId: user.id,
    },
    select: { createdAt: true, expiresAt: true, id: true, name: true, scopes: true, teamId: true, userId: true },
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
