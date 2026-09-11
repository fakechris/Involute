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
4. Claim before executing (\`work_claim\`); report attempts with \`run_report\`. The claim response issues \`suggested_branch\` — use it verbatim as your git branch name. Never invent branch names containing issue identifiers: a harness-issued name is the only reference the traceability guard trusts unconditionally.
5. Run complete is not work accepted. Moving to Done requires a human review, or the graded auto-accept gate when evidence is objectively CLEAR (e.g. PR merged, test exit 0). Agents still cannot mark Done.
6. Do not file local TODOs as work. If it is not worth a contract, keep it local.
7. Pass \`expected_revision\` on updates; conflicts mean someone moved first — re-read.
8. Every production code modification MUST be bound to an Involute work item (INV-xxx). Unlinked PRs are blocked by CI offline lint and synchronized via GitHub Webhooks.

## Three-Layer Defense Pyramid (三层防御金字塔)

1. **Layer 1: Deterministic Engine Guardrail (Branch-First Convention & CI Offline Lint)**
   - Zero-touch local developer environment: local git commits are completely non-blocking and work offline.
   - Work branch naming convention (e.g. \`feat/INV-xxx-slug\`) or PR title linkage (e.g. \`feat: [INV-xxx] description\`).
   - PR gate enforced purely offline in CI via \`scripts/ci-pr-lint.sh\`; asynchronous GitHub Webhooks reconcile status to Involute kernel.
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
3. **Codebase Reality Alignment & Candidate Initial State (现状与代码真实进度对齐)**:
   - Pass \`initial_state: 'REVIEW' | 'STARTED' | 'UNSTARTED' | 'BACKLOG'\` when calling \`work_propose\`.
   - Historical working features passing tests must be proposed with \`initial_state: 'REVIEW'\` so they advance directly to **\`In Review\`** upon human commitment.
   - Active in-progress work uses \`initial_state: 'STARTED'\` (**\`In Progress\`**).
   - Truly unstarted work committed for the immediate active cycle uses \`initial_state: 'UNSTARTED'\` (**\`Ready\`**).
   - Future roadmap items, subsequent milestones (M2+), tech debt, or unscheduled tasks use \`initial_state: 'BACKLOG'\` (**\`Backlog\`**).
   - Candidates can NEVER be proposed with \`COMPLETED\` (\`Done\`) or \`CANCELED\`; agents stop at In Review.

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
- \`work_propose\` — create candidate work. Pass \`parent_id\` to nest under project/milestone. Pass \`initial_state: 'REVIEW' | 'STARTED' | 'UNSTARTED' | 'BACKLOG'\` to direct-route upon human commitment.
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

## First-Time Onboarding Blueprint (首次接入黄金规范)

When connecting a repository to Involute for the first time:
1. **Strict 3-Tier Hierarchy (严谨三层拓扑)**:
   - Root: One \`kind: 'PROJECT'\` matching \`<owner/repo>\`.
   - Mid-tier: Delivery phases as \`kind: 'MILESTONE'\` linked via \`CONTAINS\`.
   - Leaf-tier: Independently acceptable units as \`kind: 'ISSUE'\` linked to milestone via \`CONTAINS\` (pass \`parent_id: <MILESTONE_ID>\`). No orphan issues.
2. **Mandatory Rich Structured Chinese Descriptions (强制提供结构化中文详细描述)**:
   - Absolute prohibition: \`description: null\`, empty text, or brief links like \`ref docs/foo.md\`.
   - Every proposal MUST structure \`description\` with:
     - \`### 1. 目标与架构定位\`
     - \`### 2. 核心功能与交付范围\`
     - \`### 3. 验收标准与验证方案\`
   - Title MUST NOT contain \`[已交付]\` or \`[待办]\` status tags.
3. **Codebase Reality Alignment (现状与代码真实进度对齐)**:
   - **Direct State Assignment via \`initial_state\`**:
     - For historical features already implemented and passing tests: pass \`initial_state: 'REVIEW'\` during \`work_propose\`. Upon human commitment, they land directly in **In Review**.
     - For in-flight tasks, pass \`initial_state: 'STARTED'\` (**In Progress**).
     - For genuinely unstarted work in the immediate active cycle: pass \`initial_state: 'UNSTARTED'\` (**Ready**).
     - For future milestones (M2+), technical debt, or unscheduled tasks: pass \`initial_state: 'BACKLOG'\` (**Backlog**).
     - Never propose \`COMPLETED\` or \`CANCELED\`; candidate \`initial_state\` stops at In Review.
4. **Run Reporting Rule (新建 Run 规则)**:
   - When calling \`run_report\` to start a new run, **OMIT \`run_id\`**. The server assigns the run ID.
   - Do NOT pass \`claim.id\` or client-generated UUID as \`run_id\`.


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
