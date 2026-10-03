import type { GraphQLContext } from './auth.js';
import { buildReadableIssueWhere } from './access-control.js';
import { resolveProjectScope, type ProjectScopeInput } from './project-scope.js';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const WORK_PROTOCOL_VERSION = 1;

export function serverBuild() {
  const sha = process.env.INVOLUTE_BUILD_SHA;
  return {
    serverVersion: process.env.INVOLUTE_SERVER_VERSION || '0.0.0',
    buildSha: sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null,
  };
}

export async function protocolInfo(context: GraphQLContext, input: ProjectScopeInput, readonly: boolean) {
  const scope = await resolveProjectScope(context.prisma, input, buildReadableIssueWhere(context));
  const root = scope?.rootId ? await context.prisma.issue.findUnique({
    where: { id: scope.rootId }, select: { id: true, identifier: true, repository: true, alias: true },
  }) : null;
  let endpointOrigin: string | null = null;
  try { endpointOrigin = new URL(process.env.APP_ORIGIN ?? '').origin; } catch { /* Unknown is explicit. */ }
  return {
    schemaVersion: 1,
    protocolVersion: WORK_PROTOCOL_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    ...serverBuild(),
    endpointOrigin,
    supportedCapabilities: ['cursor-pagination', 'execution-claims-v1', 'action-catalog-v1', 'external-executor-v1', 'revision-conflict-v1'],
    projectBinding: scope ? { rootId: root?.id ?? null, identifier: root?.identifier ?? null, repository: scope.repository, alias: root?.alias ?? null, source: scope.source } : null,
    authScopeSummary: { mode: context.authMode, actorKind: context.viewer?.actorKind ?? null,
      scopes: context.authMode === 'agent-token' ? context.agentScopes ?? [] : null, readonly },
  };
}
