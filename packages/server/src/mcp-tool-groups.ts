import type { GraphQLContext } from './auth.js';

/**
 * The MCP surface agents see (INV-1046). Every write and read the server
 * offers is still one *action* with its own schema and GraphQL counterpart
 * (mcp-tools.ts MCP_TOOL_DEFINITIONS; the parity guards read those). What
 * tools/list shows is grouped: a pair such as link/unlink, or a family such as
 * list/save/delete, is one tool with an `action` argument, so a client holds
 * twenty tools instead of thirty-three and never chooses between a tool and
 * its own reverse. Old action names stay callable for one version and answer
 * with a `deprecated` note naming the tool to use.
 */
export interface McpToolGroup {
  name: string;
  description: string;
  /** action value → the underlying action (an MCP_TOOL_DEFINITIONS name). */
  actions: Record<string, string>;
  /** Action assumed when the caller passes none; lets an existing name keep its old call shape. */
  defaultAction?: string;
}

export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = [
  {
    name: 'work_relate',
    description: 'Add or remove a typed relation between two work items (BLOCKS, DERIVED_FROM, DISCOVERED_DURING, RELATED_TO, DUPLICATE_OF, REGRESSED_BY; CONTAINS is added through parent_id on work_propose/work_update). action "link" creates it, "unlink" removes the exact directed edge — use unlink before correcting a reversed BLOCKS.',
    actions: { link: 'work_link', unlink: 'work_unlink' },
  },
  {
    name: 'work_view',
    description: 'Saved board/backlog views in a team (INV-1005): action "list" (default) returns yours and the shared ones, "save" creates or updates one (pass id to update), "delete" removes one of yours.',
    actions: { list: 'work_views', save: 'work_view_save', delete: 'work_view_delete' },
    defaultAction: 'list',
  },
  {
    name: 'work_timeline',
    description: 'The issue timeline (INV-1116): action "list" (default) returns audit changes, runs, evidence and comments in time order with actors and entry keys (starred_only for key events); "star" marks an entry as a key event, "unstar" removes the star.',
    actions: { list: 'work_timeline', star: 'work_timeline_star', unstar: 'work_timeline_unstar' },
    defaultAction: 'list',
  },
  {
    name: 'work_claim',
    description: 'Lease committed work for this actor (action "claim", default) or yield your own lease with a reason (action "release"). A claim returns a secret claim_token and a harness-issued suggested_branch you must use verbatim. Does not change the human assignee.',
    actions: { claim: 'work_claim', release: 'work_claim_release' },
    defaultAction: 'claim',
  },
  {
    name: 'evidence',
    description: 'Evidence on a run: action "attach" (default) adds a PR, test report, log, screenshot or artifact URL to an existing run; "retract" withdraws your own unaccepted evidence with a reason, keeping history. Both need the run\'s claim_token.',
    actions: { attach: 'evidence_attach', retract: 'evidence_retract' },
    defaultAction: 'attach',
  },
  {
    name: 'agent_request',
    description: 'A request addressed to you from agent_inbox: action "claim" leases it (returns the claim_token only the holding execution can use), "answer" posts your reply and moves its state. Exactly one execution holds a claim, even among sessions of the same actor.',
    actions: { claim: 'agent_request_claim', answer: 'agent_request_answer' },
  },
  {
    name: 'delivery',
    description: 'Delivery packages (INV-941): action "context" (default) reads the package, its approved units, grant revision and technical proof; "propose" files a candidate delivery change a person approves atomically; "execution_create" instantiates an approved unit (approval already creates them since INV-993, so this is a retry).',
    actions: { context: 'work_delivery_context', propose: 'work_delivery_propose', execution_create: 'work_execution_create' },
    defaultAction: 'context',
  },
  {
    name: 'executor',
    description: 'Version 1 external executor protocol: action "context" (default) reads dispatches, effects and receipts; "update" sends one operation (dispatch, ack, checkpoint, prepare_effect, start_effect, receipt, stop, stop_ack, reconcile) with its details. Observations here are not human acceptance.',
    actions: { context: 'work_executor_context', update: 'work_executor_update' },
    defaultAction: 'context',
  },
];

/** Legacy names that are not part of a group but were folded into another tool's arguments. */
export const MCP_FOLDED_ACTIONS: Record<string, { into: string; hint: string }> = {
  notification_mark_read: { into: 'agent_inbox', hint: 'pass ack: [notification ids] to agent_inbox' },
  work_read_page: { into: 'work_get_context', hint: 'pass section (and after) to work_get_context' },
};

/** Actions only a person may run; an agent credential does not see them at all. */
export const HUMAN_ONLY_MCP_TOOLS: readonly string[] = ['work_commit', 'work_uncommit'];

const memberToGroup = new Map<string, { group: McpToolGroup; action: string }>();
for (const group of MCP_TOOL_GROUPS) for (const [action, member] of Object.entries(group.actions)) memberToGroup.set(member, { group, action });

export function groupForAction(member: string): { group: McpToolGroup; action: string } | undefined {
  return memberToGroup.get(member);
}

export function groupByName(name: string): McpToolGroup | undefined {
  return MCP_TOOL_GROUPS.find((group) => group.name === name);
}

/** Is this name one the caller may still use, but should move off? */
export function deprecationFor(name: string): string | null {
  const grouped = memberToGroup.get(name);
  if (grouped && grouped.group.name !== name) return `${name} is deprecated; call ${grouped.group.name} with action "${grouped.action}". It stays callable for one version.`;
  const folded = MCP_FOLDED_ACTIONS[name];
  if (folded) return `${name} is deprecated; ${folded.hint}. It stays callable for one version.`;
  return null;
}

/**
 * Resolve a tools/call name to the action that runs it. A group name takes
 * `action` (or its default); a legacy member or folded name runs as itself
 * with a deprecation note; anything else is passed through unchanged.
 */
export function resolveMcpCall(
  name: string,
  args: Record<string, unknown>,
): { action: string; args: Record<string, unknown>; deprecated: string | null } {
  const group = groupByName(name);
  if (group) {
    const requested = typeof args.action === 'string' ? args.action : group.defaultAction;
    if (!requested || !group.actions[requested]) {
      throw new Error(`${name} needs action: one of ${Object.keys(group.actions).join(', ')}.`);
    }
    const { action: _ignored, ...rest } = args;
    return { action: group.actions[requested]!, args: rest, deprecated: null };
  }
  return { action: name, args, deprecated: deprecationFor(name) };
}

export function hidesFromCaller(name: string, context: Pick<GraphQLContext, 'viewer' | 'authMode' | 'isTrustedSystem'> | undefined): boolean {
  if (!HUMAN_ONLY_MCP_TOOLS.includes(name)) return false;
  if (!context) return false;
  if (context.authMode === 'agent-token') return true;
  return context.viewer?.actorKind === 'AGENT';
}
