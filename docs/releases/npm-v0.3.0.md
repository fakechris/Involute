# npm-v0.3.0

Release date: 2026-11-24

`npm-v0.3.0` collects about 330 merged pull requests since `npm-v0.2.0`
(2026-09-01). The kernel from 0.2.0 is unchanged in shape — propose, commit,
claim, run, evidence, review — and grows around it: a smaller MCP surface,
explicit autonomy levels, a full bug and incident flow, one queue for every
decision a person owes, search, and the web app rebuilt on one design system.

This is a source, npm and container-image release. Production on
`involute.lumenopen.com` already runs these changes: it is deployed by
immutable `sha-<12>` image from `main` (see [docs/ops.md](../ops.md)), not
from this tag.

> `npm-v0.2.0` never reached the npm registry (the publish job was refused
> with E404). 0.3.0 is the first npm publish since 0.1.4, so CLI users move
> from 0.1.4 straight to 0.3.0.

## Highlights

### Agents and the MCP protocol

- **Twenty-one grouped MCP tools instead of thirty-three** (INV-1046): a pair
  or family (link/unlink, claim/release, attach/retract) is one tool with an
  `action` argument — `work_relate`, `work_claim`, `evidence`, `work_view`,
  `work_timeline`, `agent_request`, `delivery`, `executor`. Old names answer
  for one version with a `deprecated` note.
- **Status is read, not remembered** (INV-1245): tool responses piggyback
  `unread_decisions`; `agent_inbox(repository: …)` reads one project's
  notifications (INV-1545); every agent can have its own push webhook
  (INV-992).
- **Contracts are complete before work starts**: agent proposals require
  `acceptance` (INV-1449); a wrong contract is amended, not retyped
  (`work_propose_amendment`, INV-869); a completed run names its follow-ups or
  why there are none (INV-1231); code work names its commit and PR (INV-1673).
- **Harness-issued branch names**, PR traceability alerts and a merged-PR
  audit (INV-449 / INV-456), project alias prefixes such as `LUM-398`
  (INV-459).
- **Agent identity**: agent profiles and directory, owners, deactivate-never-
  delete, decision receipts, hand-off chains and escalation to a person
  (INV-573 … INV-598).
- **Delivery packages and external executors**: approve a package, dispatch
  units to an executor's inbox, receipts back (INV-941 … INV-995,
  [docs/external-executors.md](../external-executors.md)).
- **Scheduled rounds** of work on a clock (INV-1582); delegation carries a
  hand-off card (INV-1583).

### Autonomy policy (L0–L3)

- Per-team and per-project autonomy levels with an agent trust level as a
  clamp (INV-1485 … INV-1493, [docs/autonomy-policy.md](../autonomy-policy.md)).
- **L1** — the Autonomy Gate commits qualifying bug / improvement candidates
  and accepts verification-only amendments. **L2** — the Auto-Accept Gate may
  accept verified work. **L3** — intake dispatch to trusted agents and
  explicit, budgeted delegation. Every automatic decision names its policy
  version and a person can return it from Needs you → Handled for you.
- Opt-in auto-accept of bug fixes GitHub itself verifies (INV-1075).

### Bugs and incidents

- **Zero-bug triage**: priority to commit, reason to decline, SLA clock with
  at-risk and breached notifications, weekly triage rotation (INV-750);
  agent bugs commit on filing (`work_file_bug`, INV-787) and report possible
  duplicates (INV-1000).
- Resolutions on every close (INV-1118), duplicates, regressions and reopen
  rates, found-in deploy SHA and "fixed between deploys" (INV-1120 … INV-1122,
  INV-752), needinfo that pauses the SLA (INV-1119), triage suggestions
  (INV-648).
- **Type: Incident** with severity SEV1–3, impact timestamps, postmortem draft
  and closing rule, follow-up deadlines and an `/incidents` page with MTTR /
  MTTM (INV-1123 … INV-1129).
- **Involute Capture**, a Chrome extension that files a bug from any page with
  its browser environment (INV-1145 … INV-1147, `packages/extension`).

### People's work

- **Needs you** (`/todo`): every decision waiting on a person in one queue,
  grouped by work tree, with a daily digest; Activity for the rest
  (INV-1091 … INV-1095). Every rule that asks a person has a screen, enforced
  in CI (INV-795 / INV-1004).
- Undo for board moves, field edits, deletions, relations and batch commits
  (INV-835 … INV-844).
- Workspace access: invite-only sign-in, Guest role, team lifecycle, team
  Members and Settings pages, Administration settings, project sharing links
  ([docs/permissions.md](../permissions.md), INV-832 … INV-850).
- Custom fields (`FieldDefinition` + `Issue.attributes`) with IQL
  `attr.<key>`, sort and board grouping (INV-1500 … INV-1505).
- Private files on work items (INV-1003), work-graph export / import
  (INV-1007), server-side saved views shared with the team (INV-1005), with
  early views kept across reloads and given fixed ids (INV-2157).

### Search, graph and delivery views

- One server search for ⌘K, boards and `work_search`, ranked Chinese full-text
  search, local semantic search fused with keywords, `/search` page
  (INV-925 … INV-937).
- Issue neighbourhood map, project outline and dependency graph, timelines
  built from the audit trail (INV-681, INV-1116, INV-1496 …).
- Delivery latency, milestone burndown and one shared calendar window
  (INV-267 … INV-1931); `/hygiene` lists work-graph health problems.

### Web app

- One design system ([docs/design-system.md](../design-system.md)): shared page
  skeleton, controls, dialogs and list rows, dark theme, enforced by
  `design-guard.test.ts` (INV-1311 … INV-1315, INV-1536).
- A controlled vocabulary for words on screen — Accept / Return, Commit /
  Decline, Approve / Decline — checked in CI (INV-2134, INV-2135).
- Keyboard-first: shortcut help, board field keys, J/K/X on review queues,
  `/` and `?` with a Chinese input method (INV-270, INV-1087).
- A session that ends in a background poll keeps open forms and shows one
  sign-in state; returning to the tab re-checks the session (INV-2136,
  INV-2147).
- A task-oriented [user manual](../manual/README.md) (INV-1936).

### Operations

- Settings → GitHub: per-team connections through a deployment GitHub App
  ([docs/github-connection.md](../github-connection.md), INV-1677); sync skips
  repositories that keep answering 404 and recovers on the next webhook
  (INV-1842).
- Ops page: sync, inbound queue, outbox, webhooks, traceability (INV-796).
- `scripts/deploy-prod.sh` with a disk check, pre-deploy backup, rollback and
  image prune (INV-1008); a daily verified backup with tiered retention
  (`scripts/db-backup-daily.sh`, INV-2018) whose installer refuses to run from
  stdin (INV-2152).
- Private self-hosted deployment on Kubernetes with pluggable sign-in,
  organisation import and Redmine migration (`ops/k8s/involute-private`,
  INV-1303 / INV-1307).

## Upgrading

Migrations are applied by `prisma migrate deploy` on start (compose
`server-init`, the AIO entrypoint, the k8s init container). Take and verify a
backup first. Agent clients should read [docs/upgrading.md](../upgrading.md):
several MCP rules that were warnings are now refusals.

## Packages

Published in version lockstep from this tag by
[`.github/workflows/npm-publish.yml`](../../.github/workflows/npm-publish.yml):

- `@turnkeyai/involute-shared`
- `@turnkeyai/involute-server`
- `@turnkeyai/involute` (CLI)

Container images: `fakechris/involute-server`, `involute-web`, `involute-cli`,
tagged `latest`, `sha-<12>` and, from the `docker-v0.3.0` tag, `0.3.0`.
