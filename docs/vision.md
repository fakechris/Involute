# Vision

## Slogan

Agent-native project-state and work-graph kernel.

Involute 保存长期有效的项目事实、任务关系、承诺、状态、决策与验收证据。Codex、Claude Code、Hermes 和其它 Agent 是主入口；Web UI 只是观察和治理这些信息的一种方式，不是必经写入口。

## Product intent

Involute is a headless, self-hostable project-state service. It is not an open-source Linear UI, and it is not an Agent runtime.

The system of record is a work graph:

- a stable work identity (`SON-18`, `INV-142`)
- a delivery contract (outcome, scope, constraints, acceptance, verification)
- typed links (contains, blocks, derived_from, discovered_during)
- human ownership, agent claims, runs, and evidence
- an audit trail of who changed what, from which surface, and why

Agents call Involute through a small semantic protocol. Humans use the board when they need a wide view, candidate review, or acceptance — not to file every task.

## Current north star

The shortest path to value is:

1. An Agent can search and load a complete work context without opening the web app.
2. Fuzzy discoveries enter as candidates, not the committed backlog.
3. An Agent can claim unblocked committed work, report a run, and attach evidence.
4. Run complete is not work accepted. Done stays a human (or `accept`) decision.

The Linear import path remains a way to load historical commitments. It is no longer the product.

## What we are optimizing for now

- Keep the VPS, Google OAuth, team RBAC, and `SON` dataset operational
- Grow the Issue row into a work node without changing public identifiers
- Typed links, context bundles, ready-work queries, propose/commit/claim
- MCP + Skill + events as the Agent-facing protocol
- Treat the existing GraphQL Issue API as a generic compatibility facade for web and CLI
- Keep leftover Linear shell routes frozen: Inbox, Cycles, Projects, My Issues, Views

### Work Graph Convergence (Single Source of Truth)

The historical dual-track models (legacy Linear shell vs Work Graph Kernel) have converged onto the Work Graph:

- **Projects (`Issue.kind = PROJECT`)**: Projects are top-level work nodes on the Work Graph. Sub-issues and child tasks attach via typed `CONTAINS` work links. The Web `/projects` page and the Issue detail project dropdown query and operate on `kind: PROJECT` work nodes directly.
- **Milestones (`Issue.kind = MILESTONE`)**: Deliverable goals and release targets are modeled as `MILESTONE` work nodes, tracking progress across child tasks linked via `CONTAINS`. The Web `/cycles` (and `/milestones`) view prioritizes Work Graph Milestones.
- **Inbox & Notifications**: The Web `/inbox` route consumes the real transactional `Notification` system (`notifications`, `unreadNotificationCount`), giving human operators a live center for triage requests, completed runs, and review notifications.
- **Legacy Compatibility**: The legacy GraphQL `Project` and `Cycle` tables/queries/mutations remain marked `@deprecated` for backward compatibility, but are no longer the primary path for product workflows.

## Four state machines (do not collapse)

| Machine | Meaning |
|---|---|
| `commitmentStatus` | candidate / committed / rejected |
| Issue workflow state | Backlog → Ready → In Progress → In Review → Done / Canceled |
| Claim + Run | who is executing this attempt, and whether that attempt finished |
| Local `task_plan.md` | Agent working memory; not stored as Involute work |

`run completed` is not `issue done`.

## Explicitly not optimizing for

- Cloning Linear Board / Inbox / Cycle / dashboard product surface
- Linear Agent Chat, Loops, or hosted Coding Sessions
- AgentSession live UI inside Involute
- Turning every Agent TODO into an Issue or sub-issue
- Managing worktrees, sandboxes, token budgets, or model routing
- Multi-team workspace import
- Magic-link email auth and provider sprawl
- Making Railway a first-class path before the VPS path is operationalized
