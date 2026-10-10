import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';
import { Kind, type DocumentNode, type SelectionNode, type ValueNode } from 'graphql';

import { createValidationError } from './errors.js';

/**
 * Tokens for the Involute Capture browser extension (INV-1145).
 *
 * A person connects the extension from /extension/connect; the token acts as
 * that person on /graphql, but only for what filing a bug from a page needs:
 * who they are, their teams, where a bug can go, similar bugs, uploading the
 * screenshot and the report itself. Everything else is refused. It never
 * works on /mcp, never reuses the browser session, and lives 90 days.
 */
export const EXTENSION_TOKEN_PREFIX = 'inv_ext_';
export const EXTENSION_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_TOKENS_PER_PERSON = 10;

export const EXTENSION_TOKEN_REFUSED_MESSAGE =
  'An extension token can only report bugs, upload their screenshots and read where a bug can go. Do this in Involute instead.';
export const EXTENSION_TOKEN_HUMAN_ONLY_MESSAGE = 'Only a signed-in person can connect the extension.';

/** Root fields an extension token may run, and for `issues` only the kinds a bug can be placed under. */
const ALLOWED_QUERY_FIELDS = new Set(['viewer', 'teams', 'similarBugs', 'projectForOrigin', 'issues', '__typename']);
const ALLOWED_MUTATION_FIELDS = new Set(['bugReport', 'fileUpload']);
const PLACEMENT_KINDS = new Set(['PROJECT', 'MILESTONE', 'EPIC']);
/**
 * Every field the token may select, at any depth. Relations that would reach
 * other work (children, parent, comments, description, members…) are not in
 * it, so a project or the reported bug cannot be used as a door to the rest.
 */
const SAFE_FIELDS = new Set([
  '__typename',
  'actorKind',
  'attachment',
  'createdAt',
  'email',
  'endCursor',
  'filename',
  'globalRole',
  'hasNextPage',
  'id',
  'identifier',
  'issue',
  'key',
  'kind',
  'message',
  'mimeType',
  'name',
  'nodes',
  'pageInfo',
  'priority',
  'repository',
  'severity',
  'size',
  'state',
  'success',
  'team',
  'title',
  'type',
  'url',
  'webOrigins',
]);

export function hashExtensionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createExtensionToken(
  prisma: PrismaClient,
  viewer: Pick<User, 'actorKind' | 'id'>,
  input: { name?: string | null },
  now = new Date(),
) {
  if (viewer.actorKind !== 'HUMAN') throw createValidationError(EXTENSION_TOKEN_HUMAN_ONLY_MESSAGE);
  const active = await prisma.extensionToken.count({ where: { expiresAt: { gt: now }, revokedAt: null, userId: viewer.id } });
  if (active >= MAX_TOKENS_PER_PERSON) {
    throw createValidationError(`You already have ${MAX_TOKENS_PER_PERSON} connected extensions. Revoke one in Settings → Extensions first.`);
  }
  const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const record = await prisma.extensionToken.create({
    data: {
      expiresAt: new Date(now.getTime() + EXTENSION_TOKEN_TTL_MS),
      name: input.name?.trim().slice(0, 80) || 'Involute Capture',
      tokenHash: hashExtensionToken(token),
      userId: viewer.id,
    },
  });
  // The token itself is returned once and never stored.
  return { record, token };
}

export function listExtensionTokens(prisma: PrismaClient, viewer: Pick<User, 'id'>) {
  return prisma.extensionToken.findMany({ orderBy: { createdAt: 'desc' }, where: { userId: viewer.id } });
}

/** Revoke one of the viewer's own tokens; someone else's is reported as not found. */
export async function revokeExtensionToken(prisma: PrismaClient, viewer: Pick<User, 'id'>, id: string, now = new Date()) {
  const token = await prisma.extensionToken.findFirst({ where: { id, userId: viewer.id } });
  if (!token) throw createValidationError('That extension connection was not found.');
  if (token.revokedAt) return token;
  return prisma.extensionToken.update({ data: { revokedAt: now }, where: { id: token.id } });
}

/** The person behind a live token, or null: unknown, revoked, expired, or no longer an active person. */
export async function resolveExtensionPrincipal(prisma: PrismaClient, token: string | null, now = new Date()) {
  if (!token?.startsWith(EXTENSION_TOKEN_PREFIX)) return null;
  const record = await prisma.extensionToken.findUnique({ include: { user: true }, where: { tokenHash: hashExtensionToken(token) } });
  if (!record || record.revokedAt || record.expiresAt <= now) return null;
  if (record.user.actorKind !== 'HUMAN' || record.user.deactivatedAt) return null;
  // Throttled like last-seen: a minute of staleness is fine, a write per request is not.
  if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() > 60_000) {
    void prisma.extensionToken.update({ data: { lastUsedAt: now }, where: { id: record.id } }).catch(() => undefined);
  }
  return { tokenId: record.id, user: record.user };
}

/**
 * Whether an operation stays inside what an extension token may do. Checked
 * on the parsed document before execution: every root field must be allowed,
 * fragments on the root are refused, and `issues` must ask for a placement
 * kind (PROJECT, MILESTONE or EPIC) so ordinary work cannot be read.
 */
export function extensionOperationAllowed(
  document: DocumentNode,
  operationName: string | null | undefined,
  variables: Record<string, unknown> | null | undefined,
): boolean {
  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  const operation = operationName
    ? operations.find((definition) => definition.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!operation) return false;
  if (operation.operation === 'subscription') return false;
  const allowed = operation.operation === 'mutation' ? ALLOWED_MUTATION_FIELDS : ALLOWED_QUERY_FIELDS;
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) return false;
    const field = selection.name.value;
    if (!allowed.has(field)) return false;
    if (field === 'issues') {
      const filter = selection.arguments?.find((argument) => argument.name.value === 'filter')?.value;
      const kind = filter ? readObjectField(filter, 'kind', variables) : undefined;
      if (typeof kind !== 'string' || !PLACEMENT_KINDS.has(kind)) return false;
    }
    if (selection.selectionSet && !onlySafeFields(selection.selectionSet.selections)) return false;
  }
  return true;
}

function onlySafeFields(selections: readonly SelectionNode[]): boolean {
  for (const selection of selections) {
    // Fragments could hide a field from this check; the extension does not need them.
    if (selection.kind !== Kind.FIELD) return false;
    if (!SAFE_FIELDS.has(selection.name.value)) return false;
    if (selection.selectionSet && !onlySafeFields(selection.selectionSet.selections)) return false;
  }
  return true;
}

function readObjectField(value: ValueNode, key: string, variables: Record<string, unknown> | null | undefined): unknown {
  if (value.kind === Kind.VARIABLE) {
    const resolved = variables?.[value.name.value];
    return resolved && typeof resolved === 'object' ? (resolved as Record<string, unknown>)[key] : undefined;
  }
  if (value.kind !== Kind.OBJECT) return undefined;
  const field = value.fields.find((entry) => entry.name.value === key)?.value;
  if (!field) return undefined;
  if (field.kind === Kind.ENUM || field.kind === Kind.STRING) return field.value;
  if (field.kind === Kind.VARIABLE) return variables?.[field.name.value];
  return undefined;
}
