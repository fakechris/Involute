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
3. Committed work is created by a human (\`work_commit\`) or authorized batch delegation (\`pnpm candidates:batch-commit\`). Agents never unilaterally commit. The decision reaches the proposer: it appears in \`agent_inbox\` \`notifications\` (\`work.committed\`, \`work.rejected\` with the reason and its resolution (INV-1118), \`work.uncommitted\`, review outcomes, and \`delivery.approved\` / \`delivery.declined\` for a delivery authorization — start on \`delivery.approved\`) — read it there, or read \`commitmentStatus\`, before telling anyone a candidate is still waiting (INV-968). A long-running agent need not poll: a webhook created with \`agent: <your handle>\` (Ops page or \`webhookCreate\`) is your push channel and delivers exactly those inbox events, plus dispatches addressed to you (INV-992).
4. Claim before executing (\`work_claim\`); report attempts with \`run_report\`. The claim response issues \`suggested_branch\` — use it verbatim as your git branch name. Never invent branch names containing issue identifiers: a harness-issued name is the only reference the traceability guard trusts unconditionally.
5. Run complete is not work accepted. Self-reported PR/test summaries and URLs are unverified and require human review; they cannot trigger auto-accept. GitHub merge also stops at Review. Server verification is shadow-only, including CLEAR observations; only human review accepts work.
6. Do not file local TODOs as work. If it is not worth a contract, keep it local.
7. Ready project selectors accept a Work Graph PROJECT UUID/identifier or a legacy Project UUID. A PROJECT with a repository shares the repository query scope; a PROJECT without one uses its CONTAINS/parentId subtree. Ambiguous repository declarations or conflicting selectors fail. Ready stays all-kind unless explicitly filtered (e.g. kind:ISSUE).
8. Pass \`expected_revision\` on updates; conflicts mean someone moved first — re-read.
9. Every production code modification MUST be bound to an Involute work item (INV-xxx). Unlinked PRs are blocked by CI offline lint and synchronized via GitHub Webhooks.
10. A change that makes something a person's job (a rule refusing agents, a mutation, a notification sent to people) ships with the web screen where a person does it, registered in \`packages/server/src/human-surface.ts\`. A field agents can write through MCP must be writable through GraphQL too. \`human-surface.test.ts\` and \`mcp-graphql-parity.test.ts\` fail otherwise (INV-795).

## Discovering actions

Call \`work_catalog(kind: "capabilities")\` before planning a workflow. Its
\`actionCatalogVersion: 1\` describes each GraphQL mutation, its MCP counterpart
or explicit exemption, web control, input schema, field mappings, prerequisite
reads, permission boundary, concurrency checks, receipt and recovery path.
The tool availability flags describe this credential and endpoint; they do not
pre-authorize a particular work item. Re-read context and pass its current revision.
Candidate approval and final acceptance stay explicit human gates. Administrative
and personal controls have stated exemptions rather than an implied agent tool.
Use the existing MCP initialization and \`tools/list\` discovery after reconnecting;
the action catalog version is not a replacement for transport protocol negotiation.

## Binding and version diagnostics

Call \`protocol_get_guide(project_id, repository)\` for its machine-readable
\`protocol\` object: schema/work/MCP versions, build SHA, endpoint origin,
canonical project binding and credential scopes. Missing/unknown versions or build
identity are unknown, not success. Run \`involute doctor --project INV-79 --json\`
for versioned checks and remediation (exit 0 passed, 2 config/compatibility, 3 unavailable).
\`work_commit.state_id\` is a workflow state UUID from \`work_catalog(kind: states)\`,
not a state enum. Revision conflicts return a readable \`currentRevision\`; re-read
and reconcile, never blindly retry with the new revision.

## Execution leases (INV-943)

A work claim returns a secret \`claim_token\` and an execution label. Keep the token in execution secret state, never in logs, comments, receipts or Git. Pass it to renew a claim, report a run, attach evidence, release your own claim with \`work_claim(action: 'release')\`, or correct your own unaccepted evidence with \`evidence(action: 'retract')\`. Both corrections require a reason and preserve history. Actor identity alone cannot authorize a second session. Lease expiry requires a fresh claim; the new claim invalidates old execution writes. Completing a run releases the lease but permits evidence attachment until a subsequent claim supersedes it. A person can force-release from the Claim panel. Existing pre-token leases must expire or be released; their tokens cannot be recovered from context.

## Work-graph norm v1 (INV-718)

1. **Placement.** Every committed item except a PROJECT has exactly one parent; \`work_commit\` refuses otherwise. Legal CONTAINS: PROJECT → MILESTONE / DECISION / EPIC / ISSUE ("No milestone"), MILESTONE → EPIC / ISSUE, EPIC → ISSUE, ISSUE → ISSUE. Pass \`parent_id\`; DISCOVERED_DURING / DERIVED_FROM proposals without it inherit the related item's nearest legal same-repository ancestor.
2. **Relations.** Mentions of other work (\`INV-123\` or a project alias prefix) become RELATED_TO automatically. Dependencies the source material states must be BLOCKS (\`blocked_by\` / \`blocks\` on \`work_propose\`, or \`work_link\`). Never invent dependencies or structure.
3. **Preview before bulk.** Before proposing several related items, lay out the whole tree (parents, blockers) and check it; if the source is ambiguous, propose an outline for review instead of guessing.
4. **Research (Type: Research, INV-912).** Research / competitive analysis is an ISSUE labelled \`research\` (\`labels: ['research']\`) — the fourth Type beside Bug / Feature / Improvement; its body stays in \`research/\`. Its deliverable is the item itself, so it is the one kind of work an agent may close: propose it with \`initial_state: 'DONE'\` and it lands in Done when a person commits it, or move a committed research ISSUE to Done with \`work_update(state: 'DONE')\` — refused if it is not committed, not an ISSUE, claimed by another actor, or lacks the three-section description. Agents never set CANCELED, and everything else still stops at In Review. Actionable points are ISSUEs and "won't do" conclusions DECISIONs, each DERIVED_FROM the research item. Before research reaches Review, its downstream is proposed or it states "no actionable points"; otherwise \`run_report(completed)\` warns and \`workHygiene\` lists it.
5. **Bugs (Bug route v1, INV-748).** A bug is an ISSUE with the Type label \`Bug\` (\`labels: ['bug']\`, any casing). Type is one of Bug / Feature / Improvement / Research / Incident, at most one per item; a second Type is refused. An agent filing a bug (found itself or told by a person) must pass \`labels: ['bug']\`, \`priority\` (1–4) and \`steps_to_reproduce\`, plus a parent (\`parent_id\` or inherited): it is committed directly (decision INV-787) and **does not go to Candidates**. Missing any of those, the proposal is refused. Fixed on the spot: add \`initial_state: 'REVIEW'\` together with \`commit_sha\`, \`pr_number\` or \`evidence_url\` (and a \`summary\`); the server records the completed run and attaches the evidence, so the reviewer sees the fix (INV-997). Review filings without evidence are refused. Humans report through Report bug, which places the bug in its project or sends it to triage. Zero-bug (INV-750): a bug is committed with a priority — its SLA, Urgent 24h / High 48h / otherwise 7 days, paused in Review — or declined with a reason; it never goes to the backlog. Pass \`priority\` to \`work_commit\` for bugs. Severity (INV-1115) is separate and optional: \`severity\` SEV1 Critical / SEV2 Major / SEV3 Minor describes the impact you see on \`work_propose\`, \`work_file_bug\` and \`work_update\` (null clears it); unsure, pick the higher one. It never changes the SLA — priority does.
6. **Incidents (Type: Incident, INV-1123).** An incident — something happening or that happened and hurt users or the service — is an ISSUE with the Type label \`Incident\`. Declare it with \`work_propose\` and \`labels: ['incident']\` (any casing): \`severity\` (SEV1–SEV3) and an impact statement in \`description\` are required, plus a parent (\`parent_id\` or inherited). Like a bug it is committed directly and does not go to Candidates, but it starts In Progress (investigating); the person who owns you is the Incident Lead, and the team's people get \`incident.declared\`. Missing any of those, the declaration is refused. Not an incident, just broken? File a bug. Humans declare from the board with Report incident.

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
   - Candidates can NEVER be proposed with \`CANCELED\`, nor with \`COMPLETED\` (\`Done\`) unless they are a research ISSUE (Type: Research, INV-912), which lands in Done when a person commits it; all other work stops at In Review.

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
| \`read\` | \`work_catalog\`, \`work_search\`, \`work_get_context\` (with \`section\` for one paginated section), \`work_list_ready\`, \`work_timeline\` (the issue timeline, INV-1116), \`agent_inbox\`, \`protocol_get_guide\` (always granted) |
| \`propose\` | \`work_propose\`, \`work_file_bug\`, \`work_propose_amendment\`, \`work_timeline\` (action \`star\` / \`unstar\` a key event) |
| \`update\` | \`work_update\`, \`work_comment\` |
| \`link\` | \`work_relate\` (action \`link\` / \`unlink\`) |
| \`claim\` | \`work_claim\` (action \`claim\` / \`release\`) |
| \`report\` | \`run_report\`, \`evidence\` (action \`attach\` / \`retract\`) |

Tools are grouped (INV-1046): a pair or family is one tool with an \`action\` argument — \`work_relate\`, \`work_view\`, \`work_timeline\`, \`work_claim\`, \`evidence\`, \`agent_request\`, \`delivery\`, \`executor\`. Where a default is named, the old call shape still works (\`work_claim(id)\` claims). The old names (\`work_link\`, \`evidence_attach\`, \`work_claim_release\`, \`agent_request_claim\`, \`work_executor_update\`, …) stay callable for one version and answer with a \`deprecated\` note; \`notification_mark_read\` became \`agent_inbox(ack: [...])\` and \`work_read_page\` became \`work_get_context(id, section, after)\`. \`tools/list\` is cut to what the credential can run: an agent never sees \`work_commit\` / \`work_uncommit\`, which are gated on actor kind (humans only), not tokens.

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

- \`CONTAINS\` — PROJECT → MILESTONE/DECISION/EPIC/ISSUE, MILESTONE → EPIC/ISSUE, EPIC → ISSUE, ISSUE → ISSUE (sub-issues); both endpoints require matching explicit repositories. Every committed item except a PROJECT needs exactly one parent: commit is refused without one. Proposals linked DISCOVERED_DURING/DERIVED_FROM without parent_id inherit the related item's nearest legal ancestor. A second parent is rejected; use a revision-checked parent update to move work.
- \`BLOCKS\` — dependency; ready work has no incoming \`BLOCKS\` from unresolved work. When the source material says an item depends on / must come after another, record it: \`work_propose\` accepts \`blocked_by\` / \`blocks\`, or use \`work_link\`. Do not invent dependencies. \`work_commit\` warns when text reads like a dependency but no BLOCKS exists.
- Mentioning another item (\`INV-123\`, or a project alias prefix) in a description, contract field or comment records a \`RELATED_TO\` link automatically, unless the two are already linked; removing the mention keeps the link.
- \`DERIVED_FROM\`, \`DISCOVERED_DURING\`, \`RELATED_TO\`, \`DUPLICATE_OF\`
- \`DUPLICATE_OF\` (A → B, INV-1124) — when a person links it, an open A is closed (a candidate declined, committed work Canceled) with resolution \`duplicate\`; when an agent links it, A stays open and its owner is notified to decline it, because agents never close work. Both items get a note, and A's reporter is notified of B's later state changes. Removing the link does not reopen A.
- \`REGRESSED_BY\` (A → B, INV-1120) — B introduced the regression A reports or fixes. IQL \`link:regressed_by:INV-5\` lists what INV-5 regressed; \`link:regressed_by:none\` lists work with no regression source. Moving work from Done or Canceled back to an open state is a reopen: it is recorded and counted (\`reopenCount\`), and \`bugSummary.metrics\` reports the reopen rate and how many Auto-Accept Gate acceptances were reopened.

## MCP tools

Read-only:
- \`work_search\` — search through the same keyword, segmentation, full-text and semantic ranking as the UI. Pass \`paginate: true\` for \`{nodes, pageInfo}\`; repeat the same query/filter with \`after: pageInfo.endCursor\` while \`hasNextPage\`. Without pagination the legacy array is preserved. Pages are live, exclude previously returned IDs, recheck access, and expire after one hour. Semantic recall remains bounded by the shared search policy.
- \`work_get_context\` — load the contract bundle, ancestors, blockers and active claim. The \`pages\` object provides continuation for children, typed links, comments, audits, runs, evidence, verifications, reviews and amendments; use \`work_get_context(id, section, after)\` until exhausted.
- \`work_list_ready\` — list committed, unblocked, unclaimed work in urgency order; continue with \`after: pageInfo.endCursor\`.
- \`work_catalog\` — page visible teams, states, labels, actors and cycles. Use kind \`capabilities\` for credential scopes and actor restrictions; each mutation still checks current work access and lifecycle.
- \`protocol_get_guide\` — fetch this document verbatim.

Write:
- \`work_propose\` — create candidate work; \`decision_notice\` says where the person's decision will arrive. Pass \`parent_id\` to nest under project/milestone. Pass \`initial_state: 'REVIEW' | 'STARTED' | 'UNSTARTED' | 'BACKLOG'\` to direct-route upon human commitment. Pass \`priority\` (0–4) to suggest one; the person who commits may change it. Type: Bug via \`labels: ['bug']\` is committed directly and never enters Candidates; it requires \`priority\` (SLA), \`steps_to_reproduce\`, and a parent.
- \`work_file_bug\` — file a Type: Bug. Required: \`priority\` (1–4, sets the SLA) and \`steps_to_reproduce\`. Committed directly; missing parent/priority/steps is refused. Prefer this over \`work_propose\` for bugs.
- \`work_update\` — update fields with \`expected_revision\`. Omitted fields remain unchanged; nullable fields accept null to clear. \`label_ids\` replaces the set (empty clears); kind, cycle_id and alias use the same validation as the editor. On committed work agents cannot change the contract (acceptance, scope, verification, outcome, constraints).
- \`work_comment\` — append as the authenticated actor; optional parent_comment_id replies to a comment. Supply idempotency_key for safe retries (same key with different content is refused).
- \`work_propose_amendment\` — propose a change to a committed contract: the fields, their new values and a reason. A person accepts it (applied as their own edit) or rejects it with a note on the issue page; the decision arrives in \`agent_inbox\` (\`contract.amendment_accepted\` / \`contract.amendment_rejected\`) and shows in \`work_get_context\` (\`contractAmendments\`). Use this instead of asking a person to retype a fix.
- \`work_relate\` — \`action: 'link'\` creates a typed work link; \`action: 'unlink'\` removes a directed non-CONTAINS relation by from_id, to_id and type (write access to both endpoints). Unlink before replacing a reversed BLOCKS edge.
- Move existing work with \`work_update(parent_id, expected_revision)\`; identifiers and UUIDs are accepted. Graph hierarchy, repository, team and cycle constraints still apply.
- \`work_claim\` — atomically claim committed work for the current agent actor; \`action: 'release'\` yields your own lease with a reason.
- \`run_report\` — report run status (queued / running / blocked / completed). Completed moves to In Review.
- \`evidence\` — \`action: 'attach'\` (default) adds a PR, test, log, or artifact URL to a run; \`action: 'retract'\` withdraws your own unaccepted evidence with a reason.
- \`agent_request\` — \`action: 'claim'\` leases a request from \`agent_inbox\`, \`action: 'answer'\` replies.
- \`delivery\` / \`executor\` — delivery packages and the external executor protocol, each with \`action: 'context'\` (default, read) and the write actions (\`propose\`, \`execution_create\`; \`update\`).

Human-only (delegated CLI or Web UI):
- \`work_commit\` / \`pnpm candidates:batch-commit\`
- \`work_reject\`
- \`work_review\`
- accepting or rejecting a contract amendment (issue page or work page, Contract section)

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
     - Never propose \`COMPLETED\` or \`CANCELED\`; candidate \`initial_state\` stops at In Review — except an ISSUE labelled research (Type: Research), which may pass \`initial_state: 'DONE'\` and lands in Done when a person commits it (INV-912).
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
\`severity\` (\`sev1,sev2\` or \`none\`), \`updated\`, \`link\`, \`has\`, \`project\`.
Bare words match title/description.
`;
}
