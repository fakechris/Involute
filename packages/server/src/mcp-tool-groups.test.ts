import { describe, expect, it } from 'vitest';

import { HUMAN_ONLY_MCP_TOOLS, MCP_TOOL_GROUPS, resolveMcpCall } from './mcp-tool-groups.ts';
import { listMcpActions, listMcpTools } from './mcp-tools.ts';

// INV-1046: agents see at most twenty tools, none they can never run; every
// action stays reachable, old names stay callable with a deprecation note.
const agent = { viewer: { actorKind: 'AGENT' } as never, authMode: 'agent-token' as const, isTrustedSystem: false };
const human = { viewer: { actorKind: 'HUMAN' } as never, authMode: 'token' as const, isTrustedSystem: false };

describe('MCP tool groups', () => {
  it('lists at most twenty tools for an agent credential, without the human-only ones', () => {
    const tools = listMcpTools(false, agent);
    expect(tools.length).toBeLessThanOrEqual(20);
    const names = tools.map((tool) => tool.name);
    for (const name of HUMAN_ONLY_MCP_TOOLS) expect(names).not.toContain(name);
    expect(listMcpTools(false, human).map((tool) => tool.name)).toEqual(expect.arrayContaining([...HUMAN_ONLY_MCP_TOOLS]));
  });

  it('keeps every action reachable and names each group member exactly once', () => {
    const actions = new Set(listMcpActions(false).map((tool) => tool.name));
    const seen = new Map<string, string>();
    for (const group of MCP_TOOL_GROUPS) {
      for (const [action, member] of Object.entries(group.actions)) {
        expect(actions.has(member), `${group.name}.${action} → ${member}`).toBe(true);
        expect(seen.has(member), `${member} in two groups`).toBe(false);
        seen.set(member, group.name);
      }
    }
    const reachable = new Set(listMcpTools(false, human).flatMap((tool) => tool.actions));
    for (const action of actions) {
      if (action === 'notification_mark_read' || action === 'work_read_page') continue;
      expect(reachable.has(action), action).toBe(true);
    }
  });

  it('builds a grouped schema with the action enum and each member argument tagged by action', () => {
    const relate = listMcpTools(false, human).find((tool) => tool.name === 'work_relate')!;
    expect(relate.inputSchema.required).toEqual(['action']);
    expect((relate.inputSchema.properties.action as { enum: string[] }).enum).toEqual(['link', 'unlink']);
    expect((relate.inputSchema.properties.type as { 'x-actions': string[] })['x-actions']).toEqual(['link', 'unlink']);
    expect(relate.annotations.destructiveHint).toBe(true);
    const claim = listMcpTools(false, human).find((tool) => tool.name === 'work_claim')!;
    expect(claim.inputSchema.required).toBeUndefined(); // default action keeps the old call shape
    // The read-only endpoint shows a group with its read-only actions only.
    const executor = listMcpTools(true).find((tool) => tool.name === 'executor')!;
    expect(executor.actions).toEqual(['work_executor_context']);
    expect(executor.annotations.readOnlyHint).toBe(true);
  });

  it('resolves grouped calls, defaults, legacy names and folded names', () => {
    expect(resolveMcpCall('work_relate', { action: 'unlink', from_id: 'a' })).toEqual({ action: 'work_unlink', args: { from_id: 'a' }, deprecated: null });
    expect(resolveMcpCall('work_claim', { id: 'x' }).action).toBe('work_claim');
    expect(resolveMcpCall('evidence', { run_id: 'r' }).action).toBe('evidence_attach');
    expect(() => resolveMcpCall('work_relate', { from_id: 'a' })).toThrow(/needs action/);
    expect(() => resolveMcpCall('work_view', { action: 'rename' })).toThrow(/needs action/);
    const legacy = resolveMcpCall('work_link', { from_id: 'a' });
    expect(legacy.action).toBe('work_link');
    expect(legacy.deprecated).toContain('work_relate');
    expect(resolveMcpCall('notification_mark_read', { id: 'n' }).deprecated).toContain('agent_inbox');
    expect(resolveMcpCall('work_read_page', { id: 'n' }).deprecated).toContain('work_get_context');
    expect(resolveMcpCall('work_search', { query: 'q' }).deprecated).toBeNull();
  });
});
