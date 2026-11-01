# Autonomy policy: who decides at each gate (design, INV-1485)

Status: **design; steps 1, 2, 3 and 5 implemented** (INV-1491 L1: the Autonomy Gate commits qualifying candidates and accepts verification-only amendments where the policy says so, Needs you shows Handled for you with Return to candidates / Return to me, undo is counted as an override); (INV-1490 agent trust: OBSERVE by default, Promote / Demote with reason and 30-day numbers on the agent page); — INV-1488 data layer; INV-1489 the three settings pages (Administration → Autonomy with ceiling / default / locks / templates / pause / history, Team settings → Autonomy with levels, per-step table, L3 intake rule and optional observe, Projects → Edit inherit / override), the project card badge and the Needs you observe chip. Step 1 was — `WorkflowPolicy` / `AgentTrust` rows, the pure resolver `autonomy-policy.ts`, `Issue.autonomy` and MCP `work_get_context.autonomy`, `workflowPolicySet` for Admins and team Owners. No gate opens yet. Behaviour today is unchanged: commit, reject,
accept and contract amendments are human-only, and the only configurable gate is
`PROJECT.autoAcceptBugs` (INV-1075). This page is the product and data design
that turns those constants into a policy a workspace sets, a team adopts and a
project may override. The research behind it is attached to INV-1484; the
product mock-ups are attached to INV-1485. Decisions taken on 2026-11-01 with
the repository owner: levels are named **L0–L3** with a bilingual description,
an observe period is **offered, never forced**, and policy lives only on
**workspace → team → project** (no per-person level).

## 1. The levels

A level is a preset of gate deciders (§3). Users pick a level; the per-gate
table is an advanced view. Every surface shows the level with its one-line
description in the viewer's language.

| Level | English | 中文 |
|---|---|---|
| **L0 Review everything** | A person commits every candidate, accepts every amendment and moves every item to Done. Agents propose, run and stop at In Review. This is today's behaviour. | 每一张候选由人承诺，每一次修约由人接受，每一项工作由人移到 Done。agent 只提案、执行、停在 In Review。即现状。 |
| **L1 Low-risk pass-through** | Candidates that are bugs or improvements with steps, acceptance and a priority of High or lower are committed as soon as they are proposed. Amendments that only change `verification` are accepted automatically. Everything else waits for a person. | 带复现步骤、验收标准且优先级不高于 High 的 bug / improvement 候选一经提案即承诺；只改 `verification` 字段的修约自动接受。其余照旧等人。 |
| **L2 Green-light accept** | L1, plus: work in In Review whose evidence grades CLEAR (merged, checks green, verifier not in shadow) moves to Done by the Auto-Accept Gate, for every Type, not only bugs. Bugs with reproducibility Sometimes / Once, SEV1 / SEV2 incidents and anything the workspace locks still wait for a person. | 在 L1 之上：处于 In Review、证据评级为 CLEAR（已合并、CI 绿、验证器非 shadow）的工作由 Auto-Accept Gate 移到 Done，对所有 Type 生效而不只是 bug。复现频率为 Sometimes / Once 的 bug、SEV1 / SEV2 事故以及工作区锁定的项仍等人。 |
| **L3 Hands-off** | L2, plus: candidates that match the team's intake rule are committed and dispatched to an agent without a person; agents may delegate to other agents through explicit, budgeted, bounded requests (INV-571's conditions); the person who filed the item hears back once, on the item, when it is Done. People see escalations and a digest, not every step. | 在 L2 之上：符合团队收单规则的候选无需人承诺即派给 agent；agent 之间可以通过显式、带预算、有跳数上限的请求互相委派（INV-571 的准入条件）；提单人只在工作 Done 时在工单上收到一次回帖。人看到的是升级项和摘要，不是每一步。 |

Rules that hold at every level (the invariants):

- Every committed item keeps a **human owner**; an agent is a delegate, never
  the accountable party (Linear AIG principle 06; `WORK_OWNER_MUST_BE_HUMAN`).
- Every automatic decision is written to `WorkAudit` with the policy id and
  version that allowed it and the conditions that matched, and is shown on the
  item's timeline.
- Every automatic decision can be undone by a person: reopen, return to
  candidates (`workUncommit`), return to the executor. Undo is counted as an
  **override** against the policy and the agent.
- Evidence verification keeps recording its shadow grade; a level never changes
  what counts as CLEAR, only who acts on it.
- Stop still works: a person's stop request reaches the runtime regardless of
  level (`docs/external-executors.md`).
- Agents never set CANCELED, never change a policy, never raise their own trust.

## 2. Where people set it

Policy is set at three scopes. A lower scope can only stay within the scope
above it.

```
workspace ceiling  ≥  team level  ≥  project level (override, optional)
```

The **effective level** of a work item is the project's level when the project
overrides, else its team's level, both clamped to the workspace ceiling, and
further clamped to the **trust level of the agent acting** (§2.4). Every
surface that shows a level also says where it came from.

### 2.1 Workspace (Admin) — Settings → Administration → Autonomy

- **Ceiling**: the highest level any team or project may choose. Default L0 on
  a fresh workspace.
- **Default for new teams**.
- **Locked gates**: decisions that stay with a person at every level. Three are
  built in and cannot be unlocked: SEV1 / SEV2 incidents reaching Done
  (INV-1126), work whose delivery policy includes a `deploy` action or touches
  credentials / permissions, and bugs with reproducibility Sometimes / Once
  (INV-1122). Admins may add more (for example priority Urgent).
- **Templates**: named level + per-gate overrides a team can adopt in one click
  ("Bugs on autopilot, features reviewed"). Three ship by default, one per
  level above L0.
- **Pause all autonomy**: one switch that puts every scope at L0 until turned
  back on, and sends the stop signal to running executors.
- **Change history**: every edit needs a reason and is audited (`WorkAudit`
  kind `policy.changed`, visible on `/ops`).

### 2.2 Team (Owner) — Team settings → Autonomy

- Pick a level or a template. Levels above the ceiling are shown locked with
  the reason and who can raise it.
- **Advanced: per step** shows the gate table (§3) for the chosen level; the
  Owner can tighten any gate, or loosen one within the ceiling.
- **Intake rule** (L3 only): which candidates are committed and dispatched
  without a person. Conditions are fields, not prose: Type, labels, priority,
  source (`agent`, `bug-report`, webhook), has steps / acceptance.
- **Try first (optional)**: *Observe for N days* leaves the current level in
  force and marks, on each item in Needs you, what the chosen level would have
  done. After the period the page reports "n items would have been automatic,
  you decided differently on m" with a link to the m. Turning the level on
  directly is always available; observe is advice, not a gate.

### 2.3 Project (team Owner or project owner) — Projects → Edit

The existing **Auto-accept verified bug fixes** checkbox becomes:

```
Autonomy   (•) Inherit from team <KEY>: L1 Low-risk pass-through
           ( ) Override for this project  [ L0 ▾ ]
```

An override may be lower than the team, or higher up to the ceiling. The
project card shows a badge with the effective level and whether it is inherited.

Migration: a project with `autoAcceptBugs = true` becomes an L2 override whose
`review_accept` gate is limited to Type Bug; the GraphQL field stays readable
and writable for one release and maps onto that override.

### 2.4 Agent trust — Settings → Agents → agent

Not a policy scope but a clamp. Each agent has a **trust level** Observe / L1 /
L2 / L3. New agents start at Observe: they can claim and run, but no gate opens
for their proposals or deliveries whatever the project says. Promotion is a
person's action with a reason; the page shows the numbers next to the button
(false-report rate from `/bugs`, reopen count, overrides on this agent's work
in the last 30 days) and a suggestion when they are clean. Demotion is
immediate.

## 3. Gates and the per-level table

A **gate** is a point where today a person must act. The policy records, per
gate, a **decider**:

- `human` — waits in Needs you under its attention kind (today's behaviour);
- `auto(condition)` — the server decides when the condition holds, else it
  falls back to `human` and the Needs you row says why ("Escalated: CI red");
- `none` — the step does not exist at this level (only used for
  `agent_delegation`, where "none" means delegation is refused, not skipped).

Conditions are typed predicates over stored fields only: `type`, `labels`,
`priority`, `source`, `severity`, `reproducibility`, `has_steps`,
`has_acceptance`, `amendment_fields`, `auto_accept_grade`, `pr_merged`,
`checks`, `delivery_actions`, `budget_remaining`, `hops`. No free text.

### 3.1 The six gates

| Gate | Today | L0 | L1 | L2 | L3 |
|---|---|---|---|---|---|
| `candidate_commit` — a CANDIDATE becomes COMMITTED (`workCommit`, `workReject`) | human (bugs and incidents with the required fields are committed on filing, INV-787 / INV-1123) | human | auto when `type ∈ {bug, improvement} ∧ has_steps ∧ has_acceptance ∧ priority ≥ 2` | same as L1 | auto when the team intake rule matches; the item is also dispatched (`executor.*`) |
| `contract_amendment` — an agent's amendment is applied (`contractAmendmentAccept/Reject`) | human | human | auto when `amendment_fields ⊆ {verification}` | same as L1 | auto when `amendment_fields ⊆ {verification, scope}` and the change shrinks scope |
| `review_accept` — In Review → Done (`workReview`) | human; Auto-Accept Gate for bugs when `autoAcceptBugs` | human | human | auto when `auto_accept_grade = CLEAR ∧ pr_merged ∧ checks = green ∧ reproducibility ∉ {SOMETIMES, ONCE} ∧ severity ∉ {SEV1, SEV2}` | same as L2 |
| `agent_delegation` — an agent opens a request to another agent (`agentRequest*`) | none (INV-571) | none | none | none | auto when the request carries a root request id, a budget with `budget_remaining > 0`, `hops ≤ max_hops`, and names a target agent (the INV-571 conditions, quoted in §5) |
| `merge_signal` — which external merge evidence the gate may rely on | GitHub webhook / verifier | read-only: the policy names the repository and branch whose merge counts; Involute never merges | same | same | same |
| `spend_budget` — what an item or delegation chain may spend before it escalates | not tracked | n/a | n/a | n/a | human when `budget_remaining = 0` (the chain pauses and the owner is asked) |

### 3.2 Every current HUMAN_GATES entry

The acceptance of INV-1485 asks for each entry of `HUMAN_GATES` in
`packages/server/src/human-surface.ts` to be placed. Entries group by mutation;
the table lists each mutation once with the gate it belongs to and its decider
per level. "person" means unchanged at every level.

| Mutation (HUMAN_GATES) | Gate | L0 | L1 | L2 | L3 |
|---|---|---|---|---|---|
| `workCommit` (5 entries) | `candidate_commit` | person | auto(cond) | auto(cond) | auto(intake) |
| `workReject` | `candidate_commit` | person | person | person | person — declining stays a person's call; policy only commits |
| `workReview` (3 entries: accept / cancel / COMPLETED) | `review_accept` | person | person | auto(CLEAR) for accept; cancel stays person | same as L2 |
| `issueUpdate` — rewrite committed contract | `contract_amendment` | person | auto(verification only) | same | auto(verification, scope-shrink) |
| `issueUpdate` — owner must be human | invariant | person | person | person | person |
| `issueUpdate` — toggle `autoAcceptBugs` | replaced by project override (§2.3) | person | person | person | person |
| `issueUpdate` — cancel with resolution | not a gate (correction) | person | person | person | person |
| `contractAmendmentAccept` (3 entries), `contractAmendmentReject` | `contract_amendment` | person | auto(cond) for accept; reject stays person | same | same |
| `deliveryChangeDecide` | `candidate_commit` for delivery packages | person | person | person | auto when the package's units contain no `deploy` action and the intake rule matches |
| `deliveryExecutionCreate` | not a gate (timing) | person | person | person | auto after an auto-approved change |
| `executorUpdate` — reconcile external effect | locked | person | person | person | person |
| `workClaimRelease`, `workRestore`, `workUncommit`, `evidenceRetract` | corrections, not gates | person | person | person | person |
| `agentRequestAnswer`, `agentRequestReply` | `agent_delegation` (the human-addressed request stays human) | person | person | person | person for requests addressed to a person; agent-addressed requests exist only here, under auto(cond) |
| `actorDeactivate`, `actorReactivate`, `actorTransferOwner`, `actorSetSuccessor`, `agentCredentialCreate`, `serviceActorCreate` | administration, locked | person | person | person | person |
| `teamMembershipUpsert` (3 entries), `teamTriageRotationUpdate` | administration, locked | person | person | person | person |

The `human-surface.test.ts` invariant changes from "every gate has a human
screen" to: **every gate has a human screen, or a policy entry that may open it;
when a policy opens it, the decision appears in Needs you under "Handled for
you" with an undo**. Both halves are checked: a gate without an attention kind
and without a policy entry fails CI, and a policy entry whose auto decision has
no "Handled for you" row fails CI.

## 4. What people see

- **Needs you** gains a collapsed group **Handled for you** (today / this week):
  one row per automatic decision with the policy name and version, the matched
  conditions, and `Reopen` / `Return to candidates` / `Return to executor`.
  In observe mode the group is **Would have been handled**.
- **Issue page**: a badge `Autonomy L1 · team INV` or `L2 · project override`;
  timeline rows `Auto-committed by policy "Bugs on autopilot" v2 — matched:
  Type Bug, steps present, priority High` and `Escalated to you: checks red`.
- **Completion reply**: at L3, when an item reaches Done the executing agent
  posts one comment from a workspace template (what changed, PR, how it was
  verified, cost, follow-ups from `run.followups`, INV-1231). The filer gets
  that one notification instead of the run stream.
- **Digest**: a daily or weekly email / inbox item per person: handled n,
  overridden m, suggestions ("project X: 0 overrides in 30 days, L2 available").
- **Ops → Autonomy**: policy versions, decisions per version, bulk reopen by
  time window.

## 5. Conditions we keep from earlier decisions, quoted

INV-478 stands: the kernel stores external session URLs, run state, structured
evidence, client identity and failure reasons, and does not add process
hosting, worktree creation, model selection or token budget scheduling. L3's
"agents delegate to agents" is a ledger entry on `AgentRequest`; the work is
done in the runtime.

INV-571 stands until a DECISION replaces it. Its entry conditions, verbatim,
are the `agent_delegation` condition at L3:

> - 委派必须是**显式动作**，而不是「提及即委派」；
> - 每条委派携带**根请求 id**（可回溯到最初的人工发起者）、**预算**（payingPrincipal 已在 AgentRequest 上预留）、**跳数上限**；
> - 先定清协议归属：Involute 托管 / runtime 内置 / 公共约束三选一；
> - 具备终止与收敛的可观测证据（不产生环、期限内必然落到终态）。

The third bullet is answered by this design: Involute hosts the **ledger**
(identity, thread, request with deadline and claim, budget, hop count), the
runtime hosts the **behaviour**. If that answer is accepted, INV-571 is set to
CANCELED with a pointer to the new DECISION, as its own text requires.

## 6. Data model (for the implementing issues)

```
WorkflowPolicy
  id, scope: WORKSPACE | TEAM | PROJECT, scopeId
  level: 0..3
  gates: { [gate]: { decider: 'human' | 'auto' | 'none', condition?: Predicate } }
  intake?: Predicate                 -- L3 team rule
  locked: Gate[]                     -- workspace only
  version, createdBy, createdAt, reason
  observeUntil?: timestamp           -- optional trial window
  active: boolean                    -- previous versions kept, never deleted

AgentTrust
  actorId, level: OBSERVE | 1 | 2 | 3, setBy, reason, at

WorkAudit.kind += 'policy.changed' | 'policy.auto_decision' | 'policy.override'
```

Resolution: `effective(item, actor) = min(ceiling, project ?? team, trust(actor))`,
then `gates[gate]` from the most specific scope that defines it, then
`locked` applied last. The resolver is pure and unit-tested against the table
in §3.1; the GraphQL `Issue.autonomy { level, source, gates }` field and MCP
`work_get_context` expose the same object (parity test).

## 7. Metrics that move a level

No level is raised by trust alone. Each scope and each agent shows, over 30
days: items handled automatically, overrides (undo within 7 days), reopens,
false-report rate (from `/bugs`), and for L2 escaped defects (a bug whose
`CAUSED_BY` points at an auto-accepted item, INV-752 when it lands). The
settings page suggests a raise when overrides are zero for 30 days and warns
after three overrides in a week. The numbers are advice; the person decides.

## 8. Not in scope

- Natural-language rules (Linear Loops). Conditions are typed fields so they
  can be tested and explained.
- Running agents, merge queues or worktrees inside Involute (INV-478).
- A per-person level. The filer of an item does not choose how it is handled;
  the project does. A person who wants a single item back uses Return to me.
- Changing what the evidence verifier counts as CLEAR.

## 9. Implementation split (candidates to propose after this design is accepted)

1. `WorkflowPolicy` model, resolver, audit kinds, GraphQL + MCP read field;
   migrate `autoAcceptBugs`. No behaviour change yet.
2. Workspace and team settings pages, project override; observe mode rows in
   Needs you.
3. L1: `candidate_commit` and `contract_amendment` auto deciders; Handled for
   you group with undo.
4. L2: generalise the Auto-Accept Gate from Type Bug to the policy condition.
5. Agent trust level and the metrics panel.
6. L3: intake dispatch, `agent_delegation` on `AgentRequest` with root id,
   budget and hops; DECISION superseding INV-571; completion reply template.
