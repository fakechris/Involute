import { describe, expect, it } from 'vitest';

import { listMcpTools, WRITE_MCP_TOOLS, type McpToolDefinition } from './mcp-tools.ts';
import { createGraphQLSchema } from './schema.ts';

// INV-795: the MCP tools and the GraphQL mutations the web app uses are kept by
// hand. They drifted: work_update could write the contract, IssueUpdateInput
// could not (INV-786), so a person had no way to do what agents were told to
// ask a person for. Every field an agent can write must be writable through
// GraphQL, or be listed below with the reason it is agent-only.

/** MCP write tool → the GraphQL mutation a person (the web app) uses for the same change. */
const PAIRS: Record<string, string> = {
  agent_request_answer: 'agentRequestAnswer',
  evidence_attach: 'evidenceAttach',
  run_report: 'runReport',
  work_claim: 'workClaim',
  work_commit: 'workCommit',
  work_file_bug: 'bugReport',
  work_link: 'workLink',
  work_propose: 'workPropose',
  work_update: 'issueUpdate',
};

/** MCP write tools with no GraphQL counterpart, and why. */
const AGENT_ONLY_TOOLS: Record<string, string> = {
  agent_request_claim: 'Agents lease a request before answering it; a person answers directly (agentRequestAnswer).',
};

/** MCP argument → GraphQL field when the names differ. */
const RENAMED: Record<string, Record<string, string>> = {
  agent_request_answer: { id: 'requestId' },
  run_report: { pr_number: 'pullRequestNumber' },
  work_file_bug: { team: 'teamId' },
  work_propose: { team: 'teamId' },
  work_update: { state: 'stateId' },
};

/** MCP arguments with no GraphQL field, and why a person does not need them. */
const AGENT_ONLY_FIELDS: Record<string, Record<string, string>> = {
  agent_request_answer: {
    claim_token: 'Proves the answering execution holds the request lease; a person does not lease requests.',
    session_id: 'Identifies the agent execution that answers.',
    receipt: 'Agent decision receipt (INV-588); a person\'s answer is the comment itself.',
    evidence: 'Agent-attached references backing its answer.',
    state: 'INV-794 tracks letting a person answer "failed" or "input-required"; until then a person always completes.',
  },
  run_report: { receipt: 'Agent decision receipt (INV-588); people do not report runs.' },
  work_file_bug: {
    related_work_id: 'Agents file a bug they found while working on another item (DISCOVERED_DURING).',
    related_work_type: 'Agents file a bug they found while working on another item (DISCOVERED_DURING).',
    initial_state: 'An agent that fixed the bug on the spot files it straight into Review.',
    idempotency_key: 'Lets an agent retry a filing without duplicating it; the web app submits once.',
    source: 'Tags where an agent found the bug; a person\'s report is tagged bug-report by the server.',
  },
};

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
