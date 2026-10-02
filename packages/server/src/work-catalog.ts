import type { GraphQLContext } from './auth.js';
import { buildReadableTeamWhere, buildVisibleUsersWhere } from './access-control.js';
import { createValidationError } from './errors.js';

export const CATALOG_KINDS = ['teams', 'states', 'labels', 'actors', 'cycles'] as const;
export async function readWorkCatalog(context: GraphQLContext, kind: string, first = 50, after?: string | null, teamId?: string | null) {
  if (!(CATALOG_KINDS as readonly string[]).includes(kind) || !Number.isInteger(first) || first < 1 || first > 200) throw createValidationError('Choose a catalog kind and first between 1 and 200.');
  let boundary: string | undefined;
  if (after) {
    try {
      const value = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
      if (value.kind !== kind || value.teamId !== (teamId ?? null) || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error();
      boundary = value.id;
    } catch { throw createValidationError('Invalid catalog cursor.'); }
  }
  const id = boundary ? { gt: boundary } : undefined;
  const team = { AND: [buildReadableTeamWhere(context) ?? {}, ...(teamId ? [{ id: teamId }] : [])] };
  const options = { take: first + 1, orderBy: { id: 'asc' as const } };
  const window = id ? { id } : {};
  let rows: Array<{ id: string }>;
  switch (kind) {
    case 'teams': rows = await context.prisma.team.findMany({ ...options, where: { ...window, ...team }, select: { id: true, key: true, name: true, archivedAt: true } }); break;
    case 'states': rows = await context.prisma.workflowState.findMany({ ...options, where: { ...window, team }, select: { id: true, teamId: true, name: true, type: true, position: true } }); break;
    case 'cycles': rows = await context.prisma.cycle.findMany({ ...options, where: { ...window, team } }); break;
    case 'labels': rows = await context.prisma.issueLabel.findMany({ ...options, where: window }); break;
    case 'actors': rows = await context.prisma.user.findMany({ ...options, where: { AND: [buildVisibleUsersWhere(context) ?? {}, window, ...(teamId ? [{ OR: [{ memberships: { some: { teamId } } }, { agentCredentials: { some: { teamId, revokedAt: null } } }] }] : [])] }, select: { id: true, name: true, handle: true, actorKind: true, deactivatedAt: true } }); break;
    default: throw createValidationError('Unknown catalog.');
  }
  const nodes = rows.slice(0, first);
  const last = nodes.at(-1);
  return { kind, nodes, pageInfo: { hasNextPage: rows.length > first, endCursor: last ? Buffer.from(JSON.stringify({ kind, teamId: teamId ?? null, id: last.id })).toString('base64url') : null } };
}
