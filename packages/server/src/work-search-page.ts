import { createHash } from 'node:crypto';
import type { GraphQLContext } from './auth.js';
import { buildReadableIssueWhere } from './access-control.js';
import { searchWork, listReadyWork, type ListReadyWorkInput, type SearchWorkInput } from './context-service.js';
import { createValidationError } from './errors.js';

interface CursorSession { actorKey: string; queryHash: string; seenIds: string[] }

async function openCursor(context: GraphQLContext, kind: string, query: unknown, after?: string | null): Promise<CursorSession> {
  const actorKey = `${context.authMode}:${context.viewer?.id ?? 'system'}:${context.agentCredentialId ?? ''}`;
  const queryHash = createHash('sha256').update(JSON.stringify({ kind, query })).digest('hex');
  if (!after) return { actorKey, queryHash, seenIds: [] };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)) throw createValidationError('Invalid continuation cursor.');
  const cursor = await context.prisma.workSearchCursor.findUnique({ where: { id: after } });
  if (!cursor || cursor.actorKey !== actorKey || cursor.queryHash !== queryHash || cursor.expiresAt <= new Date()) throw createValidationError('Cursor expired or belongs to another query or principal; start again.');
  return { actorKey, queryHash, seenIds: cursor.seenIds };
}

async function saveCursor(context: GraphQLContext, session: CursorSession, nodes: Array<{ id: string }>, hasNextPage: boolean) {
  if (!hasNextPage) return null;
  await context.prisma.workSearchCursor.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const { actorKey, queryHash, seenIds } = session;
  return (await context.prisma.workSearchCursor.create({ data: {
    actorKey, queryHash, seenIds: [...seenIds, ...nodes.map((node) => node.id)],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } })).id;
}

/** Live ranked pages. Every page reruns the shared search over remaining readable items. */
export async function searchWorkPage(context: GraphQLContext, input: SearchWorkInput, after?: string | null) {
  const { first: requested, ...query } = input;
  const first = requested ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > 100) throw createValidationError('Paged search first must be between 1 and 100.');
  const session = await openCursor(context, 'search', query, after);
  const scope = buildReadableIssueWhere(context) ?? {};
  const remaining = (ids: string[]) => ({ AND: [scope, { id: { notIn: ids } }] });
  const nodes = await searchWork(context.prisma, { ...input, first, excludeIds: session.seenIds }, remaining(session.seenIds), context.semanticIndex);
  const nextSeen = [...session.seenIds, ...nodes.map((node) => node.id)];
  const probe = nodes.length === first ? await searchWork(context.prisma, { ...input, first: 1, excludeIds: nextSeen }, remaining(nextSeen), context.semanticIndex) : [];
  const hasNextPage = probe.length > 0;
  const endCursor = await saveCursor(context, session, nodes, hasNextPage);
  return { nodes, pageInfo: { hasNextPage, endCursor }, consistency: 'live; previously returned IDs are excluded, permissions and relevance are rechecked each page; cursor expires after one hour' };
}

/** Ready retains its existing nodes/hasNextPage fields and adds a usable continuation. */
export async function readyWorkPage(context: GraphQLContext, input: ListReadyWorkInput, after?: string | null) {
  const { first, ...query } = input;
  const session = await openCursor(context, 'ready', query, after);
  const result = await listReadyWork(context.prisma, input, { AND: [buildReadableIssueWhere(context) ?? {}, { id: { notIn: session.seenIds } }] });
  const endCursor = await saveCursor(context, session, result.nodes, result.hasNextPage);
  return { ...result, endCursor, pageInfo: { hasNextPage: result.hasNextPage, endCursor } };
}
