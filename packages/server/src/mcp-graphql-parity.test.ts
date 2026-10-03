import { describe, expect, it } from 'vitest';

import { listMcpTools, WRITE_MCP_TOOLS, type McpToolDefinition } from './mcp-tools.ts';
import { createGraphQLSchema } from './schema.ts';

// INV-795: the MCP tools and the GraphQL mutations the web app uses are kept by
// hand. They drifted: work_update could write the contract, IssueUpdateInput
// could not (INV-786), so a person had no way to do what agents were told to
// ask a person for. Every field an agent can write must be writable through
// GraphQL, or be listed below with the reason it is agent-only.

import { PAIRS, AGENT_ONLY_TOOLS, RENAMED, AGENT_ONLY_FIELDS, MCP_EXEMPTIONS, GRAPHQL_ONLY_FIELDS, actionCapabilities } from './action-capabilities.ts';

const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

type Fields = Record<string, { args: ReadonlyArray<{ name: string; type: unknown }> }>;

/** Argument names plus the fields of any input object argument. */
function graphqlFieldNames(mutations: Fields, mutation: string): Set<string> {
  const names = new Set<string>();
  for (const arg of mutations[mutation]?.args ?? []) {
    names.add(arg.name);
    let type = arg.type as { ofType?: unknown; getFields?: () => Record<string, unknown> };
    while (type.ofType) type = type.ofType as typeof type;
    if (typeof type.getFields === 'function') Object.keys(type.getFields()).forEach((field) => names.add(field));
  }
  return names;
}

/** MCP arguments of `tool` with no GraphQL field and no stated reason. */
function missingInGraphQL(tool: McpToolDefinition, mutations: Fields): string[] {
  const graphql = graphqlFieldNames(mutations, PAIRS[tool.name]!);
  const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  return properties.filter((property) => {
    if (AGENT_ONLY_FIELDS[tool.name]?.[property]) return false;
    return !graphql.has(RENAMED[tool.name]?.[property] ?? camel(property));
  });
}

function missingInMcp(tool: McpToolDefinition, mutations: Fields): string[] {
  const mutation = PAIRS[tool.name]!;
  const properties = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
  const mapped = new Set(properties.map((field) => RENAMED[tool.name]?.[field] ?? camel(field)));
  return [...graphqlFieldNames(mutations, mutation)].filter((field) => field !== 'input' && !mapped.has(field) && !GRAPHQL_ONLY_FIELDS[mutation]?.[field]);
}

describe('MCP and GraphQL write inputs (INV-795)', () => {
  const mutations = createGraphQLSchema(null as never).getMutationType()!.getFields() as unknown as Fields;
  const tools = listMcpTools(false);

  it('pairs every MCP write tool with a GraphQL mutation or says why it is agent-only', () => {
    const unpaired = WRITE_MCP_TOOLS.filter((name) => !PAIRS[name] && !AGENT_ONLY_TOOLS[name]);
    expect(unpaired).toEqual([]);
    expect(Object.values(PAIRS).filter((mutation) => !mutations[mutation])).toEqual([]);
  });

  it('lets GraphQL write every field an agent can write through MCP', () => {
    const drift = tools
      .filter((tool) => PAIRS[tool.name])
      .flatMap((tool) => missingInGraphQL(tool, mutations).map((field) => `${tool.name}.${field} → ${PAIRS[tool.name]}`));
    expect(drift).toEqual([]);
  });

  it('has no stale renames or exemptions', () => {
    const stale: string[] = [];
    for (const [toolName, fields] of [...Object.entries(RENAMED), ...Object.entries(AGENT_ONLY_FIELDS)]) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      const properties = Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
      for (const field of Object.keys(fields)) if (!properties.includes(field)) stale.push(`${toolName}.${field}`);
    }
    expect(stale).toEqual([]);
  });

  it('covers every GraphQL mutation in the reverse direction with a tool or explicit exemption', () => {
    const paired = new Set(Object.values(PAIRS));
    expect(Object.keys(mutations).filter((name) => !paired.has(name) && !MCP_EXEMPTIONS[name])).toEqual([]);
    expect(Object.keys(MCP_EXEMPTIONS).filter((name) => !mutations[name] || paired.has(name))).toEqual([]);
    for (const action of actionCapabilities().filter((item) => item.mcpTool)) {
      expect(action.prerequisites?.length, action.mutation ?? action.mcpTool!).toBeGreaterThan(0);
      for (const field of ['permission', 'concurrency', 'receipt', 'recovery', 'humanGate'] as const) expect(action[field], `${action.mutation}.${field}`).toBeTruthy();
    }
  });

  it('covers every GraphQL input field through MCP or an explicit field exemption', () => {
    const missing: string[] = [];
    for (const [toolName, mutation] of Object.entries(PAIRS)) {
      const tool = tools.find((item) => item.name === toolName)!;
      missing.push(...missingInMcp(tool, mutations).map((field) => `${mutation}.${field}`));
      for (const field of Object.keys(GRAPHQL_ONLY_FIELDS[mutation] ?? {})) expect(graphqlFieldNames(mutations, mutation).has(field), `${mutation}.${field} stale exemption`).toBe(true);
    }
    expect(missing).toEqual([]);
  });

  it('detects removal of the agent parent editor while the UI field still exists', () => {
    const tool = tools.find((item) => item.name === 'work_update')!;
    const properties = { ...(tool.inputSchema as { properties: Record<string, unknown> }).properties };
    delete properties.parent_id;
    expect(missingInMcp({ ...tool, inputSchema: { ...tool.inputSchema, properties } }, mutations)).toEqual(['parentId']);
  });

  it('reports a field added to an MCP tool but not to GraphQL', () => {
    const workUpdate = tools.find((tool) => tool.name === 'work_update')!;
    const widened = {
      ...workUpdate,
      inputSchema: {
        ...workUpdate.inputSchema,
        properties: { ...(workUpdate.inputSchema as { properties: object }).properties, due_date: { type: 'string' } },
      },
    } as McpToolDefinition;
    expect(missingInGraphQL(widened, mutations)).toEqual(['due_date']);
  });
});
