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
3. Committed work is created by a human (\`work_commit\`) or authorized batch delegation (\`pnpm candidates:batch-commit\`). Agents never unilaterally commit.
4. Claim before executing (\`work_claim\`); report attempts with \`run_report\`.
5. Run complete is not work accepted. Moving to Done requires a human review, or the graded auto-accept gate when evidence is objectively CLEAR (e.g. PR merged, test exit 0). Agents still cannot mark Done.
6. Do not file local TODOs as work. If it is not worth a contract, keep it local.
7. Pass \`expected_revision\` on updates; conflicts mean someone moved first — re-read.
8. Every production code modification MUST be bound to an Involute work item (INV-xxx). Unlinked changes are blocked by the Layer 1 Git guardrail.

## Three-Layer Defense Pyramid (三层防御金字塔)

1. **Layer 1: Deterministic Engine Guardrail (Git Commit / PR Hook)**
   - Hard enforcement via \`scripts/verify-work-graph.sh\` and \`.githooks/commit-msg\`.
   - Any commit modifying core source code (\`packages/*/src\`) must reference a valid \`INV-xxx\` identifier. Unlinked code is blocked at the door.
2. **Layer 2: Defensive Contract / Schema Layer (Explicit \`parent_id\`)**
   - When proposing hierarchical work, supply \`parent_id\` directly in \`work_propose\`.
   - Eliminates relationship inversion bugs and guarantees top-down \`CONTAINS\` linking.
3. **Layer 3: Cognitive Reflex (Unplanned Work & Hotfix Protocol)**
   - When modifying code outside the currently claimed task (e.g. bugfix / shared lib fix):
     1. Momentum First: Implement fix locally and verify with tests.
     2. Automatic Closure: Run \`pnpm hotfix:reflex --title "Fix description" --parent <INV-xxx>\` or propose candidate linked with \`DISCOVERED_DURING\`.
     3. Mandatory structured Chinese description.
     4. Reporting accountability: notify user with the created identifier.

## First-Time Onboarding Blueprint (首次接入黄金规范)

1. **Strict 3-Tier Hierarchy**: Root \`kind: 'PROJECT'\` (<owner/repo>) -> Mid-tier \`kind: 'MILESTONE'\` -> Leaf-tier \`kind: 'ISSUE'\`.
2. **Mandatory Rich Structured Chinese Descriptions**:
   Every proposal MUST contain:
   - \`### 1. 目标与架构定位\`: System role, rationale.
   - \`### 2. 核心功能与交付范围\`: Specific modules, UI components, APIs.
   - \`### 3. 验收标准与验证方案\`: Concrete vitest/jest commands, exit 0 criteria.
3. **Codebase Reality Alignment**:
   Historical working features passing tests must be advanced via \`work_claim\` -> \`run_report(completed)\` -> \`evidence_attach\` to **\`In Review\`**. Only genuinely unstarted work remains in \`Ready\`.

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
| \`read\` | \`work_search\`, \`work_get_context\`, \`work_list_ready\`, \`protocol_get_guide\` (always granted) |
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

- \`CONTAINS\` — project/milestone hierarchy (prefer passing \`parent_id\` to establish)
- \`BLOCKS\` — dependency; ready work has no incoming \`BLOCKS\` from unresolved work
- \`DERIVED_FROM\`, \`DISCOVERED_DURING\`, \`RELATED_TO\`, \`DUPLICATE_OF\`

## MCP tools

Read-only:
- \`work_search\` — search by identifier, title, description, or IQL filter.
- \`work_get_context\` — load full contract bundle, ancestors, blockers, active claim, and audits.
- \`work_list_ready\` — list committed, unblocked, unclaimed work in urgency order.
- \`protocol_get_guide\` — fetch this document verbatim.

Write:
- \`work_propose\` — create candidate work. Pass \`parent_id\` to nest under project/milestone.
- \`work_update\` — update contract fields with \`expected_revision\`.
- \`work_link\` — create typed work link.
- \`work_claim\` — atomically claim committed work for the current agent actor.
- \`run_report\` — report run status (queued / running / blocked / completed). Completed moves to In Review.
- \`evidence_attach\` — attach PR, test, log, or artifact URL to a run.

Human-only (delegated CLI or Web UI):
- \`work_commit\` / \`pnpm candidates:batch-commit\`
- \`work_reject\`
- \`work_review\`

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
