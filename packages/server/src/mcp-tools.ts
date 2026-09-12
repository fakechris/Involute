import type { PrismaClient, WorkLinkType } from '@prisma/client';

import {
  assertCanReadTeam,
  assertCanWriteIssue,
  assertCanWriteTeam,
  buildReadableIssueWhere,
} from './access-control.js';
import type { GraphQLContext } from './auth.js';
import { claimWork, commitWork, normalizeInitialStateType, proposeWork } from './claim-service.js';
import { suggestedBranchName } from './branch-name.js';
import {
  findWorkByIdOrIdentifier,
  getWorkContext,
  listReadyWork,
  searchWork,
} from './context-service.js';
import {
  ISSUE_NOT_FOUND_MESSAGE,
  TEAM_NOT_FOUND_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
  createNotFoundError,
  createScopeForbiddenError,
  createValidationError,
} from './errors.js';
import { updateIssue } from './issue-service.js';
import { createWorkLink } from './link-service.js';
import { buildProtocolGuide } from './protocol-docs.js';
import { attachEvidence, reportRun } from './run-service.js';
import { writeActorFromViewer } from './work-service.js';

export type McpToolName =
  | 'work_search'
  | 'work_get_context'
  | 'work_list_ready'
  | 'protocol_get_guide'
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
  'protocol_get_guide',
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

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
}

export interface McpToolDefinition {
  annotations: McpToolAnnotations;
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
  assertToolScope(context, name as McpToolName);

  switch (name as McpToolName) {
    case 'protocol_get_guide': {
      return {
        guide: buildProtocolGuide(),
        contentType: 'text/markdown',
      };
    }
    case 'work_search': {
      const searchInput: Parameters<typeof searchWork>[1] = {};
      assignOptional(searchInput, 'first', optionalNumber(args.first));
      assignOptional(searchInput, 'query', optionalString(args.query));
      assignOptional(searchInput, 'iql', optionalString(args.filter));
      searchInput.viewerId = context.viewer?.id ?? null;
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
      assignOptional(readyInput, 'iql', optionalString(args.filter));
      readyInput.viewerId = context.viewer?.id ?? null;
      assignOptional(readyInput, 'priority', optionalNumber(args.priority));
      assignOptional(readyInput, 'projectId', optionalString(args.project_id));
      assignOptional(readyInput, 'repository', optionalString(args.repository));
      assignOptional(readyInput, 'teamKey', optionalString(args.team_key));
      return listReadyWork(context.prisma, readyInput, buildReadableIssueWhere(context));
    }
    case 'work_propose': {
      const teamId = await resolveTeamId(context.prisma, requiredString(args.team, 'team'));
      await assertCanWriteTeam(context.prisma, context, teamId);
      const rawTitle = requiredString(args.title, 'title');
      const proposeInput: Parameters<typeof proposeWork>[1] = {
        teamId,
        title: rawTitle,
      };
      assignOptional(proposeInput, 'acceptance', optionalString(args.acceptance));
      assignOptional(proposeInput, 'constraints', optionalString(args.constraints));
      assignOptional(proposeInput, 'description', optionalString(args.description));
      assignOptional(proposeInput, 'idempotencyKey', optionalString(args.idempotency_key));
      assignOptional(proposeInput, 'outcome', optionalString(args.outcome));
      assignOptional(proposeInput, 'parentId', optionalString(args.parent_id));
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
      proposeInput.source = optionalString(args.source) ?? 'agent';
      assignOptional(proposeInput, 'initialState', optionalString(args.initial_state));
      const created = await proposeWork(context.prisma, proposeInput, writeActorFromViewer(context.viewer, 'mcp'));
      if (created.title !== rawTitle) {
        return {
          ...created,
          warning: `Status prefix was automatically removed from title: "${rawTitle}" -> "${created.title}". Do not encode work status into titles; use work_claim and run_report to transition states.`,
        };
      }
      return created;
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
      assignOptional(commitInput, 'stateId', optionalString(args.state_id));
      assignOptional(commitInput, 'verification', optionalString(args.verification));
      assignOptional(commitInput, 'idempotencyKey', optionalString(args.idempotency_key));
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
      const rawTitle = optionalString(args.title);
      assignOptional(updateInput, 'title', rawTitle);
      assignOptional(updateInput, 'verification', optionalString(args.verification));
      if (args.snoozed_until !== undefined) {
        updateInput.snoozedUntil = args.snoozed_until === null ? null : new Date(requiredString(args.snoozed_until, 'snoozed_until'));
      }
      const rawState = optionalString(args.state);
      const rawStateId = optionalString(args.state_id);
      if (rawStateId) {
        const stateObj = await context.prisma.workflowState.findUnique({
          where: { id: rawStateId },
          select: { id: true, type: true, teamId: true },
        });
        if (!stateObj || stateObj.teamId !== work.teamId) {
          throw createValidationError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
        }
        if (stateObj.type === 'COMPLETED' || stateObj.type === 'CANCELED') {
          throw createValidationError(
            'Agents cannot transition work directly to COMPLETED or CANCELED. Agents stop at In Review; Done is human-gated.',
          );
        }
        updateInput.stateId = stateObj.id;
      } else if (rawState) {
        const targetType = normalizeInitialStateType(rawState);
        if (targetType) {
          const matchingState = await context.prisma.workflowState.findFirst({
            where: { teamId: work.teamId, type: targetType },
            orderBy: { position: 'asc' },
            select: { id: true },
          });
          if (matchingState) {
            updateInput.stateId = matchingState.id;
          }
        }
      }
      const updated = await updateIssue(
        context.prisma,
        work.id,
        updateInput,
        writeActorFromViewer(context.viewer, 'mcp'),
      );
      if (rawTitle && updated.title !== rawTitle) {
        return {
          ...updated,
          warning: `Status prefix was automatically removed from title: "${rawTitle}" -> "${updated.title}". Do not encode work status into titles; use work_claim and run_report to transition states.`,
        };
      }
      return updated;
    }
    case 'work_link': {
      const from = await requireWork(context.prisma, requiredString(args.from_id, 'from_id'));
      const to = await requireWork(context.prisma, requiredString(args.to_id, 'to_id'));
      await assertCanWriteIssue(context.prisma, context, from.id);
      await assertCanWriteIssue(context.prisma, context, to.id);
      return createWorkLink(context.prisma, {
        actor: writeActorFromViewer(context.viewer, 'mcp'),
        fromId: from.id,
        toId: to.id,
        type: parseWorkLinkType(requiredString(args.type, 'type'), 'type'),
      });
    }
    case 'work_claim': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const claimInput: Parameters<typeof claimWork>[2] = {};
      assignOptional(claimInput, 'idempotencyKey', optionalString(args.idempotency_key));
      assignOptional(claimInput, 'leaseSeconds', optionalNumber(args.lease_seconds));
      const result = await claimWork(
        context.prisma,
        work.id,
        claimInput,
        writeActorFromViewer(context.viewer, 'mcp'),
      );
      return {
        ...result,
        suggested_branch: suggestedBranchName(result.work.identifier, result.work.title),
      };
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
      assignOptional(runInput, 'idempotencyKey', optionalString(args.idempotency_key));
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
      assignOptional(evidenceInput, 'idempotencyKey', optionalString(args.idempotency_key));
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
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Search Involute work by identifier, title, or description. Includes candidates and committed work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across identifier, title, and description' },
        filter: { type: 'string', description: 'IQL filter, e.g. team:SON state-type:STARTED -commitment:rejected. See protocol_get_guide.' },
        team_key: { type: 'string' },
        commitment_status: { type: 'string', enum: ['CANDIDATE', 'COMMITTED', 'REJECTED'] },
        first: { type: 'integer' },
      },
    },
  },
  {
    name: 'work_get_context',
    annotations: { readOnlyHint: true, destructiveHint: false },
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
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'List committed, unblocked, unclaimed work in urgency order.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string' },
        team_key: { type: 'string' },
        project_id: { type: 'string', description: 'Work Graph PROJECT UUID/identifier or legacy Project UUID; shares repository scope with readyWork.' },
        priority: { type: 'integer' },
        filter: { type: 'string', description: 'IQL filter applied on top of ready-work rules. See protocol_get_guide.' },
        first: { type: 'integer' },
      },
    },
  },
  {
    name: 'work_propose',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: 'Create candidate work. Does not enter the ready queue. Search for duplicates first.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key or UUID' },
        title: {
          type: 'string',
          description: 'Clear deliverable title. Do NOT prefix with [已交付], [待办], or status tags — status is tracked via the Involute state machine.',
        },
        description: {
          type: 'string',
          description: 'Mandatory rich structured Chinese Markdown description. MUST include: 1. ### 1. 目标与架构定位, 2. ### 2. 核心功能与交付范围, 3. ### 3. 验收标准与验证方案. Minimal docs links (ref docs/...) are strictly rejected.',
        },
        outcome: { type: 'string' },
        scope: { type: 'string' },
        constraints: { type: 'string' },
        acceptance: { type: 'string' },
        verification: { type: 'string' },
        kind: { type: 'string', enum: ['ISSUE', 'PROJECT', 'MILESTONE', 'DECISION', 'EPIC'] },
        parent_id: {
          type: 'string',
          description: 'Recommended: The identifier (e.g. INV-2) or UUID of the parent work item (PROJECT or MILESTONE) that CONTAINS this item. Guarantees top-down hierarchy and prevents relationship inversion.',
        },
        related_work_id: { type: 'string', description: 'Existing work item identifier (e.g. INV-2) or UUID to relate this new item to.' },
        related_work_type: {
          type: 'string',
          enum: ['CONTAINS', 'BLOCKS', 'DERIVED_FROM', 'DISCOVERED_DURING', 'RELATED_TO', 'DUPLICATE_OF'],
          description: 'Relationship type. If CONTAINS, the related item (e.g. Project/Milestone) contains this new item as a child. Defaults to DISCOVERED_DURING.',
        },
        repository: { type: 'string' },
        idempotency_key: { type: 'string' },
        source: { type: 'string', description: 'Origin of this candidate; defaults to agent' },
        initial_state: {
          type: 'string',
          description: 'Optional initial target state upon human commit: BACKLOG (Backlog), UNSTARTED (Ready), STARTED (In Progress), or REVIEW (In Review). Defaults to UNSTARTED. CANNOT be COMPLETED (Done) or CANCELED.',
        },
      },
      required: ['team', 'title'],
    },
  },
  {
    name: 'work_commit',
    annotations: { readOnlyHint: false, destructiveHint: false },
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
        state_id: {
          type: 'string',
          description: 'Optional target workflow state ID or type to transition to upon commit. Cannot be COMPLETED or CANCELED.',
        },
        verification: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['id', 'expected_revision'],
    },
  },
  {
    name: 'work_update',
    annotations: { readOnlyHint: false, destructiveHint: false },
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
        state: {
          type: 'string',
          description: 'Optional target workflow state: UNSTARTED (Ready), STARTED (In Progress), or REVIEW (In Review). Cannot be COMPLETED or CANCELED.',
        },
        state_id: {
          type: 'string',
          description: 'Optional workflow state ID to transition to. Cannot be COMPLETED or CANCELED.',
        },
        snoozed_until: { type: ['string', 'null'], description: 'ISO timestamp; candidate-only. Pass null to clear.' },
      },
      required: ['id', 'expected_revision'],
    },
  },
  {
    name: 'work_link',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Atomically claim committed work for the current actor. Does not change the human assignee. The response includes suggested_branch — a harness-issued branch name you MUST use verbatim for your git branch; never invent branch names containing issue identifiers.',
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
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Report a high-level run phase, block, or completion. Completed runs may move work to In Review, never Done.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string', description: 'Work item identifier (e.g. INV-104) or UUID' },
        run_id: {
          type: 'string',
          description: 'Existing RUN-N public ID or UUID to update. IMPORTANT: To start a new run, OMIT this field. Do NOT pass claim.id or client-generated UUID here.',
        },
        status: { type: 'string', enum: ['queued', 'running', 'blocked', 'completed', 'failed'] },
        phase: { type: 'string' },
        summary: { type: 'string' },
        external_url: { type: 'string' },
        decision_requested: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['work_id'],
    },
  },
  {
    name: 'evidence_attach',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: 'Attach a PR, test report, log, screenshot, or artifact to an existing run.',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        run_id: { type: 'string' },
        kind: { type: 'string', enum: ['pr', 'test', 'log', 'screenshot', 'artifact', 'decision'] },
        url: { type: 'string' },
        summary: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['work_id', 'run_id', 'kind', 'url'],
    },
  },
  {
    name: 'protocol_get_guide',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Return the full Involute work protocol: kernel rules, state machines, scopes, tools, webhook events, and the IQL query language. Call this before writing work.',
    inputSchema: {
      type: 'object',
      properties: {},
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

// Linear-mapped credential scopes. Human sessions and trusted tokens bypass
// scope checks (full access); agent tokens are confined to the scopes granted
// at issuance. `work_commit` stays human-only via actorKind gates, so it maps
// to no scope.
const MCP_TOOL_SCOPES: Record<McpToolName, string | null> = {
  work_search: 'read',
  work_get_context: 'read',
  work_list_ready: 'read',
  protocol_get_guide: 'read',
  work_propose: 'propose',
  work_commit: null,
  work_update: 'update',
  work_link: 'link',
  work_claim: 'claim',
  run_report: 'report',
  evidence_attach: 'report',
};

export function assertToolScope(context: GraphQLContext, name: McpToolName): void {
  if (context.authMode !== 'agent-token') {
    return;
  }
  const scope = MCP_TOOL_SCOPES[name];
  if (!scope) {
    return;
  }
  if (!context.agentScopes?.includes(scope)) {
    throw createScopeForbiddenError(scope);
  }
}
