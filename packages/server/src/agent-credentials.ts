import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';

import { AGENT_EMAIL_INVALID_MESSAGE } from './errors.js';
import { HANDLE_PATTERN, MAX_HANDLE_LENGTH, isValidHandle, normalizeHandle } from './mention-parser.js';

export const AGENT_TOKEN_PREFIX = 'inv_agent_';

// Linear-mapped scopes: `read` is always granted (like Linear's default read
// scope). Write capabilities are granted per credential at issuance time.
// `commit`/`reject`/`accept` stay human-only via actorKind gates, so they have
// no scope. `answer` (INV-560) is separate from `report`: reporting your own
// run is not the same right as speaking for an actor on a thread.
export const AGENT_SCOPES = ['read', 'propose', 'claim', 'report', 'update', 'link', 'answer'] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = AGENT_SCOPES;

// Just enough of a shape check to stop a display name landing in the email
// column: "primary agent" was stored as an actor's email once (INV-606), and
// from then on nothing could address that actor.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}



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
  /** The team the credential is bound to — the agent\'s access, in place of a membership (INV-592). */
  teamId: string | null;
  user: User;
}

export interface IssueAgentCredentialInput {
  agentCardUrl?: string | null;
  /** The human accountable for this agent. Required for new actors. */
  ownerId?: string | null;
  /** Who is minting the credential; recorded on it and in ActorAudit. Null from the operator CLI. */
  issuedById?: string | null;
  description?: string | null;
  email?: string | null;
  expiresAt?: Date | null;
  handle?: string | null;
  name: string;
  runtime?: string | null;
  scopes?: AgentScope[] | null | undefined;
  teamKey: string;
}

// `lastSeenAt` exists to answer "is this agent around", which needs
// minute-level accuracy, not millisecond. Writing on every authenticated call
// would put a row update in front of every request for no extra signal.
export const LAST_SEEN_REFRESH_MS = 60_000;

/** An owner is accountable for an actor, so it must be an active human. */
export async function assertHumanOwner(
  prisma: PrismaClient | import('@prisma/client').Prisma.TransactionClient,
  ownerId: string,
): Promise<void> {
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { actorKind: true, deactivatedAt: true },
  });
  if (!owner || owner.actorKind !== 'HUMAN' || owner.deactivatedAt) {
    throw new Error('Owner must be an active HUMAN actor.');
  }
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
  const requestedEmail = input.email?.trim().toLowerCase() || '';
  if (requestedEmail && !isPlausibleEmail(requestedEmail)) {
    throw new Error(AGENT_EMAIL_INVALID_MESSAGE);
  }
  const normalizedEmail = requestedEmail
    || `agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${randomBytes(4).toString('hex')}@agents.involute.local`;
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing && existing.actorKind !== 'AGENT') {
    throw new Error(`User ${normalizedEmail} already exists and is not an AGENT.`);
  }
  if (existing?.deactivatedAt) {
    throw new Error(`Agent ${existing.handle ?? existing.email} is deactivated; reactivate it before issuing a credential.`);
  }
  if (!existing && !input.ownerId) {
    throw new Error('A new agent needs a human owner (ownerId): who is accountable for it and where its escalations end.');
  }
  if (input.ownerId) {
    await assertHumanOwner(prisma, input.ownerId);
  }
  const user = existing ?? await prisma.user.create({
    data: {
      actorKind: 'AGENT',
      agentCardUrl: input.agentCardUrl ?? null,
      description: input.description ?? null,
      email: normalizedEmail,
      handle: await allocateAgentHandle(prisma, input.handle, name),
      name,
      ownerId: input.ownerId ?? null,
      runtime: input.runtime ?? null,
    },
  });
  if (!existing) {
    // The actor's birth certificate (INV-604): until this row existed the
    // question "who made this actor, and when" had no answer at all.
    await prisma.actorAudit.create({
      data: {
        action: 'created',
        after: { actorKind: 'AGENT', email: user.email, handle: user.handle, ownerId: user.ownerId },
        byActorId: input.issuedById ?? null,
        subjectId: user.id,
      },
    });
  }
  // Backfill: agents issued before INV-558 have no handle, so re-issuing a
  // credential is how they become mentionable. A no-op rename is not a clash.
  const requestedHandle = input.handle ? normalizeHandle(input.handle) : '';
  if (existing && requestedHandle !== existing.handle && (!existing.handle || requestedHandle)) {
    const handle = await allocateAgentHandle(prisma, input.handle, name);
    await prisma.user.update({ where: { id: existing.id }, data: { handle } });
    existing.handle = handle;
  }
  // Re-issuing a credential is how an existing actor updates its profile.
  const profileUpdates: { agentCardUrl?: string; description?: string; runtime?: string } = {};
  if (input.runtime) profileUpdates.runtime = input.runtime;
  if (input.description) profileUpdates.description = input.description;
  if (input.agentCardUrl) profileUpdates.agentCardUrl = input.agentCardUrl;
  if (existing && Object.keys(profileUpdates).length > 0) {
    await prisma.user.update({ where: { id: existing.id }, data: profileUpdates });
  }

  // An agent is not a team member. It never was one in any sense that
  // mattered — it has no role, it is not on the roster — but until INV-592
  // this is where it was upserted as an EDITOR so that the membership-based
  // write check would let it through. The credential's teamId is the binding
  // now, and access-control reads it from the request.
  const token = createAgentToken();
  const credential = await prisma.agentCredential.create({
    data: {
      expiresAt: input.expiresAt ?? null,
      issuedById: input.issuedById ?? null,
      name,
      scopes: input.scopes ?? [...DEFAULT_AGENT_SCOPES],
      teamId: team.id,
      tokenHash: hashAgentToken(token),
      userId: user.id,
    },
    select: { createdAt: true, expiresAt: true, id: true, name: true, scopes: true, teamId: true, userId: true },
  });
  await prisma.actorAudit.create({
    data: {
      action: 'credential-issued',
      after: {
        credentialId: credential.id,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
        name: credential.name,
        scopes: credential.scopes,
        teamKey: team.key,
      },
      byActorId: input.issuedById ?? null,
      subjectId: user.id,
    },
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
    // A deactivated actor keeps its id and its history, but it is no longer a
    // principal: nothing may act as it (INV-586).
    credential.user.deactivatedAt ||
    credential.revokedAt ||
    (credential.expiresAt && credential.expiresAt <= now)
  ) {
    return null;
  }

  void touchLastSeen(prisma, credential.user, now);

  return { scopes: credential.scopes, teamId: credential.teamId, user: credential.user };
}

/**
 * Records that the actor is around. Deliberately fire-and-forget and throttled:
 * a stale-by-a-minute presence is fine, a failed presence write blocking an
 * authenticated request is not.
 */
async function touchLastSeen(
  prisma: PrismaClient,
  user: User,
  now: Date,
): Promise<void> {
  if (user.lastSeenAt && now.getTime() - user.lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS) {
    return;
  }

  try {
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: now } });
    user.lastSeenAt = now;
  } catch {
    // Presence is a convenience signal; never fail a request over it.
  }
}
