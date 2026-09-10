# Milestones

## M0: Single-team migration acceptance

Status: done.

Done:

- `involute import team` runs export, import, and verify in one command
- import writes a lightweight summary artifact
- board and issue detail support create, update, comment, delete comment, and delete issue
- Playwright covers the full lifecycle against a real browser
- Docker Compose brings up db, api, web, and cli

Exit criteria:

- A real team snapshot can be imported and visually accepted from the board
- `pnpm e2e` is green locally and in CI
- `docker compose up --build -d db server web` is a stable demo path

## M1: Deployable self-hosting

Status: deployment path implemented and previously exercised; the current mainline/kernel build is not deployed.

Scope:

- ship and validate a production deployment path for VPS first
- keep Railway as a possible later hosting target, not the current blocking path
- define `.env.production` expectations and runtime secrets
- add reverse proxy / TLS guidance and database backup guidance
- exercise public-domain deployment once and OAuth callback once
- keep the VPS-hosted `SON` dataset as the active source of truth after the final source refresh
- keep Docker images and compose-based demo/runtime aligned

Done inside M1 already:

- the Tailscale VPS deployment path has been exercised successfully against the latest mainline build
- the public-domain deployment path has served an earlier mainline build over HTTPS; the current build still needs an immutable-image deploy and authenticated smoke
- one backup and restore drill has been executed successfully
- the canonical `SON` dataset has been refreshed from the source system into the VPS stack
- operator runbook, restore script, and smoke checklist live in [docs/ops.md](./ops.md)

Exit criteria:

- a fresh host can run Involute with Postgres, API, and web using documented steps
- a public-domain deployment has been smoke-tested with Google OAuth and session cookies
- backup and restore have both been exercised once
- deployment docs are specific enough to reproduce without reading the source
- image publishing and runtime config are consistent with the supported hosting path

## M2: Auth and team permissions

Status: done.

Scope:

- move away from the current shared-token simplification
- add a real session-backed viewer model
- start with Google OAuth rather than magic-link email
- add `admin`, `team visibility`, and `team membership` edit boundaries
- add a bootstrap path for the first admin without touching raw headers

Exit criteria:

- an admin can sign in and manage access without touching raw headers
- public teams are readable but not writable by non-members
- private teams are only visible to members and admins
- team members can be granted viewer/editor-style access explicitly

## M3: UI/UX redesign

Status: in progress. Observation-only after the current shell; not the Linear-replacement path.

Scope:

- replace the old generic shell with a keyboard-first app shell
- tighten board and backlog workflows around filters, views, bulk actions, and shortcuts
- improve issue detail density and editing flow

Done inside M3 already:

- the new app shell, board, backlog, access, and issue surfaces are live
- saved views, command palette navigation, and keyboard-first board workflows are in place
- the public VPS deployment is already serving the redesigned web client

Exit criteria:

- visual direction is intentional and no longer feels placeholder-like
- redesign does not regress the M0 lifecycle, deployment path, or team permission model
- no new Linear-clone surfaces (Inbox product, Cycle product, Agent live UI) are added under M3
- leftover Inbox / Cycles / Projects / My Issues / Views routes are frozen; do not grow them

## M4: Multi-team workspace import

Status: later.

Scope:

- workspace-level export/import
- team mapping strategy
- repeat import semantics

Exit criteria:

- multiple teams can be brought in predictably
- repeated imports have explicit behavior and reporting

## M5: Agent-native work-graph kernel

Status: released in `npm-v0.2.0`; production deployment pending. This is the Linear-replacement track.

Involute replaces Linear as a callable project-state service, not as a board clone. Existing GraphQL Issue APIs stay as a generic compatibility facade for the web app and CLI. Web UI stays optional observation and governance.

### K0: Product contract

Status: done.

- rewrite vision around a headless work-graph kernel
- agent protocol is MCP + work mutations, not comment heartbeats
- stop prioritizing Linear UI features

### K1: Work node + typed links

Status: released in `npm-v0.2.0`; production deployment pending.

- additive Prisma fields on `Issue`: kind, commitmentStatus, revision, contract fields, repository
- `User.actorKind`
- `WorkLink` and `WorkAudit`
- multi-hop cycle detection for `CONTAINS` and `BLOCKS`
- GraphQL exposes new fields as read-only; existing mutations keep their shape
- `issueUpdate(parentId)` projects onto a `CONTAINS` link and writes audit

### K2: Context bundle + ready queue

Status: released in `npm-v0.2.0`; production deployment pending.

- `getWorkContext` returns contract, contains-ancestors, blockers, and recent audits
- `listReadyWork` returns committed, unblocked, unfinished work in urgency order
- GraphQL `workContext` / `readyWork`; IssueFilter also accepts `kind`, `priority.eq`, `updatedAt.gte`
- CLI `involute work context` and `involute work ready`

### K3: Propose / commit / claim

Status: released in `npm-v0.2.0`; production deployment pending.

- `workPropose` creates `CANDIDATE` work that cannot enter the ready queue
- `workCommit` requires acceptance criteria, a human owner, and `expectedRevision`
- `workClaim` is atomic with a lease; agents do not occupy `assigneeId`
- agents may propose/claim/update, not commit or move work to Done/Canceled
- `workClaim` is the only claim path; moving an issue to In Progress does not create a lease
- comments are not an agent protocol

### K4: MCP + Skill

Status: released in `npm-v0.2.0`; production deployment pending.

- Streamable HTTP JSON-RPC at `/mcp` and `/mcp/readonly` on the same Node process
- tools call domain services: search, context, ready, propose, commit, update, link, claim
- readonly endpoint omits write tools
- Skill at `skills/involute/SKILL.md`
- `run_report` / `evidence_attach` shipped in K5

### K5: Run, evidence, events

Status: released in `npm-v0.2.0`; production deployment pending.

- `WorkRun`, `WorkEvidence`, `EventOutbox`
- `run_report` / `evidence_attach` via MCP, GraphQL, and CLI
- run complete and evidence move work to In Review, never Done
- outbound webhooks: `INVOLUTE_WEBHOOK_URL`, `INVOLUTE_WEBHOOK_SECRET`, HMAC + delivery id + `updatedFrom`

### K6: Observation UI

Status: released in `npm-v0.2.0`; production deployment pending.

- candidate review at `/candidates` with `workCommit` / `workReject`
- contains/blocks graph at `/graph`
- work context page at `/work/:id` (contract, claim, runs, evidence, audits)
- board and backlog query `commitmentStatus: COMMITTED` only

Exit criteria:

- an Agent can complete search → context → claim → run report → evidence → In Review without opening the web app
- existing `SON` identifiers, import, GraphQL, and CLI keep working
- two agents cannot claim the same committed work
- propose retries are idempotent
- concurrent updates conflict on revision instead of silently overwriting

## M6: 效能度量与统计洞察引擎 (Analytics & Performance Insights Engine)

Status: planned (next priority).

Scope:

- activate dormant timestamp data in `WorkAudit` and `WorkRun` into first-class engineering metrics
- calculate flow metrics:
  - **Lead Time**: end-to-end duration from `CANDIDATE` propose to `COMPLETED`
  - **Cycle Time**: active engineering execution duration from `work_claim` to `REVIEW`
  - **Review Idle Time**: time waiting in `REVIEW` for human acceptance
  - **Agent Execution vs Human Review**: clear breakdown of machine effort vs human gate latency
- milestone & project dynamic burndown:
  - daily committed snapshot aggregation
  - ideal burndown slope vs actual remaining effort
  - **Scope Creep** detection: tracking issues added mid-flight after milestone start
- velocity & throughput forecasting:
  - rolling average throughput (completed issues/points per week)
  - automated completion date projection
- GraphQL surface: `projectAnalytics`, `milestoneBurndown`, `flowMetrics`
- Web UI: dedicated `/analytics` dashboard and embedded milestone progress widgets

Exit criteria:

- project and milestone views display flow time percentiles (P50/P90) and burndown curves
- users can immediately pinpoint whether bottlenecks stem from agent execution or review delays
- analytics queries execute under 200ms using indexed audit aggregations

## M7: 极速键盘流与高密度交互体验 (Linear-Grade Keyboard & Peek Ergonomics)

Status: planned (next priority).

Scope:

- global keyboard-first interaction system:
  - `J` / `K` navigate cards with visual focus ring
  - `Space` opens Peek Drawer, `Esc` dismisses
  - `S` quick-switch status, `P` priority, `A` assignee, `C` global quick-create modal
  - `X` multi-select toggle, `Shift + J/K` range selection, floating batch action bar
- Peek Drawer (Side Sheet) depth upgrade:
  - all properties support inline click-to-edit without opening secondary modals
  - seamless previous/next issue navigation (`[` / `]` or `J/K`) while drawer remains open
  - hierarchical sub-issue and dependency drilling directly inside the drawer
- sub-50ms perceived latency via optimistic UI updates

Exit criteria:

- full issue triage, assignment, and status transitions can be performed 100% via keyboard
- clicking an issue opens a non-disruptive drawer without full-page reloads
- keyboard shortcuts work consistently across Board, Backlog, and Candidates

## M8: 多维拓扑视图矩阵 (Multi-View Matrix & Critical Path Gantt)

Status: planned.

Scope:

- high-density Spreadsheet / Table View:
  - Airtable/Linear-style compact data grid
  - in-cell direct editing, column sorting, and custom column visibility
- dependency Timeline & Gantt View:
  - visual representation of `BLOCKS` and `CONTAINS` relationships over time
  - automated Topological Critical Path calculation
  - drag-to-reschedule with dependency constraint warnings
- multi-dimensional grouping & filtering:
  - group by State Group, Assignee, Priority, Label, Milestone

Exit criteria:

- users can switch seamlessly between Board, Table, and Gantt views with persisted view state
- dependency cycles and critical path blockers are highlighted visually

## M9: 动态迭代周期与容量规划 (Cycles, Estimations & Capacity)

Status: planned.

Scope:

- automated sprint Cycles engine:
  - auto-start and auto-close based on configured cadences (1-week / 2-week)
  - automatic rollover of uncompleted work to the next cycle
  - cycle cooldown periods and auto-archival of completed work
- estimation points system:
  - Fibonacci (1, 2, 3, 5, 8) and T-shirt sizing
  - team and agent capacity planning (workload allocation and threshold warnings)
- project health pulses:
  - recurring status updates (On-Track / At-Risk / Off-Track) with progress summary

Exit criteria:

- cycles advance automatically on schedule with zero manual admin intervention
- velocity and burndown charts can be computed against story points

## M10: 富文本协作与实时协同总线 (Rich WYSIWYG & Real-Time Sync)

Status: planned.

Scope:

- TipTap / ProseMirror rich WYSIWYG document editor:
  - slash commands (`/h1`, `/code`, `/table`, `/checklist`)
  - clipboard screenshot paste-to-upload
  - inline `@` mentions for human team members and agents
- real-time collaboration bus (WebSocket / SSE):
  - live card movement synchronization across multiple open browser tabs
  - live agent execution progress and log streaming without manual refresh

Exit criteria:

- replace all plain `<textarea>` inputs with rich markdown/WYSIWYG editing
- multi-user card drag-and-drop reflects in real time across clients within 200ms
