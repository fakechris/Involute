import { describe, expect, it } from 'vitest';

import { listMcpActions, WRITE_MCP_TOOLS, type McpToolDefinition } from './mcp-tools.ts';
import { createGraphQLSchema } from './schema.ts';

// INV-795: the MCP tools and the GraphQL mutations the web app uses are kept by
// hand. They drifted: work_update could write the contract, IssueUpdateInput
// could not (INV-786), so a person had no way to do what agents were told to
// ask a person for. Every field an agent can write must be writable through
// GraphQL, or be listed below with the reason it is agent-only.

import {
  PAIRS, AGENT_ONLY_TOOLS, RENAMED, AGENT_ONLY_FIELDS, MCP_EXEMPTIONS, GRAPHQL_ONLY_FIELDS, actionCapabilities,
  READ_PAIRS, AGENT_ONLY_READ_TOOLS, QUERY_EXEMPTIONS, FIELD_TYPE_EXCEPTIONS,
} from './action-capabilities.ts';

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

type JsonSchemaProperty = { type?: string | string[]; enum?: Array<string | null>; items?: { type?: string } };

// The schema's graphql module may be another instance than this file's, so
// types are read structurally (ofType, name, getValues) rather than with
// graphql's type guards.
type GqlType = { ofType?: GqlType; name?: string; getValues?: () => Array<{ name: string }>; getFields?: () => Record<string, { type: GqlType }>; toString(): string };
const unwrap = (type: GqlType): GqlType => (type.ofType ? unwrap(type.ofType) : type);
const isNonNull = (type: GqlType) => String(type).endsWith('!');
const isList = (type: GqlType) => String(type).startsWith('[');

/** The GraphQL type (argument or input-object field) a MCP property maps to, or null. */
function graphqlFieldType(mutations: Fields, mutation: string, field: string): GqlType | null {
  for (const arg of (mutations[mutation]?.args ?? []) as ReadonlyArray<{ name: string; type: GqlType }>) {
    if (arg.name === field) return arg.type;
    const inner = unwrap(arg.type).getFields?.()[field];
    if (inner) return inner.type;
  }
  return null;
}

/**
 * Why a MCP property's JSON schema type does not fit its GraphQL type (INV-1004):
 * strings go with String / ID / enums / custom scalars, numbers with Int / Float,
 * booleans with Boolean, arrays with lists, objects with String-encoded JSON;
 * an enum on both sides must list the same values.
 */
function typeMismatch(property: JsonSchemaProperty, graphqlType: GqlType): string | null {
  const jsonTypes = (Array.isArray(property.type) ? property.type : [property.type ?? 'string']).filter((type) => type !== 'null');
  const json = jsonTypes[0] ?? 'string';
  const type = isNonNull(graphqlType) ? graphqlType.ofType! : graphqlType;
  if ((json === 'array') !== isList(type)) return `${json} vs ${String(graphqlType)}`;
  // A list: its items must fit the list's element type.
  if (json === 'array') {
    const why = typeMismatch(property.items ?? {}, type.ofType!);
    return why ? `array of ${why}` : null;
  }
  const named = unwrap(type);
  if (typeof named.getValues === 'function') {
    if (property.enum) {
      const values = named.getValues().map((value) => value.name).sort();
      // A nullable enum lists null too (so strict clients accept clearing it); GraphQL says that with a nullable type.
      const ours = property.enum.filter((value): value is string => value !== null).sort();
      if (values.join() !== ours.join()) return `enum {${ours.join('|')}} vs ${named.name} {${values.join('|')}}`;
    } else if (json !== 'string') return `${json} vs enum ${named.name}`;
    return null;
  }
  const family: Record<string, string[]> = {
    string: ['String', 'ID', 'DateTime', 'JSON'],
    integer: ['Int', 'Float'],
    number: ['Int', 'Float'],
    boolean: ['Boolean'],
    object: ['String', 'JSON'],
  };
  return (family[json] ?? []).includes(named.name ?? '') ? null : `${json} vs ${String(graphqlType)}`;
}

/** Paired MCP properties whose type does not fit the GraphQL field's, with no stated exception (or all of them, with `includeExcepted`). */
function fieldTypeMismatches(tool: McpToolDefinition, mutations: Fields, includeExcepted = false): string[] {
  const mutation = PAIRS[tool.name]!;
  const properties = (tool.inputSchema as { properties?: Record<string, JsonSchemaProperty> }).properties ?? {};
  const mismatches: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (AGENT_ONLY_FIELDS[tool.name]?.[name] || (!includeExcepted && FIELD_TYPE_EXCEPTIONS[tool.name]?.[name])) continue;
    const graphqlType = graphqlFieldType(mutations, mutation, RENAMED[tool.name]?.[name] ?? camel(name));
    if (!graphqlType) continue;
    const why = typeMismatch(property, graphqlType);
    if (why) mismatches.push(`${tool.name}.${name} → ${mutation}: ${why}`);
  }
  return mismatches;
}

/** GraphQL queries with neither a MCP read tool nor an exemption, and stale entries. */
function queryCoverageProblems(queries: Record<string, unknown>, readTools: Set<string>): string[] {
  const paired = new Set(Object.values(READ_PAIRS).flat());
  const problems = Object.keys(queries).filter((name) => !paired.has(name) && !QUERY_EXEMPTIONS[name]).map((name) => `query ${name} has no MCP read tool and no exemption`);
  for (const [tool, names] of Object.entries(READ_PAIRS)) {
    if (!readTools.has(tool)) problems.push(`READ_PAIRS names ${tool}, which is not a read-only MCP tool`);
    for (const name of names) if (!queries[name]) problems.push(`READ_PAIRS ${tool} → ${name}: no such query`);
  }
  for (const name of Object.keys(QUERY_EXEMPTIONS)) if (!queries[name] || paired.has(name)) problems.push(`QUERY_EXEMPTIONS ${name} is stale`);
  for (const tool of readTools) if (!READ_PAIRS[tool] && !AGENT_ONLY_READ_TOOLS[tool]) problems.push(`read tool ${tool} has no GraphQL query and no agent-only reason`);
  return problems;
}

const DECISION_ID = /^INV-\d+$/;

function missingInMcp(tool: McpToolDefinition, mutations: Fields): string[] {
  const mutation = PAIRS[tool.name]!;
  const properties = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
  const mapped = new Set(properties.map((field) => RENAMED[tool.name]?.[field] ?? camel(field)));
  return [...graphqlFieldNames(mutations, mutation)].filter((field) => field !== 'input' && !mapped.has(field) && !GRAPHQL_ONLY_FIELDS[mutation]?.[field]);
}

describe('MCP and GraphQL write inputs (INV-795)', () => {
  const mutations = createGraphQLSchema(null as never).getMutationType()!.getFields() as unknown as Fields;
  const tools = listMcpActions(false);

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

  // INV-1004: the read side, field semantics and the decisions behind exemptions.
  const queries = createGraphQLSchema(null as never).getQueryType()!.getFields() as unknown as Record<string, unknown>;
  const readTools = new Set(listMcpActions(false).filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name));

  it('pairs every GraphQL query with a MCP read tool or an exemption, and every read tool with a query', () => {
    expect(queryCoverageProblems(queries, readTools)).toEqual([]);
  });

  it('reports a query added without a MCP read tool', () => {
    expect(queryCoverageProblems({ ...queries, widgetReport: {} }, readTools)).toEqual(['query widgetReport has no MCP read tool and no exemption']);
  });

  it('types every paired field the same way on both surfaces', () => {
    const drift = tools.filter((tool) => PAIRS[tool.name]).flatMap((tool) => fieldTypeMismatches(tool, mutations));
    expect(drift).toEqual([]);
    // An exception stays only while the types really differ; once they match it would hide later drift.
    for (const [toolName, fields] of Object.entries(FIELD_TYPE_EXCEPTIONS)) {
      const tool = tools.find((candidate) => candidate.name === toolName)!;
      const stillDiffer = fieldTypeMismatches(tool, mutations, true);
      for (const field of Object.keys(fields)) expect(stillDiffer.some((entry) => entry.startsWith(`${toolName}.${field} `)), `${toolName}.${field} stale type exception`).toBe(true);
    }
  });

  it('reports a field typed differently on the two surfaces', () => {
    const workUpdate = tools.find((tool) => tool.name === 'work_update')!;
    const retyped = {
      ...workUpdate,
      inputSchema: { ...workUpdate.inputSchema, properties: { ...(workUpdate.inputSchema as { properties: object }).properties, priority: { type: 'string' } } },
    } as McpToolDefinition;
    expect(fieldTypeMismatches(retyped, mutations)).toEqual(['work_update.priority → issueUpdate: string vs Int']);
    const retypedItems = { ...retyped, inputSchema: { ...retyped.inputSchema, properties: { label_ids: { type: 'array', items: { type: 'integer' } } } } } as McpToolDefinition;
    expect(fieldTypeMismatches(retypedItems, mutations)).toEqual(['work_update.label_ids → issueUpdate: array of integer vs String!']);
    const mistypedEnum = { ...retyped, inputSchema: { ...retyped.inputSchema, properties: { kind: { type: 'string', enum: ['ISSUE', 'WIDGET'] } } } } as McpToolDefinition;
    expect(fieldTypeMismatches(mistypedEnum, mutations)).toHaveLength(1);
  });

  it('names the decision behind every exemption', () => {
    const undecided = [
      ...Object.entries(MCP_EXEMPTIONS).filter(([, entry]) => !DECISION_ID.test(entry.decision)).map(([name]) => `mutation ${name}`),
      ...Object.entries(QUERY_EXEMPTIONS).filter(([, entry]) => !DECISION_ID.test(entry.decision)).map(([name]) => `query ${name}`),
    ];
    expect(undecided).toEqual([]);
    expect(DECISION_ID.test('')).toBe(false);
    expect(DECISION_ID.test('because')).toBe(false);
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
