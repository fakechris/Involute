import { WORK_EVENT_TYPES } from './event-outbox.js';

// Shared, single-source protocol description served to agents through three
// surfaces: the MCP `protocol_get_guide` tool, `GET /llms.txt`, and
// `GET /llms-full.txt`. Keep it free of deployment-specific secrets.
export function buildProtocolGuide(baseUrl = ''): string {
  return `# Involute work protocol

Involute is an agent-native project-state and work-graph kernel. Agents are the
primary entrypoint; the web board is an observation and governance surface.

## Kernel rules

1. Search before creating work. Duplicates are noise.
2. Fuzzy discoveries enter as candidates (\`work_propose\`), never as committed work.
3. Committed work is created by a human (\`work_commit\`). Agents never commit.
4. Claim before executing (\`work_claim\`); report attempts with \`run_report\`.
5. Run complete is not work accepted. Moving to Done requires a human review, or the graded auto-accept gate when evidence is objectively CLEAR (e.g. PR merged, test exit 0). Agents still cannot mark Done.
6. Do not file local TODOs as work. If it is not worth a contract, keep it local.
7. Pass \`expected_revision\` on updates; conflicts mean someone moved first — re-read.

## Endpoints

- \`POST ${baseUrl}/mcp\` — read-write MCP (JSON-RPC, protocol 2025-03-26)
- \`POST ${baseUrl}/mcp/readonly\` — read-only MCP (search, context, ready work)
- \`GET ${baseUrl}/health\` — process liveness
- \`GET ${baseUrl}/llms.txt\` — this index; \`GET ${baseUrl}/llms-full.txt\` — full text
- \`GET ${baseUrl}/docs/api.md\` — full HTTP and GraphQL API reference

## Authentication

| Mode | Where | Credential |
|---|---|---|
| Browser session | web UI, \`/graphql\` | Google OAuth + session cookie |
| Agent token | \`/mcp*\` only | \`inv_agent_...\` token, sha256-hashed at rest, scoped |
| Trusted bearer | CLI/dev flows, all surfaces | shared \`AUTH_TOKEN\`, full access |
| Viewer assertion | CLI/dev impersonation | HMAC-signed short-lived assertion |

Agent credentials carry scopes. Scope enforcement happens on MCP tools:

| Scope | Unlocks |
|---|---|
| \`read\` | \`work_search\`, \`work_get_context\`, \`work_list_ready\` (always granted) |
| \`propose\` | \`work_propose\` |
| \`update\` | \`work_update\` |
| \`link\` | \`work_link\` |
| \`claim\` | \`work_claim\` |
| \`report\` | \`run_report\`, \`evidence_attach\` |

\`work_commit\` has no scope: it is gated on actor kind (humans only), not tokens.

## Four state machines (do not collapse them)

| Machine | Meaning |
|---|---|
| \`commitmentStatus\` | candidate / committed / rejected |
| Workflow state | Backlog-group → Ready-group → Started-group → Review-group → Done/Canceled |
| Claim + Run | who is executing this attempt and whether the attempt finished |
| Local \`task_plan.md\` | agent working memory; never stored as Involute work |

Workflow states are team-specific rows grouped by a closed enum
(\`BACKLOG / UNSTARTED / STARTED / REVIEW / COMPLETED / CANCELED\`). Refer to
states by name or group, never by row id.

## Work graph

Work nodes carry a delivery contract (\`outcome\`, \`scope\`, \`constraints\`,
\`acceptance\`, \`verification\`) and typed links:

- \`CONTAINS\` — project/milestone hierarchy
- \`BLOCKS\` — dependency; ready work has no incoming \`BLOCKS\` from unresolved work
- \`DERIVED_FROM\`, \`DISCOVERED_DURING\`, \`RELATED_TO\`, \`DUPLICATE_OF\`

## MCP tools

Read-only: \`work_search\`, \`work_get_context\`, \`work_list_ready\`, \`protocol_get_guide\`.
Write: \`work_propose\`, \`work_update\`, \`work_link\`, \`work_claim\`,
\`run_report\`, \`evidence_attach\`. Human-only (no agent tool): \`work_commit\`,
\`work_reject\`, \`work_review\`.

Call \`protocol_get_guide\` on the MCP endpoint to fetch this document verbatim.

## Webhook events

Subscriptions receive signed HTTP POST deliveries. Signature header:
\`involute-signature: sha256=<hmac-sha256 of raw body with the subscription secret>\`.
Also present: \`involute-event\` (type), \`involute-event-id\` (stable id for
receiver dedupe), \`involute-delivery\` (unique per attempt), \`involute-attempt\`.

Event types: ${WORK_EVENT_TYPES.join(', ')}.

Delivery retries use exponential backoff (1m, 5m, 30m, 2h, 10h, ±20% jitter).
4xx responses (except 408/429) are not retried. Subscriptions that keep
exhausting every delivery are disabled automatically.

## Query language (IQL)

List and search endpoints accept an optional \`query\` string: space-separated
terms, \`field:value\` with optional comparison (\`priority:>=2\`,
\`updated:>30d\`), negation (\`-state:done\`). Fields: \`team\`, \`state\`,
\`state-type\`, \`kind\`, \`commitment\`, \`assignee\`, \`label\`, \`priority\`,
\`updated\`, \`link\`, \`has\`. Bare words match title/description.
`;
}
