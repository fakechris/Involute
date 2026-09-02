import type { PrismaClient, WorkLinkType } from '@prisma/client';

import {
  assertCanReadTeam,
  assertCanWriteIssue,
  assertCanWriteTeam,
  buildReadableIssueWhere,
} from './access-control.js';
import type { GraphQLContext } from './auth.js';
import { claimWork, commitWork, proposeWork } from './claim-service.js';
import {
  findWorkByIdOrIdentifier,
  getWorkContext,
  listReadyWork,
  searchWork,
} from './context-service.js';
import { ISSUE_NOT_FOUND_MESSAGE, TEAM_NOT_FOUND_MESSAGE, createNotFoundError } from './errors.js';
import { updateIssue } from './issue-service.js';
import { createWorkLink } from './link-service.js';
import { attachEvidence, reportRun } from './run-service.js';
import { writeActorFromViewer } from './work-service.js';

export type McpToolName =
  | 'work_search'
  | 'work_get_context'
  | 'work_list_ready'
  | 'work_propose'
  | 'work_commit'
  | 'work_update'
  | 'work_link'
  | 'work_claim'
  | 'run_report'
  | 'evidence_attach';

export const READ_ONLY_MCP_TOOLS: readonly McpToolName[] = [
  'work_search',
  'work_get_context',
  'work_list_ready',
];

export const WRITE_MCP_TOOLS: readonly McpToolName[] = [
  'work_propose',
  'work_commit',
  'work_update',
  'work_link',
  'work_claim',
  'run_report',
  'evidence_attach',
];

const WORK_LINK_TYPES: readonly WorkLinkType[] = [
  'CONTAINS',
  'BLOCKS',
  'DERIVED_FROM',
  'DISCOVERED_DURING',
  'RELATED_TO',
  'DUPLICATE_OF',
];

interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpToolDefinition {
  description: string;
  inputSchema: JsonSchema;
  name: McpToolName;
}

export function listMcpTools(readonly: boolean): McpToolDefinition[] {
  const tools = [...MCP_TOOL_DEFINITIONS];
  return readonly ? tools.filter((tool) => (READ_ONLY_MCP_TOOLS as readonly string[]).includes(tool.name)) : tools;
}

export async function callMcpTool(
  context: GraphQLContext,
  name: string,
  args: Record<string, unknown>,
  readonly: boolean,
): Promise<unknown> {
  if (readonly && !(READ_ONLY_MCP_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Tool "${name}" is not available on the read-only MCP endpoint.`);
  }

  switch (name as McpToolName) {
    case 'work_search': {
      const searchInput: Parameters<typeof searchWork>[1] = {};
      assignOptional(searchInput, 'first', optionalNumber(args.first));
      assignOptional(searchInput, 'query', optionalString(args.query));
      assignOptional(searchInput, 'teamKey', optionalString(args.team_key));
      const status = optionalString(args.commitment_status);
      if (status === 'CANDIDATE' || status === 'COMMITTED' || status === 'REJECTED') {
        searchInput.commitmentStatus = status;
      }
      return searchWork(context.prisma, searchInput, buildReadableIssueWhere(context));
    }
    case 'work_get_context': {
      const id = requiredString(args.id, 'id');
      const work = await findWorkByIdOrIdentifier(context.prisma, id);
      if (!work) {
        throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
      }
      await assertCanReadTeam(context.prisma, context, work.teamId);
      return getWorkContext(context.prisma, work.id);
    }
    case 'work_list_ready': {
      const readyInput: Parameters<typeof listReadyWork>[1] = {};
      assignOptional(readyInput, 'first', optionalNumber(args.first));
      assignOptional(readyInput, 'priority', optionalNumber(args.priority));
      assignOptional(readyInput, 'projectId', optionalString(args.project_id));
      assignOptional(readyInput, 'repository', optionalString(args.repository));
      assignOptional(readyInput, 'teamKey', optionalString(args.team_key));
      return listReadyWork(context.prisma, readyInput, buildReadableIssueWhere(context));
    }
    case 'work_propose': {
      const teamId = await resolveTeamId(context.prisma, requiredString(args.team, 'team'));
      await assertCanWriteTeam(context.prisma, context, teamId);
      const proposeInput: Parameters<typeof proposeWork>[1] = {
        teamId,
        title: requiredString(args.title, 'title'),
      };
      assignOptional(proposeInput, 'acceptance', optionalString(args.acceptance));
      assignOptional(proposeInput, 'constraints', optionalString(args.constraints));
      assignOptional(proposeInput, 'description', optionalString(args.description));
      assignOptional(proposeInput, 'idempotencyKey', optionalString(args.idempotency_key));
      assignOptional(proposeInput, 'outcome', optionalString(args.outcome));
      assignOptional(proposeInput, 'scope', optionalString(args.scope));
      assignOptional(proposeInput, 'relatedWorkId', optionalString(args.related_work_id));
      assignOptional(proposeInput, 'repository', optionalString(args.repository));
      assignOptional(proposeInput, 'verification', optionalString(args.verification));
      const kind = optionalString(args.kind);
      if (kind === 'ISSUE' || kind === 'PROJECT' || kind === 'MILESTONE' || kind === 'DECISION' || kind === 'EPIC') {
        proposeInput.kind = kind;
      }
      const relatedType = optionalString(args.related_work_type);
      if (relatedType) proposeInput.relatedWorkType = parseWorkLinkType(relatedType, 'related_work_type');
      return proposeWork(context.prisma, proposeInput, writeActorFromViewer(context.viewer, 'mcp'));
    }
    case 'work_commit': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const commitInput: Parameters<typeof commitWork>[2] = {
        expectedRevision: requiredNumber(args.expected_revision, 'expected_revision'),
      };
      assignOptional(commitInput, 'acceptance', optionalString(args.acceptance));
      assignOptional(commitInput, 'assigneeId', optionalString(args.assignee_id));
      assignOptional(commitInput, 'constraints', optionalString(args.constraints));
      assignOptional(commitInput, 'outcome', optionalString(args.outcome));
      assignOptional(commitInput, 'scope', optionalString(args.scope));
      assignOptional(commitInput, 'verification', optionalString(args.verification));
      return commitWork(
        context.prisma,
        work.id,
        commitInput,
        writeActorFromViewer(context.viewer, 'mcp'),
      );
    }
    case 'work_update': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const updateInput: Parameters<typeof updateIssue>[2] = {
        expectedRevision: requiredNumber(args.expected_revision, 'expected_revision'),
      };
      assignOptional(updateInput, 'acceptance', optionalString(args.acceptance));
      assignOptional(updateInput, 'constraints', optionalString(args.constraints));
      assignOptional(updateInput, 'description', optionalString(args.description));
      assignOptional(updateInput, 'outcome', optionalString(args.outcome));
      assignOptional(updateInput, 'priority', optionalNumber(args.priority));
      assignOptional(updateInput, 'repository', optionalString(args.repository));
      assignOptional(updateInput, 'scope', optionalString(args.scope));
      assignOptional(updateInput, 'title', optionalString(args.title));
      assignOptional(updateInput, 'verification', optionalString(args.verification));
      return updateIssue(
        context.prisma,
        work.id,
        updateInput,
        writeActorFromViewer(context.viewer, 'mcp'),
      );
    }
    case 'work_link': {
      const from = await requireWork(context.prisma, requiredString(args.from_id, 'from_id'));
      const to = await requireWork(context.prisma, requiredString(args.to_id, 'to_id'));
      await assertCanWriteIssue(context.prisma, context, from.id);
      return createWorkLink(context.prisma, {
        actor: writeActorFromViewer(context.viewer, 'mcp'),
        fromId: from.id,
        toId: to.id,
        type: requiredString(args.type, 'type') as WorkLinkType,
      });
    }
    case 'work_claim': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const claimInput: Parameters<typeof claimWork>[2] = {};
      assignOptional(claimInput, 'idempotencyKey', optionalString(args.idempotency_key));
      assignOptional(claimInput, 'leaseSeconds', optionalNumber(args.lease_seconds));
      return claimWork(
        context.prisma,
        work.id,
        claimInput,
        writeActorFromViewer(context.viewer, 'mcp'),
      );
    }
    case 'run_report': {
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const runInput: Parameters<typeof reportRun>[1] = { workId: work.id };
      assignOptional(runInput, 'runId', optionalString(args.run_id));
      assignOptional(runInput, 'status', optionalString(args.status));
      assignOptional(runInput, 'phase', optionalString(args.phase));
      assignOptional(runInput, 'summary', optionalString(args.summary));
      assignOptional(runInput, 'externalUrl', optionalString(args.external_url));
      if (args.decision_requested === true) {
        runInput.decisionRequested = true;
      }
      return reportRun(context.prisma, runInput, writeActorFromViewer(context.viewer, 'mcp'));
    }
    case 'evidence_attach': {
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const evidenceInput: Parameters<typeof attachEvidence>[1] = {
        kind: requiredString(args.kind, 'kind'),
        runId: requiredString(args.run_id, 'run_id'),
        url: requiredString(args.url, 'url'),
        workId: work.id,
      };
      assignOptional(evidenceInput, 'summary', optionalString(args.summary));
      return attachEvidence(
        context.prisma,
        evidenceInput,
        writeActorFromViewer(context.viewer, 'mcp'),
      );
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'work_search',
    description: 'Search Involute work by identifier, title, or description. Includes candidates and committed work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        team_key: { type: 'string' },
        commitment_status: { type: 'string', enum: ['CANDIDATE', 'COMMITTED', 'REJECTED'] },
        first: { type: 'integer' },
      },
    },
  },
  {
    name: 'work_get_context',
    description: 'Return the full context bundle for a work id or identifier: contract, ancestors, blockers, claim, audits.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue identifier or UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'work_list_ready',
    description: 'List committed, unblocked, unclaimed work in urgency order.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string' },
        team_key: { type: 'string' },
        project_id: { type: 'string' },
        priority: { type: 'integer' },
        first: { type: 'integer' },
      },
    },
  },
  {
    name: 'work_propose',
    description: 'Create candidate work. Does not enter the ready queue. Search for duplicates first.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key or UUID' },
        title: { type: 'string' },
        description: { type: 'string' },
        outcome: { type: 'string' },
        scope: { type: 'string' },
        constraints: { type: 'string' },
        acceptance: { type: 'string' },
        verification: { type: 'string' },
        kind: { type: 'string', enum: ['ISSUE', 'PROJECT', 'MILESTONE', 'DECISION', 'EPIC'] },
        related_work_id: { type: 'string' },
        related_work_type: { type: 'string', enum: ['CONTAINS', 'BLOCKS', 'DERIVED_FROM', 'DISCOVERED_DURING', 'RELATED_TO', 'DUPLICATE_OF'] },
        repository: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['team', 'title'],
    },
  },
  {
    name: 'work_commit',
    description: 'Promote candidate work to a committed contract. Humans only. Requires acceptance and a human owner.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_revision: { type: 'integer' },
        acceptance: { type: 'string' },
        assignee_id: { type: 'string' },
        outcome: { type: 'string' },
        scope: { type: 'string' },
        constraints: { type: 'string' },
        verification: { type: 'string' },
      },
      required: ['id', 'expected_revision'],
    },
  },
  {
    name: 'work_update',
    description: 'Update work contract fields. Requires expected_revision. Does not mark work Done.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_revision: { type: 'integer' },
        title: { type: 'string' },
        description: { type: 'string' },
        outcome: { type: 'string' },
        scope: { type: 'string' },
        constraints: { type: 'string' },
        acceptance: { type: 'string' },
        verification: { type: 'string' },
        repository: { type: 'string' },
        priority: { type: 'integer' },
      },
      required: ['id', 'expected_revision'],
    },
  },
  {
    name: 'work_link',
    description: 'Create a typed work link: CONTAINS, BLOCKS, DERIVED_FROM, DISCOVERED_DURING, RELATED_TO, DUPLICATE_OF.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' },
        to_id: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['from_id', 'to_id', 'type'],
    },
  },
  {
    name: 'work_claim',
    description: 'Atomically claim committed work for the current actor. Does not change the human assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        lease_seconds: { type: 'integer' },
        idempotency_key: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'run_report',
    description: 'Report a high-level run phase, block, or completion. Completed runs may move work to In Review, never Done.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        run_id: { type: 'string', description: 'Existing RUN-N or UUID; omit to start a new run' },
        status: { type: 'string', enum: ['queued', 'running', 'blocked', 'completed', 'failed'] },
        phase: { type: 'string' },
        summary: { type: 'string' },
        external_url: { type: 'string' },
        decision_requested: { type: 'boolean' },
      },
      required: ['work_id'],
    },
  },
  {
    name: 'evidence_attach',
    description: 'Attach a PR, test report, log, screenshot, or artifact to an existing run.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        run_id: { type: 'string' },
        kind: { type: 'string', enum: ['pr', 'test', 'log', 'screenshot', 'artifact', 'decision'] },
        url: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['work_id', 'run_id', 'kind', 'url'],
    },
  },
];

async function requireWork(prisma: PrismaClient, id: string) {
  const work = await findWorkByIdOrIdentifier(prisma, id);
  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }
  return work;
}

async function resolveTeamId(prisma: PrismaClient, teamIdOrKey: string): Promise<string> {
  try {
    const byId = await prisma.team.findUnique({ where: { id: teamIdOrKey } });
    if (byId) {
      return byId.id;
    }
  } catch {
    // Non-UUID values fall through to key lookup.
  }

  const byKey = await prisma.team.findUnique({ where: { key: teamIdOrKey } });
  if (!byKey) {
    throw createNotFoundError(TEAM_NOT_FOUND_MESSAGE);
  }
  return byKey.id;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required string argument "${name}".`);
  }
  return value;
}

function parseWorkLinkType(value: string, name: string): WorkLinkType {
  if ((WORK_LINK_TYPES as readonly string[]).includes(value)) {
    return value as WorkLinkType;
  }
  throw new Error(`Argument "${name}" must be one of: ${WORK_LINK_TYPES.join(', ')}.`);
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing required number argument "${name}".`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
