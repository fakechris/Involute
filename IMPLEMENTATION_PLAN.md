# Implementation plan — Agent as a first-class identity (INV-584)

Design: `docs/actor-model.md` (v2, externally reviewed) and
`docs/agent-identity-principle.md`. One PR per stage, each stacked on the last
until merged. Every stage carries its own acceptance tests; `pnpm lint` and the
server suite must exit 0 before a PR opens.

Order is the reviewer's, not mine: trusted principal + execution claims first,
then reflex attribution, then lifecycle, then audit coverage, then receipts,
then hand-off. Each later stage depends on the one before it being true.

## Stage 1: Identity principle and execution-bound claims — INV-585
**Goal**: no actor kind but HUMAN passes the human gates; a claim belongs to an
execution, not an actor; the hotfix reflex attributes by authentication.
**Success Criteria**: `assertActorCan` denies SERVICE and unknown kinds;
the P1 counterexample (stale session answers after re-claim) is a failing test
that now passes; `--commit` gone; invalid token fails rather than degrades.
**Status**: Complete — PR #87, #88 (open, stacked)

## Stage 2: Identity lifecycle — INV-586
**Goal**: every non-human actor has a human owner; actors are deactivated,
never deleted; SERVICE actors can be provisioned and listed.
**Success Criteria**: `User.ownerId` + `User.deactivatedAt`; deleting an actor
with history is refused (`WorkAudit.actor` no longer `SetNull`); `agent:create`
can provision a SERVICE actor with an owner; the directory lists SERVICE actors
with owners; owner transfer is an explicit, audited operation; the four fields
`ownerId` / `assignee` / `requestedBy` / execution authorizer stay separate.
**Status**: Complete — PR pending (stacked on #88); 522/522 server tests

## Stage 3: Audit coverage — INV-587
**Goal**: the events a receipt will attach to are all audited, with actor,
session, surface and claim generation.
**Success Criteria**: `agent_request_answer`, claim, expiry and hand-off each
write a `WorkAudit`; the GitHub state machine writes one in the same
transaction as its CAS, naming `@github-webhook`; a test asserts a webhook
state transition produces an audit row.
**Status**: Not Started

## Stage 4: Decision receipts — INV-588
**Goal**: what the actor knew at write time survives the session.
**Success Criteria**: `DecisionReceipt` attaches to exactly one immutable event
(audit, comment, or run); written in the same transaction via
`work_propose` / `run_report` / `agent_request_answer`; server fills identity
and time, agent supplies reasoning and references; a self-reported actor that
disagrees with the audit is rejected; references without a version/digest are
marked unknown; shown on the audit entry and the agent page, always as a claim.
**Status**: Complete — PR pending (stacked on #90); 541/541 server

## Stage 5: Successor hand-off — INV-589
**Goal**: an unanswered request escalates to a person, by construction.
**Success Criteria**: triggered by the request's deadline/lease, not actor
presence; visited set + max hops + total deadline; forced to a valid human at
the limit; terminate-old / open-new / link is atomic and idempotent; a late
answer from the previous holder loses on claim generation; successor must
already have read access; impersonating the original actor is rejected at the
write.
**Status**: Complete — PR pending (stacked on #91); 551/551 server

## Cross-cutting
- Web UI for receipts and hand-off state lands with Stages 4 and 5.
- Deploy to the box after each merge (pull → migrate → build server + web →
  restart), with a backup first.
- Evidence attaches to INV-585…589, never to a guessed number.

---

## Milestone 2 — permissions and attribution hardening (INV-590…593)

From the post-merge review of INV-584: three P1 authorization holes, one
receipt-binding race, the agent-in-TeamMembership debt, and closing items.

## Stage 1: Actor lifecycle authorization (INV-590)
**Goal**: Only an ADMIN, the actor's owner, or an OWNER of a team the actor belongs to may deactivate it or transfer its owner; deactivated humans lose their sessions; SERVICE provisioning never touches an existing identity and audits what it wrote, in one transaction; built-in services get an owner by default.
**Success Criteria**: `actor-authorization.test.ts` — bystander refused, owner/team-owner/ADMIN pass, EDITOR refused, HUMAN subject ADMIN-only, deactivated session null, collisions refused with no audit row.
**Status**: Complete — PR pending

## Stage 2: Receipt binds to its own audit row (INV-591)
**Goal**: `recordWorkAudit` returns the audit id; propose/answer/report attach the receipt to that row, never to "the latest audit of the work".
**Success Criteria**: receipt lands on its own audit when two audits exist; existing receipt tests green.
**Status**: Complete — PR pending (stacked on INV-590)

## Stage 3: Agent authorization from the credential binding (INV-592)
**Goal**: Agents are authorized by `AgentCredential.teamId` + scopes, not by a fake EDITOR membership. Backend first, then backfill + migration removing AGENT memberships, then hand-off/mention use the binding, then `/settings/access` shows humans only plus a Team Agents section.
**Success Criteria**: an agent with no membership can read/write its bound team and nothing else; hand-off and mention suites green; live agent write path verified after deploy.
**Status**: Not Started

## Stage 4: Hand-off grace window, chain in GraphQL/UI, legacy cleanup (INV-593)
**Goal**: A forced-to-human hand-off gets a real deadline; `AgentRequest` exposes hop/root/handed-off-from; work context and agent pages show the chain and receipts; legacy agents get an owner or are deactivated.
**Success Criteria**: grace-window test; live GraphQL returns chain fields; directory shows no ownerless active agent.
**Status**: Not Started
