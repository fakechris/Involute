import { protocolInfo } from './protocol-info.js';
import { groupForAction, hidesFromCaller, MCP_TOOL_GROUPS, resolveMcpCall, type McpToolGroup } from './mcp-tool-groups.js';
import { deleteSavedView, listSavedViews, upsertSavedView } from './saved-views.js';
import { storeUpload } from './uploads.js';
import { actionCapabilities } from './action-capabilities.js';
import { executorContext, executorUpdate, EXECUTOR_OPERATIONS, type ExecutorInput } from './executor-service.js';
import { deliveryContext } from './delivery-context.js';
import { proposeDeliveryChange } from './delivery-change-set.js';
import { createDeliveryExecution } from './delivery-execution.js';
import { readyWorkPage, searchWorkPage } from './work-search-page.js';
import { readWorkCatalog, CATALOG_KINDS } from './work-catalog.js';
import { readWorkPage, WORK_SECTIONS, type WorkSection } from './work-read-page.js';
import { releaseClaim } from './claim-release.js';
import { retractEvidence } from './evidence-retract.js';
import type { PrismaClient, WorkEvidenceKind, WorkLinkType } from '@prisma/client';
import { findPossibleDuplicates } from './embeddings/similar-work.js';

import {
  answerAgentRequest,
  claimAgentRequest,
  readAgentInbox,
  readHandOffOrigins,
  type HandOffOrigin,
  type AnswerEvidenceInput,
} from './agent-request-service.js';
import { toWireState } from './agent-request-state.js';
import type { ReceiptInput, ReceiptReferenceInput } from './decision-receipt.js';

import {
  assertCanActOnRequest,
  assertCanReadTeam,
  assertCanWriteIssue,
  assertCanWriteTeam,
  buildReadableIssueWhere,
 assertCanReadIssue,
} from './access-control.js';
import type { GraphQLContext } from './auth.js';
import { claimWork, commitWork, isDoneStateRequest, normalizeInitialStateType, proposeWork } from './claim-service.js';
import { suggestedBranchName } from './branch-name.js';
import { isResearchWork } from './labels.js';
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
  WORK_LINK_NOT_FOUND_MESSAGE,
  createNotFoundError,
  createScopeForbiddenError,
  createValidationError,
  FIXED_BUG_EVIDENCE_REQUIRED_MESSAGE,
  FIXED_BUG_EVIDENCE_WITHOUT_REVIEW_MESSAGE,
} from './errors.js';
import { NOTIFICATION_NOT_FOUND_MESSAGE, TEAM_WRITE_FORBIDDEN_MESSAGE } from './errors.js';
import { markNotificationRead, readUnreadNotifications } from './notification-service.js';
import { createComment, mentionTexts, updateIssue } from './issue-service.js';
import { amendmentChanges, proposeContractAmendment } from './contract-amendment.js';
import { dependencyHints } from './mention-links.js';
import { researchLacksDownstream } from './work-hygiene.js';
import { linkWork } from './duplicate-linkage.js';
import { deleteWorkLink } from './link-service.js';
import { buildProtocolGuide } from './protocol-docs.js';
import { attachEvidence, reportRun } from './run-service.js';
import { hasFixedBugEvidence, recordFixedBugRun, validateFixedBugEvidence } from './bug-report.js';
import { uncommitWork } from './work-uncommit.js';
import { writeActorFromViewer } from './work-service.js';
import { parseSeverity, SEVERITIES } from './severity.js';

export type McpToolName =
  | 'work_search'
  | 'work_catalog'
  | 'work_read_page'
  | 'work_executor_context'
  | 'work_executor_update'
  | 'work_delivery_context'
  | 'work_delivery_propose'
  | 'work_execution_create'
  | 'work_attach_file'
  | 'work_views'
  | 'work_view_save'
  | 'work_view_delete'
  | 'work_get_context'
  | 'work_list_ready'
  | 'protocol_get_guide'
  | 'work_propose'
  | 'work_file_bug'
  | 'work_commit'
  | 'work_uncommit'
  | 'work_comment'
  | 'work_update'
  | 'work_propose_amendment'
  | 'work_unlink'
  | 'work_link'
  | 'work_claim_release'
  | 'evidence_retract'
  | 'work_claim'
  | 'run_report'
  | 'evidence_attach'
  | 'agent_inbox'
  | 'notification_mark_read'
  | 'agent_request_claim'
  | 'agent_request_answer';

// Order matches MCP_TOOL_DEFINITIONS, which is the order `listMcpTools`
// returns them in.
export const READ_ONLY_MCP_TOOLS: readonly McpToolName[] = [
  'work_search',
  'work_catalog',
  'work_read_page',
  'work_executor_context',
  'work_delivery_context',
  'work_get_context',
  'work_list_ready',
  'work_views',
  'agent_inbox',
  'protocol_get_guide',
];

export const WRITE_MCP_TOOLS: readonly McpToolName[] = [
  'work_view_save',
  'work_view_delete',
  'work_attach_file',
  'work_executor_update',
  'work_delivery_propose',
  'work_execution_create',
  'work_propose',
  'work_file_bug',
  'work_commit',
  'work_uncommit',
  'work_comment',
  'work_update',
  'work_propose_amendment',
  'work_link',
  'work_unlink',
  'work_claim',
  'work_claim_release',
  'evidence_retract',
  'run_report',
  'evidence_attach',
  'notification_mark_read',
  'agent_request_claim',
  'agent_request_answer',
];

export const CANDIDATE_DECISION_NOTICE =
  'A person commits or declines this candidate. Their decision arrives in your agent_inbox `notifications` (work.committed / work.rejected); check there, or read commitmentStatus with work_get_context, before telling anyone it is still waiting.';

const MCP_DONE_CANCEL_FORBIDDEN_TEXT =
  'Agents cannot transition work directly to COMPLETED or CANCELED. Agents stop at In Review; Done is human-gated — except a committed ISSUE with Type: Research, which an agent may move to Done (INV-912).';

/**
 * MCP never closes work except Type: Research, for any caller (INV-912). The
 * rest of the research rules (committed ISSUE, claim, description) are checked
 * in updateIssue, where every surface meets them.
 */
async function assertMcpDoneIsResearch(prisma: PrismaClient, workId: string): Promise<void> {
  if (!(await isResearchWork(prisma, workId))) throw createValidationError(MCP_DONE_CANCEL_FORBIDDEN_TEXT);
}

/** Severity on the write tools; the same three values as GraphQL IssueSeverity (INV-1115). */
const SEVERITY_PROPERTY = {
  type: 'string',
  enum: [...SEVERITIES],
  description: "Impact, separate from priority (which orders work and sets a bug's SLA): SEV1 Critical — outage, data loss or security exposure, no workaround; SEV2 Major — a core flow broken or degraded for many, painful workaround; SEV3 Minor — limited impact, a workaround exists. Unsure: pick the higher one. Optional (INV-1115).",
};

const RECEIPT_SCHEMA = {
  type: 'object',
  description:
    'What you knew and why you decided, frozen at write time so it outlives your session (INV-588). Identity and time are filled by the server from the audit — do not send them. References without a version, digest or excerpt are stored but marked not preserved.',
  properties: {
    reasoning: { type: 'string', description: 'Your reasoning, in your own words. Required.' },
    runtime: { type: 'string', description: 'Runtime snapshot now, e.g. "claude-code 2.1"' },
    evidence: {
      type: 'array',
      description: 'What you relied on',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'comment | file | commit | url | work | run | message' },
          ref: { type: 'string' },
          version: { type: 'string', description: 'revision / sha / timestamp pinning the ref' },
          digest: { type: 'string', description: 'content digest of what you read' },
          excerpt: { type: 'string', description: 'a short frozen excerpt of what you saw' },
        },
        required: ['kind', 'ref'],
      },
    },
    inputs: { type: 'array', description: 'What you were asked / what you read; same item shape as evidence', items: { type: 'object' } },
  },
  required: ['reasoning'],
} as const;

const WORK_EVIDENCE_KINDS: readonly WorkEvidenceKind[] = [
  'PR',
  'TEST',
  'LOG',
  'SCREENSHOT',
  'ARTIFACT',
  'DECISION',
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

/** One listed tool: a single action, or a group of actions behind an `action` argument (INV-1046). */
export interface McpListedTool {
  annotations: McpToolAnnotations;
  description: string;
  inputSchema: JsonSchema;
  name: string;
  /** The underlying actions, in the order their `action` values are offered. */
  actions: McpToolName[];
}

/** Every action with its own schema — what the parity guards and docs tables describe. */
export function listMcpActions(readonly: boolean): McpToolDefinition[] {
  const tools = [...MCP_TOOL_DEFINITIONS];
  return readonly ? tools.filter((tool) => (READ_ONLY_MCP_TOOLS as readonly string[]).includes(tool.name)) : tools;
}

function groupedTool(group: McpToolGroup, members: McpToolDefinition[]): McpListedTool {
  const actions = Object.entries(group.actions).filter(([, member]) => members.some((tool) => tool.name === member));
  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: actions.map(([action]) => action),
      description: `Which operation to run${group.defaultAction && actions.some(([a]) => a === group.defaultAction) ? ` (default "${group.defaultAction}")` : ''}. Each action's own arguments are listed below with the action it belongs to.`,
    },
  };
  for (const [action, member] of actions) {
    const tool = members.find((item) => item.name === member)!;
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      const existing = properties[key] as { description?: string; 'x-actions'?: string[] } | undefined;
      if (existing) {
        existing['x-actions'] = [...(existing['x-actions'] ?? []), action];
        continue;
      }
      const base: Record<string, unknown> = typeof schema === 'object' && schema !== null ? { ...(schema as Record<string, unknown>) } : { description: String(schema) };
      const required = tool.inputSchema.required?.includes(key);
      base.description = `[${action}${required ? ', required' : ''}] ${String(base.description ?? '')}`.trim();
      base['x-actions'] = [action];
      properties[key] = base;
    }
  }
  const memberTools = actions.map(([, member]) => members.find((item) => item.name === member)!);
  return {
    name: group.name,
    description: group.description,
    inputSchema: { type: 'object', properties, ...(group.defaultAction && actions.some(([a]) => a === group.defaultAction) ? {} : { required: ['action'] }) },
    annotations: {
      readOnlyHint: memberTools.every((tool) => tool.annotations.readOnlyHint),
      destructiveHint: memberTools.some((tool) => tool.annotations.destructiveHint),
      ...(memberTools.every((tool) => tool.annotations.idempotentHint === true) ? { idempotentHint: true } : {}),
    },
    actions: memberTools.map((tool) => tool.name),
  };
}

/**
 * What tools/list shows: grouped tools plus the actions that stand alone,
 * minus what this caller may never run (INV-1046). The read-only endpoint
 * shows a group only with its read-only actions. Folded legacy actions
 * (notification_mark_read, work_read_page) are not listed; their arguments
 * live on agent_inbox and work_get_context.
 */
export function listMcpTools(readonly: boolean, context?: Pick<GraphQLContext, 'viewer' | 'authMode' | 'isTrustedSystem'>): McpListedTool[] {
  const actions = listMcpActions(readonly).filter((tool) => !hidesFromCaller(tool.name, context));
  const listed: McpListedTool[] = [];
  const seen = new Set<string>();
  for (const tool of actions) {
    const grouped = groupForAction(tool.name);
    if (grouped) {
      if (seen.has(grouped.group.name)) continue;
      seen.add(grouped.group.name);
      listed.push(groupedTool(grouped.group, actions));
      continue;
    }
    if (tool.name === 'notification_mark_read' || tool.name === 'work_read_page') continue;
    listed.push({ ...tool, actions: [tool.name] });
  }
  return listed;
}

export async function callMcpTool(
  context: GraphQLContext,
  name: string,
  args: Record<string, unknown>,
  readonly: boolean,
): Promise<unknown> {
  const resolved = resolveMcpCall(name, args);
  const result = await callMcpAction(context, resolved.action, resolved.args, readonly);
  if (resolved.deprecated && result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), deprecated: resolved.deprecated };
  }
  return result;
}

async function callMcpAction(
  context: GraphQLContext,
  name: string,
  args: Record<string, unknown>,
  readonly: boolean,
): Promise<unknown> {
  if (readonly && !(READ_ONLY_MCP_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Tool "${name}" is not available on the read-only MCP endpoint.`);
  }
  if (hidesFromCaller(name, context)) {
    throw new Error(`Tool "${name}" is for people: a person commits or uncommits candidate work.`);
  }
  assertToolScope(context, name as McpToolName);

  switch (name as McpToolName) {
    case 'protocol_get_guide': {
      return {
        guide: buildProtocolGuide(),
        protocol: await protocolInfo(context, { projectId: optionalString(args.project_id) ?? null, repository: optionalString(args.repository) ?? null }, readonly),
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
      assignOptional(searchInput, 'repository', optionalString(args.repository));
      const status = optionalString(args.commitment_status);
      if (status === 'CANDIDATE' || status === 'COMMITTED' || status === 'REJECTED') {
        searchInput.commitmentStatus = status;
      }
      if (args.paginate === true || args.after !== undefined) return searchWorkPage(context, searchInput, optionalString(args.after));
      return searchWork(context.prisma, searchInput, buildReadableIssueWhere(context), context.semanticIndex);
    }
    case 'work_catalog': {
      if (args.kind === 'capabilities') return {
        actionCatalogVersion: 1,
        actions: actionCapabilities().map((action) => ({ ...action, inputSchema: MCP_TOOL_DEFINITIONS.find((tool) => tool.name === action.mcpTool)?.inputSchema ?? null })),
        actor: { id: context.viewer?.id, kind: context.viewer?.actorKind },
        tools: MCP_TOOL_DEFINITIONS.map((tool) => {
          const scope = MCP_TOOL_SCOPES[tool.name];
          const humanOnly = ['work_commit', 'work_uncommit'].includes(tool.name);
          const allowedByCredential = context.authMode !== 'agent-token' || !scope || Boolean(context.agentScopes?.includes(scope));
          const allowedByActor = !humanOnly || context.viewer?.actorKind === 'HUMAN';
          const allowedByEndpoint = !readonly || (READ_ONLY_MCP_TOOLS as readonly string[]).includes(tool.name);
          return { name: tool.name, scope, humanOnly, allowedByCredential, allowedByActor, allowedByEndpoint,
            available: allowedByCredential && allowedByActor && allowedByEndpoint };
        }),
        constraints: ['Work access, commitment, active claims and revisions are checked per mutation.', 'Agents stop at Review except committed Research issues; Canceled remains human-only.', 'Committed contracts require a proposed amendment.'],
      };
      return readWorkCatalog(context, requiredString(args.kind, 'kind'), optionalNumber(args.first) ?? 50, optionalString(args.after), optionalString(args.team_id));
    }
    case 'work_read_page': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanReadIssue(context.prisma, context, work.id);
      return readWorkPage(context.prisma, work.id, requiredString(args.section, 'section') as WorkSection, optionalNumber(args.first) ?? 50, optionalString(args.after), buildReadableIssueWhere(context));
    }
    case 'work_executor_context': return executorContext(context, requiredString(args.id, 'id'));
    case 'work_executor_update': return executorUpdate(context, { ...(args.details as Omit<ExecutorInput, 'workId' | 'operation'> ?? {}), workId: requiredString(args.work_id, 'work_id'), operation: requiredString(args.operation, 'operation') as ExecutorInput['operation'] });
    case 'work_delivery_context': return deliveryContext(context, requiredString(args.id, 'id'));
    case 'work_delivery_propose': return proposeDeliveryChange(context, { workId: requiredString(args.work_id, 'work_id'), expectedRevision: requiredNumber(args.expected_revision, 'expected_revision'), reason: requiredString(args.reason, 'reason'), changes: args.changes });
    case 'work_execution_create': return createDeliveryExecution(context, { workId: requiredString(args.work_id, 'work_id'), unitKey: requiredString(args.unit_key, 'unit_key'), expectedGrantRevision: requiredNumber(args.expected_grant_revision, 'expected_grant_revision') });
    case 'work_get_context': {
      const id = requiredString(args.id, 'id');
      const work = await findWorkByIdOrIdentifier(context.prisma, id);
      if (!work) {
        throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
      }
      await assertCanReadIssue(context.prisma, context, work.id);
      // One section at a time, paginated (what work_read_page did, INV-1046).
      if (typeof args.section === 'string') {
        return readWorkPage(context.prisma, work.id, args.section as WorkSection, optionalNumber(args.first) ?? 50, optionalString(args.after), buildReadableIssueWhere(context));
      }
      const bundle = await getWorkContext(context.prisma, work.id, buildReadableIssueWhere(context));
      const linkedIds = [...bundle.ancestors, ...bundle.blockedBy, ...bundle.blocks].map((item) => item.id);
      const visible = new Set((await context.prisma.issue.findMany({ where: { AND: [{ id: { in: linkedIds } }, buildReadableIssueWhere(context) ?? {}] }, select: { id: true } })).map((item) => item.id));
      bundle.ancestors = bundle.ancestors.filter((item) => visible.has(item.id));
      bundle.blockedBy = bundle.blockedBy.filter((item) => visible.has(item.id));
      bundle.blocks = bundle.blocks.filter((item) => visible.has(item.id));
      const pages = await Promise.all(WORK_SECTIONS.map((section) => readWorkPage(context.prisma, work.id, section, section === 'audits' ? 20 : 10, null, buildReadableIssueWhere(context))));
      return { ...bundle, pages: Object.fromEntries(pages.map((page) => [page.section, page])), continuation: 'Call work_get_context(id, section, after=pageInfo.endCursor) while hasNextPage is true.' };
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
      return readyWorkPage(context, readyInput, optionalString(args.after));
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
      const stringList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : undefined);
      assignOptional(proposeInput, 'blockedBy', stringList(args.blocked_by));
      assignOptional(proposeInput, 'blocks', stringList(args.blocks));
      assignOptional(proposeInput, 'labels', stringList(args.labels));
      assignOptional(proposeInput, 'priority', optionalNumber(args.priority));
      assignOptional(proposeInput, 'stepsToReproduce', optionalString(args.steps_to_reproduce));
      assignOptional(proposeInput, 'severity', parseSeverity(args.severity));
      assignOptional(proposeInput, 'repository', optionalString(args.repository));
      assignOptional(proposeInput, 'verification', optionalString(args.verification));
      const kind = optionalString(args.kind);
      if (kind === 'ISSUE' || kind === 'PROJECT' || kind === 'MILESTONE' || kind === 'DECISION' || kind === 'EPIC') {
        proposeInput.kind = kind;
      }
      const relatedType = optionalString(args.related_work_type);
      if (relatedType) proposeInput.relatedWorkType = parseWorkLinkType(relatedType, 'related_work_type');
      proposeInput.source = optionalString(args.source) ?? 'agent';
      const proposeReceipt = parseReceipt(args.receipt);
      if (proposeReceipt) proposeInput.receipt = proposeReceipt;
      assignOptional(proposeInput, 'initialState', optionalString(args.initial_state));
      const created = await proposeWork(context.prisma, proposeInput, { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null });
      const notes: string[] = [];
      if (created.title !== rawTitle) {
        notes.push(`Status prefix was automatically removed from title: "${rawTitle}" -> "${created.title}". Do not encode work status into titles; use work_claim and run_report to transition states.`);
      }
      if (!proposeInput.parentId && created.parentId) {
        const parent = await context.prisma.issue.findUnique({ where: { id: created.parentId }, select: { identifier: true, kind: true } });
        notes.push(`No parent_id given: placed under ${parent?.kind ?? 'parent'} ${parent?.identifier ?? created.parentId}, inherited from the related work (norm v1, INV-718).`);
      }
      const isBug = (proposeInput.labels ?? []).some((label) => label.trim().toLowerCase() === 'bug');
      if (isBug) {
        notes.push('Bug committed directly (INV-787): it does not go to Candidates. Its SLA is running. Fix it or have it declined with a reason; it never goes to the backlog.');
      }
      if (!created.parentId && created.kind !== 'PROJECT') {
        notes.push('This candidate has no parent. Committing it requires one: pass parent_id now (work_link CONTAINS later), or the human will place it at commit.');
      }
      // Close in meaning to existing work (INV-927): say so, so a duplicate can
      // be withdrawn or linked before a person reviews it.
      const possibleDuplicates = context.semanticIndex
        ? await findPossibleDuplicates(context.prisma, context.semanticIndex, created, buildReadableIssueWhere(context))
        : [];
      if (possibleDuplicates.length > 0) {
        notes.push(`Possible duplicates: ${possibleDuplicates.map((item) => `${item.identifier} (${item.title})`).join('; ')}. If one is the same work, link it (DUPLICATE_OF) or withdraw this proposal.`);
      }
      const withDuplicates = possibleDuplicates.length > 0 ? { ...created, possible_duplicates: possibleDuplicates } : created;
      // Where the person's decision will reach the proposer (INV-968), so it
      // is read there instead of asked about.
      const result = created.commitmentStatus === 'CANDIDATE'
        ? { ...withDuplicates, decision_notice: CANDIDATE_DECISION_NOTICE }
        : withDuplicates;
      return notes.length ? { ...result, warning: notes.join(' ') } : result;
    }
    case 'work_file_bug': {
      const teamId = await resolveTeamId(context.prisma, requiredString(args.team, 'team'));
      await assertCanWriteTeam(context.prisma, context, teamId);
      const rawTitle = requiredString(args.title, 'title');
      // Domain labels ride along; a second Type label is refused by the server as usual (INV-1000).
      const extraLabels = (Array.isArray(args.labels) ? args.labels : []).filter((label): label is string => typeof label === 'string' && label.trim() !== '' && label.trim().toLowerCase() !== 'bug');
      const proposeInput: Parameters<typeof proposeWork>[1] = {
        teamId,
        title: rawTitle,
        labels: ['bug', ...extraLabels],
        priority: requiredNumber(args.priority, 'priority'),
        stepsToReproduce: requiredString(args.steps_to_reproduce, 'steps_to_reproduce'),
        // A bug is committed on filing, and an agent may not add acceptance to
        // committed work afterwards; without it here the bug could never be
        // claimed (INV-836 was filed that way on 2026-09-28).
        acceptance: requiredString(args.acceptance, 'acceptance'),
        source: optionalString(args.source) ?? 'agent',
      };
      assignOptional(proposeInput, 'verification', optionalString(args.verification));
      assignOptional(proposeInput, 'description', optionalString(args.description));
      assignOptional(proposeInput, 'severity', parseSeverity(args.severity));
      assignOptional(proposeInput, 'parentId', optionalString(args.parent_id));
      assignOptional(proposeInput, 'relatedWorkId', optionalString(args.related_work_id));
      assignOptional(proposeInput, 'repository', optionalString(args.repository));
      assignOptional(proposeInput, 'idempotencyKey', optionalString(args.idempotency_key));
      const relatedType = optionalString(args.related_work_type);
      if (relatedType) proposeInput.relatedWorkType = parseWorkLinkType(relatedType, 'related_work_type');
      else if (proposeInput.relatedWorkId) proposeInput.relatedWorkType = 'DISCOVERED_DURING';
      assignOptional(proposeInput, 'initialState', optionalString(args.initial_state));
      // Fixed before filing (INV-997): the filing lands in Review and carries
      // the fix's evidence; the server records the completed run for it.
      const fixed = {
        commitSha: optionalString(args.commit_sha) ?? null,
        pullRequestNumber: optionalNumber(args.pr_number) ?? null,
        evidenceUrl: optionalString(args.evidence_url) ?? null,
        summary: optionalString(args.summary) ?? null,
      };
      const intoReview = /^(REVIEW|IN_REVIEW)$/i.test(optionalString(args.initial_state) ?? '');
      if (intoReview && !hasFixedBugEvidence(fixed)) throw createValidationError(FIXED_BUG_EVIDENCE_REQUIRED_MESSAGE);
      if (!intoReview && hasFixedBugEvidence(fixed)) throw createValidationError(FIXED_BUG_EVIDENCE_WITHOUT_REVIEW_MESSAGE);
      validateFixedBugEvidence(fixed);
      const bugActor = { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null };
      const created = await proposeWork(context.prisma, proposeInput, bugActor);
      const recorded = intoReview && created.commitmentStatus === 'COMMITTED'
        ? await context.prisma.$transaction((tx) => recordFixedBugRun(tx, { workId: created.id, ...fixed }, bugActor))
        : null;
      // Where it landed and what it may duplicate, as work_propose says (INV-1000):
      // a bug is committed on filing, so the filer is the one who can still act.
      const notes = [recorded
        ? 'Bug committed directly into Review with its fix recorded (INV-997): the run and evidence are attached; a person accepts or returns it.'
        : 'Bug committed directly (INV-787): it does not go to Candidates. Priority set the SLA. Fix it or have it declined with a reason.'];
      const parent = created.parentId
        ? await context.prisma.issue.findUnique({ where: { id: created.parentId }, select: { identifier: true, kind: true, title: true } })
        : null;
      if (parent && !proposeInput.parentId) {
        notes.push(`No parent_id given: placed under ${parent.kind} ${parent.identifier} (${parent.title}), inherited from the related work (norm v1, INV-718). If that is the wrong place, move it with work_update(parent_id).`);
      }
      const possibleDuplicates = context.semanticIndex
        ? await findPossibleDuplicates(context.prisma, context.semanticIndex, created, buildReadableIssueWhere(context))
        : [];
      if (possibleDuplicates.length > 0) {
        notes.push(`Possible duplicates: ${possibleDuplicates.map((item) => `${item.identifier} (${item.title})`).join('; ')}. If one is the same bug, link this one to it (work_link DUPLICATE_OF): its owner is notified to decline it as a duplicate.`);
      }
      return {
        ...created,
        ...(recorded ? { run: { id: recorded.run.id, public_id: recorded.run.publicId }, evidence: recorded.evidence.map((item) => ({ id: item.id, kind: item.kind, url: item.url })) } : {}),
        placed_under: parent ? { identifier: parent.identifier, kind: parent.kind, title: parent.title } : null,
        ...(possibleDuplicates.length > 0 ? { possible_duplicates: possibleDuplicates } : {}),
        warning: notes.join(' '),
      };
    }
    case 'work_commit': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const commitInput: Parameters<typeof commitWork>[2] = {
        expectedRevision: requiredNumber(args.expected_revision, 'expected_revision'),
      };
      assignOptional(commitInput, 'acceptance', optionalString(args.acceptance));
      assignOptional(commitInput, 'assigneeId', optionalString(args.assignee_id));
      assignOptional(commitInput, 'parentId', optionalString(args.parent_id));
      assignOptional(commitInput, 'priority', optionalNumber(args.priority));
      assignOptional(commitInput, 'constraints', optionalString(args.constraints));
      assignOptional(commitInput, 'outcome', optionalString(args.outcome));
      assignOptional(commitInput, 'scope', optionalString(args.scope));
      if (args.state_id !== undefined && (typeof args.state_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.state_id))) {
        throw createValidationError('state_id must be a workflow state UUID; discover it with work_catalog(kind: states).');
      }
      assignOptional(commitInput, 'stateId', optionalString(args.state_id));
      assignOptional(commitInput, 'verification', optionalString(args.verification));
      assignOptional(commitInput, 'idempotencyKey', optionalString(args.idempotency_key));
      const committed = await commitWork(
        context.prisma,
        work.id,
        commitInput,
        { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
      );
      const hints = await dependencyHints(context.prisma, { id: committed.id, teamId: committed.teamId, texts: mentionTexts(committed) });
      return hints.length
        ? { ...committed, warning: `Its text reads like it depends on ${hints.join(', ')} but no BLOCKS link records that. If it does, add one (work_link BLOCKS); if not, ignore this.` }
        : committed;
    }
    case 'work_uncommit': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      return uncommitWork(
        context.prisma,
        work.id,
        { expectedRevision: requiredNumber(args.expected_revision, 'expected_revision') },
        { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
      );
    }
    case 'work_propose_amendment': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const amendment = await proposeContractAmendment(
        context.prisma,
        { changes: args.changes, reason: requiredString(args.reason, 'reason'), workId: work.id },
        { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
      );
      return {
        amendment_id: amendment.id,
        changes: amendmentChanges(amendment),
        status: amendment.status,
        work: { id: work.id, identifier: work.identifier },
        next: `A person accepts or rejects this under Contract on ${work.identifier}'s issue page. Accepting applies it as their own edit; you will see the result in work_get_context (contractAmendments).`,
      };
    }
    case 'work_comment': {
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      if (!context.viewer) throw createValidationError('An authenticated author is required.');
      return createComment(context.prisma, { issueId: work.id, body: requiredString(args.body, 'body'), parentCommentId: optionalString(args.parent_comment_id) ?? null, idempotencyKey: optionalString(args.idempotency_key) ?? null }, context.viewer.id);
    }
    case 'work_update': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const updateInput: Parameters<typeof updateIssue>[2] = {
        expectedRevision: requiredNumber(args.expected_revision, 'expected_revision'),
      };
      if (args.parent_id !== undefined) {
        const parent = await requireWork(context.prisma, requiredString(args.parent_id, 'parent_id'));
        await assertCanWriteIssue(context.prisma, context, parent.id);
        updateInput.parentId = parent.id;
      }
      // Omitted keeps a field; explicit null clears it through the same domain
      // checks as the issue editor. Labels are replaced as a complete set.
      for (const [wire, field] of [
        ['description', 'description'], ['outcome', 'outcome'], ['scope', 'scope'],
        ['constraints', 'constraints'], ['acceptance', 'acceptance'],
        ['verification', 'verification'], ['repository', 'repository'],
        ['cycle_id', 'cycleId'], ['alias', 'alias'],
      ] as const) {
        if (args[wire] !== undefined) updateInput[field] = args[wire] === null ? null : requiredString(args[wire], wire);
      }
      if (args.label_ids !== undefined) {
        if (!Array.isArray(args.label_ids) || args.label_ids.some((value) => typeof value !== 'string' || !value.trim())) throw createValidationError('label_ids must be an array of label IDs; use [] to clear.');
        updateInput.labelIds = args.label_ids as string[];
      }
      if (args.kind !== undefined) {
        const kind = requiredString(args.kind, 'kind');
        if (!['PROJECT', 'MILESTONE', 'EPIC', 'ISSUE', 'DECISION'].includes(kind)) throw createValidationError('Unknown work kind.');
        updateInput.kind = kind as NonNullable<typeof updateInput.kind>;
      }
      assignOptional(updateInput, 'priority', optionalNumber(args.priority));
      const severity = parseSeverity(args.severity);
      if (severity !== undefined) updateInput.severity = severity;
      if (args.cascade_repository !== undefined) {
        updateInput.cascadeRepository = Boolean(args.cascade_repository);
      } else if (args.repository !== undefined) {
        updateInput.cascadeRepository = true;
      }
      const rawTitle = optionalString(args.title);
      assignOptional(updateInput, 'title', rawTitle);
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
        if (stateObj.type === 'CANCELED') {
          throw createValidationError(MCP_DONE_CANCEL_FORBIDDEN_TEXT);
        }
        updateInput.stateId = stateObj.id;
        if (stateObj.type === 'COMPLETED') await assertMcpDoneIsResearch(context.prisma, work.id);
      } else if (rawState) {
        const targetType = isDoneStateRequest(rawState) ? 'COMPLETED' : normalizeInitialStateType(rawState);
        if (targetType) {
          const matchingState = await context.prisma.workflowState.findFirst({
            where: { teamId: work.teamId, type: targetType },
            orderBy: { position: 'asc' },
            select: { id: true },
          });
          if (matchingState) {
            updateInput.stateId = matchingState.id;
          }
          if (targetType === 'COMPLETED') await assertMcpDoneIsResearch(context.prisma, work.id);
        }
      }
      const updated = await updateIssue(
        context.prisma,
        work.id,
        updateInput,
        { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
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
      const { duplicate, link } = await linkWork(context.prisma, {
        actor: { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
        fromId: from.id,
        toId: to.id,
        type: parseWorkLinkType(requiredString(args.type, 'type'), 'type'),
      });
      // DUPLICATE_OF (INV-1124): say whether the duplicate was closed or waits for a person.
      return duplicate ? { ...link, duplicate } : link;
    }
    case 'work_unlink': {
      const from = await requireWork(context.prisma, requiredString(args.from_id, 'from_id'));
      const to = await requireWork(context.prisma, requiredString(args.to_id, 'to_id'));
      await assertCanWriteIssue(context.prisma, context, from.id);
      await assertCanWriteIssue(context.prisma, context, to.id);
      const type = parseWorkLinkType(requiredString(args.type, 'type'), 'type');
      if (type === 'CONTAINS') {
        throw createValidationError('Move work with work_update(parent_id, expected_revision); removing CONTAINS would orphan it.');
      }
      const link = await context.prisma.workLink.findUnique({
        where: { fromId_toId_type: { fromId: from.id, toId: to.id, type } },
      });
      if (!link) return { removed: false, fromId: from.id, toId: to.id, type };
      let note: string | undefined;
      try {
        ({ note } = await deleteWorkLink(context.prisma, link.id, { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null }));
      } catch (error) {
        // Another caller may have removed this exact edge while we waited for
        // the graph lock. Never delete a newly created replacement by tuple.
        if (error instanceof Error && error.message === WORK_LINK_NOT_FOUND_MESSAGE) {
          return { removed: false, fromId: from.id, toId: to.id, type };
        }
        throw error;
      }
      return { removed: true, id: link.id, fromId: from.id, toId: to.id, type, ...(note ? { note } : {}) };
    }
    case 'work_claim_release': {
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      return releaseClaim(context.prisma, { workId: work.id, reason: requiredString(args.reason, 'reason'), claimToken: optionalString(args.claim_token) ?? null }, { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null });
    }
    case 'evidence_retract': {
      const evidence = await context.prisma.workEvidence.findUnique({ where: { id: requiredString(args.evidence_id, 'evidence_id') } });
      if (!evidence) throw createNotFoundError('Evidence not found.');
      await assertCanWriteIssue(context.prisma, context, evidence.workId);
      const correct = optionalString(args.correct_work_id);
      const target = correct ? await requireWork(context.prisma, correct) : null;
      if (target) await assertCanWriteIssue(context.prisma, context, target.id);
      return retractEvidence(context.prisma, { evidenceId: evidence.id, reason: requiredString(args.reason, 'reason'), correctWorkId: target?.id ?? null, claimToken: optionalString(args.claim_token) ?? null }, { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null });
    }
    case 'work_claim': {
      const work = await requireWork(context.prisma, requiredString(args.id, 'id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const claimInput: Parameters<typeof claimWork>[2] = { claimToken: optionalString(args.claim_token) ?? null, executionId: optionalString(args.execution_id) ?? null };
      assignOptional(claimInput, 'idempotencyKey', optionalString(args.idempotency_key));
      assignOptional(claimInput, 'leaseSeconds', optionalNumber(args.lease_seconds));
      const result = await claimWork(
        context.prisma,
        work.id,
        claimInput,
        { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
      );
      return {
        claim: result.claim,
        work: result.work,
        claim_token: result.claimToken,
        suggested_branch: suggestedBranchName(result.work.identifier, result.work.title),
      };
    }
    case 'run_report': {
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const runInput: Parameters<typeof reportRun>[1] = { workId: work.id, claimToken: optionalString(args.claim_token) ?? null };
      assignOptional(runInput, 'runId', optionalString(args.run_id));
      assignOptional(runInput, 'commitSha', optionalString(args.commit_sha));
      assignOptional(runInput, 'pullRequestNumber', optionalNumber(args.pr_number));
      assignOptional(runInput, 'status', optionalString(args.status));
      assignOptional(runInput, 'phase', optionalString(args.phase));
      assignOptional(runInput, 'summary', optionalString(args.summary));
      assignOptional(runInput, 'externalUrl', optionalString(args.external_url));
      assignOptional(runInput, 'idempotencyKey', optionalString(args.idempotency_key));
      const runReceipt = parseReceipt(args.receipt);
      if (runReceipt) runInput.receipt = runReceipt;
      if (args.decision_requested === true) {
        runInput.decisionRequested = true;
      }
      const reported = await reportRun(context.prisma, runInput, { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null });
      // Advisory only: the report is already committed, so a failed check is skipped.
      const lacksDownstream =
        runInput.status === 'completed' && (await researchLacksDownstream(context.prisma, work.id, runInput.summary).catch(() => false));
      if (lacksDownstream) {
        return {
          ...reported,
          warning: 'This is research with nothing derived from it yet. Propose its actionable points (DERIVED_FROM this item) and "won\'t do" conclusions as DECISIONs, or state "no actionable points" in the summary or verification.',
        };
      }
      return reported;
    }
    case 'work_views': {
      const views = await listSavedViews(context, requiredString(args.team_key, 'team_key'));
      return views.map((view) => ({ id: view.id, name: view.name, kind: view.kind, visibility: view.visibility, owner_id: view.ownerId, state: view.state, updated_at: view.updatedAt.toISOString() }));
    }
    case 'work_view_save': {
      const view = await upsertSavedView(context, {
        id: optionalString(args.id) ?? null,
        teamKey: requiredString(args.team_key, 'team_key'),
        name: requiredString(args.name, 'name'),
        kind: requiredString(args.kind, 'kind'),
        visibility: optionalString(args.visibility) ?? null,
        state: args.state,
      });
      return { id: view.id, name: view.name, kind: view.kind, visibility: view.visibility, owner_id: view.ownerId, state: view.state };
    }
    case 'work_view_delete': {
      return { id: requiredString(args.id, 'id'), removed: await deleteSavedView(context, requiredString(args.id, 'id')) };
    }
    case 'work_attach_file': {
      // A private file on the work (INV-1003): research reports and the like
      // that must never enter git or an image. Readers of the work may open it.
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      if (!context.viewer) throw createValidationError('An authenticated actor is required to attach a file.');
      const attachment = await storeUpload(context.prisma, {
        filename: requiredString(args.filename, 'filename'),
        mimeType: requiredString(args.mime_type, 'mime_type'),
        content: requiredString(args.content, 'content'),
        issueId: work.id,
        uploaderId: context.viewer.id,
      });
      return {
        id: attachment.id, filename: attachment.filename, mime_type: attachment.mimeType, size: attachment.size, url: attachment.url, work_id: work.id, identifier: work.identifier,
        warning: 'Stored under the work; people with read access open it from the issue page (Files). Pass its url to evidence_attach(kind: artifact) when it belongs to a run.',
      };
    }
    case 'evidence_attach': {
      const work = await requireWork(context.prisma, requiredString(args.work_id, 'work_id'));
      await assertCanWriteIssue(context.prisma, context, work.id);
      const evidenceInput: Parameters<typeof attachEvidence>[1] = {
        claimToken: optionalString(args.claim_token) ?? null,
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
        { ...writeActorFromViewer(context.viewer, 'mcp'), agentCredentialId: context.agentCredentialId ?? null },
      );
    }
    case 'agent_inbox': {
      const actorId = requireActorId(context);
      // An agent token sees the inbox of *this credential*: requests on the
      // team it is bound to. The same actor's other credential sees its own.
      if (context.authMode === 'agent-token' && !context.agentTeamId) {
        throw createValidationError(TEAM_WRITE_FORBIDDEN_MESSAGE);
      }
      // Clearing what you have acted on is part of reading the inbox (INV-1046).
      const ack = Array.isArray(args.ack) ? args.ack.filter((item): item is string => typeof item === 'string') : [];
      if (readonly && ack.length > 0) throw new Error('agent_inbox(ack) is not available on the read-only MCP endpoint.');
      for (const id of ack) {
        if (!(await markNotificationRead(context.prisma, { id, userId: actorId }))) throw createNotFoundError(NOTIFICATION_NOT_FOUND_MESSAGE);
      }
      const page = await readAgentInbox(context.prisma, {
        actorId,
        cursor: optionalString(args.cursor) ?? null,
        first: optionalNumber(args.first) ?? null,
        since: optionalDate(args.since),
        teamId: context.authMode === 'agent-token' ? context.agentTeamId ?? null : null,
      });
      return {
        cursor: page.cursor,
        requests: page.items.map((item) => ({
          body: item.body,
          claimed_by: item.claimedBy,
          created_at: item.createdAt.toISOString(),
          deadline_at: item.deadlineAt.toISOString(),
          id: item.id,
          requested_by_actor_id: item.requestedByActorId,
          root_comment_id: item.rootCommentId,
          state: item.state,
          work_id: item.workId,
          work_identifier: item.workIdentifier,
          ...handOffFields(item.handOff),
        })),
        // Decisions on work you proposed or delivered (INV-968): committed,
        // declined, moved back to candidates, accepted or returned in review.
        notifications: (
          await readUnreadNotifications(context.prisma, {
            first: Math.min(Math.max(optionalNumber(args.first) ?? 20, 1), 50),
            since: optionalDate(args.since),
            teamId: context.authMode === 'agent-token' ? context.agentTeamId ?? null : null,
            userId: actorId,
          })
        ).map((notification) => {
          const payload = (notification.payload ?? {}) as Record<string, unknown>;
          const text = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : null);
          return {
            commitment_status: notification.work?.commitmentStatus ?? null,
            created_at: notification.createdAt.toISOString(),
            decided_by_actor_id: text('actorId') ?? text('reviewerId'),
            decision: text('decision'),
            id: notification.id,
            reason: text('reason'),
            type: notification.type,
            work_id: notification.workId,
            work_identifier: notification.work?.identifier ?? null,
            work_title: notification.work?.title ?? null,
          };
        }),
      };
    }
    case 'notification_mark_read': {
      const actorId = requireActorId(context);
      const notification = await markNotificationRead(context.prisma, {
        id: requiredString(args.id, 'id'),
        userId: actorId,
      });
      if (!notification) throw createNotFoundError(NOTIFICATION_NOT_FOUND_MESSAGE);
      return { id: notification.id, read_at: notification.readAt?.toISOString() ?? null };
    }
    case 'agent_request_claim': {
      const actorId = requireActorId(context);
      await assertCanActOnRequest(context.prisma, context, requiredString(args.id, 'id'));
      const claimed = await claimAgentRequest(context.prisma, {
        actorId,
        claimToken: optionalString(args.claim_token) ?? null,
        id: requiredString(args.id, 'id'),
        sessionId: optionalString(args.session_id) ?? null,
      });
      return {
        claim_expires_at: claimed.request.claimExpiresAt?.toISOString() ?? null,
        claim_generation: claimed.request.claimGeneration,
        // Persist this with the execution. It is required to answer and to
        // renew, and it is not recoverable: losing it means waiting for the
        // lease to lapse and taking a new generation.
        claim_token: claimed.claimToken,
        id: claimed.request.id,
        state: toWireState(claimed.request.state),
        work_id: claimed.request.workId,
        ...handOffFields((await readHandOffOrigins(context.prisma, [claimed.request])).get(claimed.request.id) ?? null),
      };
    }
    case 'agent_request_answer': {
      const actorId = requireActorId(context);
      await assertCanActOnRequest(context.prisma, context, requiredString(args.id, 'id'));
      const answerInput: Parameters<typeof answerAgentRequest>[1] = {
        actorId,
        body: requiredString(args.body, 'body'),
        claimToken: requiredString(args.claim_token, 'claim_token'),
        id: requiredString(args.id, 'id'),
        sessionId: optionalString(args.session_id) ?? null,
      };
      const state = optionalString(args.state);
      if (state) {
        if (state !== 'completed' && state !== 'failed' && state !== 'input-required') {
          throw createValidationError(
            'state must be one of: completed, failed, input-required.',
          );
        }
        answerInput.state = state;
      }
      const evidence = parseAnswerEvidence(args.evidence);
      if (evidence.length > 0) {
        answerInput.evidence = evidence;
      }
      const answerReceipt = parseReceipt(args.receipt);
      if (answerReceipt) answerInput.receipt = answerReceipt;
      const answered = await answerAgentRequest(context.prisma, answerInput);
      return {
        answered_comment_id: answered.commentId,
        id: answered.request.id,
        state: toWireState(answered.request.state),
      };
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'work_search',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Search Involute work by identifier, title, description, contract fields, comments, run summaries and text attachments, best match first. Includes candidates and committed work. Each word must be found somewhere; quote a phrase to keep it together. Each result carries match.field and match.snippet; match.field "attachment" adds match.filename, "semantic" means close in meaning with no words matched (when semantic search is on).',
    inputSchema: {
      type: 'object',
      properties: {
        paginate: { type: 'boolean', description: 'Set true for an exhaustive continuation response {nodes,pageInfo}; first 1–100. Legacy calls return an array.' },
        after: { type: 'string', description: 'pageInfo.endCursor from the same query and principal.' },
        query: { type: 'string', description: 'Free text: words (all must match), "quoted phrases", or an identifier such as INV-925 / inv925 / 925' },
        filter: { type: 'string', description: 'IQL filter, e.g. team:SON state-type:STARTED -commitment:rejected. See protocol_get_guide.' },
        team_key: { type: 'string' },
        repository: { type: 'string', description: 'Only work in this project, by repository (e.g. fakechris/Involute)' },
        commitment_status: { type: 'string', enum: ['CANDIDATE', 'COMMITTED', 'REJECTED'] },
        first: { type: 'integer' },
      },
    },
  },
  {
    name: 'work_catalog',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Discover readable teams, states, labels, actors and cycles with pagination, or credential capabilities and policy constraints. Human owners and agent executors are distinct. Catalog visibility uses the web API access rules.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...CATALOG_KINDS, 'capabilities'] }, team_id: { type: 'string' }, first: { type: 'integer', minimum: 1, maximum: 200 }, after: { type: 'string' } }, required: ['kind'] },
  },
  {
    name: 'work_read_page',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Read complete work sections with keyset pagination. Continue with pageInfo.endCursor while hasNextPage. Includes children, typed links, original comments and history; rechecks read access on every call.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, section: { type: 'string', enum: [...WORK_SECTIONS] }, first: { type: 'integer', minimum: 1, maximum: 200 }, after: { type: 'string' } }, required: ['id', 'section'] },
  },
  {
    name: 'work_executor_context',
    description: 'Read version 1 external executor dispatches, stop acknowledgement, checkpoints, effect intents and executor-reported delivery receipts. These observations are not independent verification or human acceptance.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'work_delivery_context',
    description: 'Read a delivery package, its approved implementation units, grant revision and technical proof status. Business acceptance remains human-owned.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'work_get_context',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Return the full context bundle for a work id or identifier: contract, ancestors, blockers, claim, audits.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: [...WORK_SECTIONS], description: 'Read one section only, paginated with first/after — children, links, comments, audits, runs, evidence, reviews, amendments, verifications or delivery_changes. Without it the full bundle is returned with the first page of each.' },
        first: { type: 'number', description: 'Page size for a section read (default 50).' },
        after: { type: 'string', description: 'pageInfo.endCursor from the previous section page.' },
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
        after: { type: 'string', description: 'Continue with endCursor from the same ready query.' },
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
    name: 'work_executor_update',
    description: 'Version 1 external executor protocol. Dispatch requires an explicit executorActorId and maxAttempts approved in the delivery policy. Subsequent calls supply details.expectedRevision and generation. ack supplies runId and claimToken; checkpoint supplies checkpoint; prepare_effect supplies effect {key, action: merge|deploy, environment?, commitSha, paths}; start_effect supplies effectId immediately before the actual effect; receipt supplies idempotencyKey and receipt. A started effect with an unknown result MUST NOT be retried. Humans may dispatch, stop, recover or reconcile an unknown effect with details.resolution {outcome, reason, evidenceUrl, observedSha?}, but cannot forge an executor acknowledgement or receipt.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: 'object', properties: { work_id: { type: 'string' }, operation: { type: 'string', enum: [...EXECUTOR_OPERATIONS] }, details: { type: 'object', properties: { expectedRevision: { type: 'integer' }, generation: { type: 'integer' }, runId: { type: 'string' }, claimToken: { type: 'string' }, checkpoint: { type: 'string' }, effectId: { type: 'string' }, effect: { type: 'object', properties: { key: { type: 'string' }, action: { type: 'string', enum: ['merge', 'deploy'] }, environment: { type: 'string' }, commitSha: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['key', 'action', 'commitSha', 'paths'], additionalProperties: false }, receipt: { type: 'object' }, final: { type: 'boolean', description: 'False records an intermediate effect observation and keeps the dispatch running; default true submits final delivery.' }, resolution: { type: 'object', properties: { outcome: { type: 'string', enum: ['COMPLETED', 'FAILED'] }, reason: { type: 'string' }, evidenceUrl: { type: 'string' }, observedSha: { type: 'string' } } }, idempotencyKey: { type: 'string' } }, additionalProperties: false } }, required: ['work_id', 'operation'] },
  },
  {
    name: 'work_delivery_propose',
    description: 'Propose a candidate delivery change: contract edits, an explicit implementation policy and/or mergeSourceIds. A person approves the entire change atomically in Candidates. Repeated calls create separate proposals. Unit criteria are zero-based references to existing nonblank acceptance lines; paths are literal repository-relative bounds; actions are edit/test/pull_request/merge/deploy; technical dependencies require approved workflowId/job checks.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: 'object', properties: { work_id: { type: 'string' }, expected_revision: { type: 'integer' }, reason: { type: 'string' }, changes: { type: 'object', properties: { contract: { type: 'object' }, policy: { type: 'object' }, mergeSourceIds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } }, required: ['work_id', 'expected_revision', 'reason', 'changes'] },
  },
  {
    name: 'work_execution_create',
    description: 'Instantiate an approved delivery unit and any predecessors, inheriting its contract and human owner. This cannot introduce a new goal or authority. Repeated calls return the same unit for the same grant revision. Since INV-993 approval already creates every unit and puts executor.dispatched in each executor agent_inbox; this is the fallback.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', properties: { work_id: { type: 'string' }, unit_key: { type: 'string' }, expected_grant_revision: { type: 'integer' } }, required: ['work_id', 'unit_key', 'expected_grant_revision'] },
  },
  {
    name: 'work_propose',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: 'Create candidate work. Does not enter the ready queue. Search for duplicates first; the result lists possible_duplicates (existing work close in meaning) when semantic search is on. A bug (labels ["bug"]) is committed directly and never enters Candidates; it requires parent_id (or an inheritable related_work_id), priority 1–4, and steps_to_reproduce — omit any and the proposal is refused.',
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
          description: 'Identifier (e.g. INV-2) or UUID of the parent that CONTAINS this item: PROJECT (for MILESTONE/DECISION/EPIC, or an ISSUE with no milestone), MILESTONE (EPIC/ISSUE), EPIC (ISSUE) or ISSUE (sub-issue). Committing requires a parent; if omitted with related_work_type DISCOVERED_DURING/DERIVED_FROM, the related item\'s nearest legal ancestor is used.',
        },
        related_work_id: { type: 'string', description: 'Existing work item identifier (e.g. INV-2) or UUID to relate this new item to.' },
        related_work_type: {
          type: 'string',
          enum: ['CONTAINS', 'BLOCKS', 'DERIVED_FROM', 'DISCOVERED_DURING', 'RELATED_TO', 'DUPLICATE_OF'],
          description: 'Relationship type from the new item to related_work_id. If CONTAINS, the related item becomes the parent. Otherwise the typed link is recorded in addition to any parent_id. Defaults to DISCOVERED_DURING.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label names, created when missing. Research or competitive analysis is an ISSUE labelled "research" (Type: Research; propose it with initial_state DONE, or move it to Done yourself once committed — INV-912); work it leads to links back with DERIVED_FROM. A bug carries "bug" (Type: Bug; at most one of bug / feature / improvement / research), is committed directly, and must also pass priority 1–4, a parent, and steps_to_reproduce.',
        },
        priority: {
          type: 'number',
          description: 'Suggested priority: 0 (none), 1 (Urgent), 2 (High), 3 (Medium) or 4 (Low); kept on the candidate, and the person who commits it may change it. Required with labels ["bug"] (1–4: Urgent 24h SLA, High 48h, Medium / Low 7 days); the bug is committed directly. Other values are refused.',
        },
        steps_to_reproduce: {
          type: 'string',
          description: 'Bugs: how to reproduce it; appended to the description under "Steps to reproduce". Fixed on the spot? Also pass initial_state REVIEW.',
        },
        severity: SEVERITY_PROPERTY,
        blocked_by: {
          type: 'array',
          items: { type: 'string' },
          description: 'Identifiers of existing work this item cannot start before (each becomes X BLOCKS this). Record dependencies the source material states; do not invent them.',
        },
        blocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Identifiers of existing work that waits on this item (this BLOCKS each).',
        },
        repository: { type: 'string' },
        idempotency_key: { type: 'string' },
        source: { type: 'string', description: 'Origin of this candidate; defaults to agent' },
        initial_state: {
          type: 'string',
          description: 'Optional initial target state upon human commit: BACKLOG (Backlog), UNSTARTED (Ready), STARTED (In Progress), or REVIEW (In Review). Defaults to UNSTARTED. CANNOT be CANCELED, and CANNOT be DONE except for an ISSUE labelled research (Type: Research), which then lands in Done when a person commits it (INV-912).',
        },
      },
      required: ['team', 'title'],
    },
  },
  {
    name: 'work_file_bug',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      'File a Type: Bug. It is committed directly and never enters Candidates. Priority is required because it sets the SLA (1 Urgent 24h, 2 High 48h, 3 Medium / 4 Low = 7 days). Missing parent, priority, steps_to_reproduce or acceptance refuses the call. Already fixed it? Pass initial_state REVIEW with commit_sha / pr_number / evidence_url: the server records the completed run and evidence (INV-997). The result says where it was placed (placed_under) and lists possible_duplicates — existing work close in meaning — when semantic search is on (INV-1000). Prefer this over work_propose for bugs.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key or UUID' },
        title: { type: 'string', description: 'What is broken.' },
        description: {
          type: 'string',
          description: 'Structured Chinese Markdown: ### 1. 目标与架构定位, ### 2. 核心功能与交付范围, ### 3. 验收标准与验证方案.',
        },
        priority: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Required. Sets the SLA: 1 Urgent 24h, 2 High 48h, 3 Medium 7 days, 4 Low 7 days.',
        },
        severity: SEVERITY_PROPERTY,
        steps_to_reproduce: {
          type: 'string',
          description: 'Required. How to reproduce it.',
        },
        acceptance: {
          type: 'string',
          description: 'Required. What must be true when it is fixed. The bug is committed on filing and agents cannot add acceptance later, so without it the bug cannot be claimed.',
        },
        verification: { type: 'string', description: 'How the fix will be checked (tests, manual steps).' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra domain labels (e.g. search, ops). Bug is added automatically; a second Type label (Feature / Improvement / Research) is refused.',
        },
        parent_id: {
          type: 'string',
          description: 'Parent PROJECT/MILESTONE/EPIC/ISSUE. Required unless related_work_id can inherit one.',
        },
        related_work_id: {
          type: 'string',
          description: 'Work this was found during; inherits that item\'s parent when parent_id is omitted.',
        },
        related_work_type: {
          type: 'string',
          enum: ['DISCOVERED_DURING', 'DERIVED_FROM', 'RELATED_TO'],
          description: 'Defaults to DISCOVERED_DURING when related_work_id is set.',
        },
        repository: { type: 'string' },
        initial_state: {
          type: 'string',
          description: 'UNSTARTED (Ready, default), STARTED, or REVIEW if already fixed — then pass commit_sha, pr_number or evidence_url and the server records the completed run with that evidence (INV-997). BACKLOG is ignored for bugs.',
        },
        commit_sha: { type: 'string', description: 'With initial_state REVIEW: the fix commit (full 40-char SHA).' },
        pr_number: { type: 'integer', minimum: 1, description: 'With initial_state REVIEW: the fix PR number in the work\'s repository; attached as PR evidence.' },
        evidence_url: { type: 'string', description: 'With initial_state REVIEW: a test run, log or artifact URL proving the fix.' },
        summary: { type: 'string', description: 'With initial_state REVIEW: what was fixed and how it was checked; becomes the run summary.' },
        idempotency_key: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['team', 'title', 'priority', 'steps_to_reproduce', 'acceptance'],
    },
  },
  {
    name: 'work_commit',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Promote candidate work to a committed contract. Humans only. Requires acceptance, a human owner and a parent (every kind except PROJECT); pass parent_id to place it while committing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_revision: { type: 'integer' },
        parent_id: { type: 'string', description: 'Identifier (e.g. INV-12) or UUID of the PROJECT, MILESTONE, EPIC or ISSUE to place this work under while committing.' },
        priority: { type: 'number', description: '1 (Urgent) to 4 (Low). Required to commit a bug (Type: Bug): it sets the SLA — Urgent 24h, High 48h, otherwise 7 days.' },
        acceptance: { type: 'string' },
        assignee_id: { type: 'string' },
        outcome: { type: 'string' },
        scope: { type: 'string' },
        constraints: { type: 'string' },
        state_id: {
          type: 'string',
          format: 'uuid',
          description: 'Optional workflow state UUID. State type strings are not accepted; discover UUIDs through work_catalog(kind: states). Human commit preserves Research initial Done rules.',
        },
        verification: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['id', 'expected_revision'],
    },
  },
  {
    name: 'work_uncommit',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Return committed work to the candidate queue, reversing the commit at this revision. Refuses when the work is leased, has a run, or has been edited since that commit.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_revision: { type: 'integer' },
      },
      required: ['id', 'expected_revision'],
    },
  },
  {
    name: 'work_propose_amendment',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Propose a change to a COMMITTED contract (acceptance, scope, verification, outcome, constraints). Agents cannot rewrite a committed contract; this records the fields you would change, what they say now and why, and asks the owner. A person accepts (applied as their own edit) or rejects with a note in one click on the issue page. A newer proposal replaces your open one. Candidates: use work_update instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work item identifier (e.g. INV-104) or UUID' },
        changes: {
          type: 'object',
          description: 'New values for the fields to change. A string replaces the field; null clears it (acceptance cannot be cleared).',
          properties: {
            acceptance: { type: ['string', 'null'] },
            scope: { type: ['string', 'null'] },
            verification: { type: ['string', 'null'] },
            outcome: { type: ['string', 'null'] },
            constraints: { type: ['string', 'null'] },
          },
          additionalProperties: false,
          minProperties: 1,
        },
        reason: { type: 'string', description: 'What is wrong with the current contract, and where that is written (a rule, a commit, a decision). Shown to the person who decides.' },
      },
      required: ['id', 'changes', 'reason'],
    },
  },
  {
    name: 'work_comment',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Append an authored comment or reply using the same rules as the issue page. Supply an idempotency_key for safe retries; the same key with changed content is refused. Without a key, retries create another comment.',
    inputSchema: { type: 'object', properties: { work_id: { type: 'string' }, body: { type: 'string' }, parent_comment_id: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['work_id', 'body'] },
  },
  {
    name: 'work_update',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Update work fields. Requires expected_revision. Does not mark work Done — except a committed ISSUE with Type: Research, which an agent may move to Done (state DONE); never CANCELED (INV-912). On COMMITTED work agents cannot change the contract fields (acceptance, scope, verification, outcome, constraints) — propose them with work_propose_amendment.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_revision: { type: 'integer' },
        parent_id: { type: 'string', description: 'Move under this parent (identifier or UUID). Requires access to both items; same-team/repository, hierarchy and cycle rules apply. Cannot detach committed work.' },
        title: { type: 'string' },
        label_ids: { type: 'array', items: { type: 'string' }, description: 'Replace labels with these IDs; [] clears labels. At most one Type label.' },
        kind: { type: 'string', enum: ['PROJECT', 'MILESTONE', 'EPIC', 'ISSUE', 'DECISION'] },
        cycle_id: { type: ['string', 'null'] },
        alias: { type: ['string', 'null'], description: 'PROJECT reference alias; null clears it.' },
        description: { type: ['string', 'null'] },
        outcome: { type: ['string', 'null'] },
        scope: { type: ['string', 'null'] },
        constraints: { type: ['string', 'null'] },
        acceptance: { type: ['string', 'null'] },
        verification: { type: ['string', 'null'] },
        repository: { type: ['string', 'null'] },
        cascade_repository: {
          type: 'boolean',
          description: 'When updating repository, cascade the repository change to all CONTAINS descendants (default: true).',
        },
        priority: { type: 'integer' },
        severity: { ...SEVERITY_PROPERTY, type: ['string', 'null'], enum: [...SEVERITIES, null], description: `${SEVERITY_PROPERTY.description} null clears it; a change is audited with the old value.` },
        state: {
          type: 'string',
          description: 'Optional target workflow state: UNSTARTED (Ready), STARTED (In Progress), or REVIEW (In Review). DONE only for a committed ISSUE with Type: Research and no other actor\'s claim (INV-912). Never CANCELED.',
        },
        state_id: {
          type: 'string',
          format: 'uuid',
          description: 'Optional workflow state ID to transition to. Not CANCELED; COMPLETED only for a committed ISSUE with Type: Research (INV-912).',
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
    name: 'work_unlink',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: 'Remove the specified directed relation. Use this before correcting a reversed BLOCKS edge. Both endpoints require write access. CONTAINS is refused: move work with work_update(parent_id, expected_revision). Returns removed=false if absent.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'string' },
        to_id: { type: 'string' },
        type: { type: 'string', enum: ['BLOCKS', 'DERIVED_FROM', 'DISCOVERED_DURING', 'RELATED_TO', 'DUPLICATE_OF'] },
      },
      required: ['from_id', 'to_id', 'type'],
    },
  },
  {
    name: 'work_claim',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Atomically claim committed work for the current actor. Does not change the human assignee. The response includes suggested_branch — a harness-issued branch name you MUST use verbatim for your git branch; never invent branch names containing issue identifiers. Work in Backlog is not claimable until it is in Ready: move it with work_update (state "UNSTARTED"). A refusal says which rule failed and what to do.',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'Optional client execution identifier; token, not this label, proves ownership.' },
        claim_token: { type: 'string', description: 'Execution secret returned once by work_claim. Required for agents when renewing/reporting/attaching; never include in logs or receipts.' },
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
        claim_token: { type: 'string', description: 'Execution secret returned once by work_claim. Required for agents when renewing/reporting/attaching; never include in logs or receipts.' },
        work_id: { type: 'string', description: 'Work item identifier (e.g. INV-104) or UUID' },
        run_id: {
          type: 'string',
          description: 'Existing RUN-N public ID or UUID to update. IMPORTANT: To start a new run, OMIT this field. Do NOT pass claim.id or client-generated UUID here.',
        },
        commit_sha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        pr_number: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: ['queued', 'running', 'blocked', 'completed', 'failed'] },
        phase: { type: 'string' },
        summary: { type: 'string' },
        external_url: { type: 'string' },
        receipt: RECEIPT_SCHEMA,
        decision_requested: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['work_id'],
    },
  },
  {
    name: 'work_views',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    description: 'Saved board/backlog views you may use in a team: your own and the team\'s shared ones (INV-1005). The state is the board/backlog filter and sort the web app saves.',
    inputSchema: { type: 'object', properties: { team_key: { type: 'string' } }, required: ['team_key'] },
  },
  {
    name: 'work_view_save',
    // Without an id each call creates a view, so a retry can duplicate.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description: 'Create or update a saved view (INV-1005). visibility PRIVATE (default, yours) or TEAM (every member; needs write access to the team). Pass id to update one of yours.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        team_key: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['board', 'backlog'] },
        visibility: { type: 'string', enum: ['PRIVATE', 'TEAM'] },
        state: { type: 'object', description: 'The filter/sort state as the web app saves it (query, stateIds, assigneeIds, labelIds, sortField, sortDirection, …).' },
      },
      required: ['team_key', 'name', 'kind', 'state'],
    },
  },
  {
    name: 'work_view_delete',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: 'Delete one of your saved views; a team owner may also delete a shared one (INV-1005).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'work_attach_file',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description:
      'Attach a private file to work (INV-1003): a research report, export or screenshot that must stay out of git and images. Stored server-side; readers of the work open it from the issue page. Base64 content, up to 50 MB. Returns the url to cite in evidence_attach(kind: artifact).',
    inputSchema: {
      type: 'object',
      properties: {
        work_id: { type: 'string', description: 'Work id or identifier the file belongs to.' },
        filename: { type: 'string' },
        mime_type: { type: 'string', description: 'e.g. text/markdown, application/pdf.' },
        content: { type: 'string', description: 'Base64-encoded file content.' },
      },
      required: ['work_id', 'filename', 'mime_type', 'content'],
    },
  },
  {
    name: 'evidence_attach',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description: 'Attach a PR, test report, log, screenshot, or artifact to an existing run.',
    inputSchema: {
      type: 'object',
      properties: {
        claim_token: { type: 'string', description: 'Execution secret returned once by work_claim. Required for agents when renewing/reporting/attaching; never include in logs or receipts.' },
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
    name: 'work_claim_release',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Yield your own active execution lease with a reason. Open runs become failed; another worker can claim immediately. Requires your claim_token; people may force release through the UI.',
    inputSchema: { type: 'object', properties: { work_id: { type: 'string' }, claim_token: { type: 'string' }, reason: { type: 'string' } }, required: ['work_id', 'claim_token', 'reason'] },
  },
  {
    name: 'evidence_retract',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description: 'Retract your own evidence before human acceptance, keeping history. Requires its run execution token and a reason. Other authors or accepted work require a person. Attach corrected evidence separately.',
    inputSchema: { type: 'object', properties: { evidence_id: { type: 'string' }, claim_token: { type: 'string' }, reason: { type: 'string' }, correct_work_id: { type: 'string' } }, required: ['evidence_id', 'claim_token', 'reason'] },
  },
  {
    name: 'agent_inbox',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      'Open requests addressed to you: questions put to this actor that are still submitted, working, or awaiting your input. Also `notifications`: unread decisions on work you proposed or delivered — committed, declined, moved back to candidates, accepted or returned in review — so the decision is read here instead of asked for; mark each read with notification_mark_read. Poll with `since` or page with `cursor`. Reading does not reserve anything — call agent_request_claim before you start work. A row with `handed_off_from_id` was handed to you after its previous target did not answer: answer in your own name, standing in for @`handed_off_from_handle`.',
    inputSchema: {
      type: 'object',
      properties: {
        ack: { type: 'array', items: { type: 'string' }, description: 'Notification ids from a previous agent_inbox you have acted on; they are marked read before this page is built (not on the read-only endpoint).' },
        since: { type: 'string', description: 'ISO-8601; only requests created after this instant' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page' },
        first: { type: 'integer', description: 'Page size, 1-50 (default 20)' },
      },
    },
  },
  {
    name: 'notification_mark_read',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      'Mark one of your notifications from agent_inbox read once you have acted on it, so the next agent_inbox shows only what is new. Your own notifications only; marking one twice is harmless.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Notification id from agent_inbox' },
      },
      required: ['id'],
    },
  },
  {
    name: 'agent_request_claim',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      'Take the claim on a request addressed to you, moving it to `working`. Returns a claim_token: persist it with this execution, it is required to answer and to renew. Exactly one execution can hold a claim, even among sessions of the same actor. The claim is a 60s lease; renew by calling again with claim_token. If you lose the token, wait for the lease to lapse and claim again for a new generation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent request id' },
        claim_token: { type: 'string', description: 'Your token from a previous claim, to renew the same execution' },
        session_id: { type: 'string', description: 'Your session id, recorded on the audit so the context can be found later' },
      },
      required: ['id'],
    },
  },
  {
    name: 'agent_request_answer',
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Answer a request you hold the claim on. Requires the claim_token from agent_request_claim, so only the execution that holds the claim can answer — a stale session of the same actor is rejected. Posts a comment authored by you and moves the request. `state` defaults to `completed`; use `failed` when you cannot answer, or `input-required` to ask the requester for something and hand the claim back. A2A state names.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent request id' },
        claim_token: { type: 'string', description: 'From agent_request_claim' },
        session_id: { type: 'string', description: 'Your session id, recorded on the audit' },
        body: { type: 'string', description: 'The answer, posted as your comment' },
        receipt: RECEIPT_SCHEMA,
        state: { type: 'string', enum: ['completed', 'failed', 'input-required'] },
        evidence: {
          type: 'array',
          description: 'Durable citations backing the answer',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['pr', 'test', 'log', 'screenshot', 'artifact', 'decision'] },
              url: { type: 'string' },
              summary: { type: 'string' },
            },
            required: ['kind', 'url'],
          },
        },
      },
      required: ['id', 'claim_token', 'body'],
    },
  },
  {
    name: 'protocol_get_guide',
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: 'Return the full Involute work protocol: kernel rules, state machines, scopes, tools, webhook events, and the IQL query language. Call this before writing work.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'PROJECT UUID or identifier for binding diagnosis.' },
        repository: { type: 'string', description: 'Repository to resolve using the canonical project resolver.' },
      },
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

function optionalDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createValidationError(`Argument "since" is not a valid ISO-8601 timestamp: ${value}.`);
  }
  return parsed;
}

// An inbox is addressed to an actor, so these tools are meaningless without
// one: a trusted CLI token with no viewer cannot stand in for an agent.
function requireActorId(context: GraphQLContext): string {
  const actorId = context.viewer?.id;
  if (!actorId) {
    throw createValidationError(
      'Agent request tools require an authenticated actor; use the agent credential of the actor whose inbox you are reading.',
    );
  }
  return actorId;
}

function parseReceipt(value: unknown): ReceiptInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw createValidationError('Argument "receipt" must be an object.');
  const raw = value as Record<string, unknown>;
  const parsed: ReceiptInput = { reasoning: requiredString(raw.reasoning, 'receipt.reasoning') };
  const runtime = optionalString(raw.runtime);
  if (runtime !== undefined) parsed.runtime = runtime;
  const refs = (field: 'evidence' | 'inputs'): ReceiptReferenceInput[] | undefined => {
    const list = raw[field];
    if (list === undefined || list === null) return undefined;
    if (!Array.isArray(list)) throw createValidationError(`Argument "receipt.${field}" must be an array.`);
    return list.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) throw createValidationError(`receipt.${field}[${index}] must be an object.`);
      const item = entry as Record<string, unknown>;
      const ref: ReceiptReferenceInput = {
        kind: requiredString(item.kind, `receipt.${field}[${index}].kind`),
        ref: requiredString(item.ref, `receipt.${field}[${index}].ref`),
      };
      const version = optionalString(item.version); if (version !== undefined) ref.version = version;
      const digest = optionalString(item.digest); if (digest !== undefined) ref.digest = digest;
      const excerpt = optionalString(item.excerpt); if (excerpt !== undefined) ref.excerpt = excerpt;
      return ref;
    });
  };
  const evidence = refs('evidence'); if (evidence) parsed.evidence = evidence;
  const inputs = refs('inputs'); if (inputs) parsed.inputs = inputs;
  return parsed;
}

function parseAnswerEvidence(value: unknown): AnswerEvidenceInput[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw createValidationError('Argument "evidence" must be an array.');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw createValidationError(`Argument "evidence[${index}]" must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const kind = requiredString(item.kind, `evidence[${index}].kind`).toUpperCase();
    if (!(WORK_EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      throw createValidationError(
        `Argument "evidence[${index}].kind" must be one of: ${WORK_EVIDENCE_KINDS.join(', ')}.`,
      );
    }
    const parsed: AnswerEvidenceInput = {
      kind: kind as WorkEvidenceKind,
      url: requiredString(item.url, `evidence[${index}].url`),
    };
    const summary = optionalString(item.summary);
    if (summary !== undefined) {
      parsed.summary = summary;
    }
    return parsed;
  });
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
  work_executor_context: 'read',
  work_executor_update: 'report',
  work_delivery_context: 'read',
  work_delivery_propose: 'propose',
  work_execution_create: 'claim',
  work_attach_file: 'report',
  work_views: 'read',
  work_view_save: 'propose',
  work_view_delete: 'propose',
  work_get_context: 'read',
  work_read_page: 'read',
  work_catalog: 'read',
  work_list_ready: 'read',
  protocol_get_guide: 'read',
  work_propose: 'propose',
  work_file_bug: 'propose',
  work_commit: null,
  work_uncommit: null,
  work_update: 'update',
  work_comment: 'update',
  // Proposing writes nothing to the contract until a person accepts it.
  work_propose_amendment: 'propose',
  work_link: 'link',
  work_unlink: 'link',
  work_claim: 'claim',
  work_claim_release: 'claim',
  evidence_retract: 'report',
  run_report: 'report',
  evidence_attach: 'report',
  agent_inbox: 'read',
  // Clearing your own inbox is part of reading it.
  notification_mark_read: 'read',
  agent_request_claim: 'answer',
  agent_request_answer: 'answer',
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

/**
 * A handed-off request says where it came from (INV-609): the receiver answers
 * in its own name, "standing in for @<handed_off_from_handle>". All null on a
 * request that was not handed off, so older consumers see nothing new.
 */
function handOffFields(origin: HandOffOrigin | null) {
  return {
    handed_off_from_handle: origin?.handedOffFromHandle ?? null,
    handed_off_from_id: origin?.handedOffFromId ?? null,
    hop_count: origin?.hopCount ?? null,
    root_request_id: origin?.rootRequestId ?? null,
  };
}
