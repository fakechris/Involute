# Actor model: what an agent is, what a session is, what a service is

Status: proposed, v2 after review · 2026-09-16 · INV-573. Prerequisite for
decision receipts and successor hand-off; those are designed against this
vocabulary, not the other way round.

Review verdict on v1: concept direction accepted; implementation contract
No-Go until three P1s were closed. They are closed in the same PR as this
revision. Comparison notes against Linear, Multica, GitHub Apps and A2A live in
`research/actor-model-comparison-2026-09-16.md` (gitignored per AGENTS.md §11).

## The one distinction everything rests on

**Identity is who is answerable. Execution is what happened to be running.**

A session dies. A CLI gets reinstalled. A box gets rebuilt. If any of those were
the identity, then the moment it ends, everything it wrote is orphaned and
nothing can ever be asked about it again. That is the exact failure this work
exists to prevent, so the identity must be the thing that *survives* the
process.

Therefore: **the minimal unit of identity is the actor. A session is never an
identity.** A session is to an actor what a browser tab is to a person — you do
not get a new self per tab, but the tab is where the context lived.

## The four objects

### 1. Actor — who

**An actor is an explicitly registered, persistent collaborator in the
workspace.** A row in `User`, with `actorKind`, a `handle`, and a profile. It is
what gets recorded as having done something, what can be `@`-mentioned, what has
a page. Stable across processes and machines. Owner, runtime and install
location are **relations and attributes of an actor, never its identity**: the
same `@astra` can move from Codex to another harness and keep its history; the
same owner can run two long-lived roles on the same runtime.

Three kinds. One question separates them *as a product explanation*:

> **Can you ask it something and expect a considered reply?**

That question does **not** decide permissions, and it is about capability, not
reachability: an offline agent is still an `AGENT`. Answerability, current
presence and `actorKind` are three separate things.

| kind | what it is | can be asked? | passes human gates? | has credentials? |
|---|---|---|---|---|
| `HUMAN` | a person | yes | **yes** — the only kind that may commit / reject / accept | session cookie / OAuth |
| `AGENT` | an LLM-driven actor with judgement, acting **on behalf of a human owner** | **yes** — inbox, claim, answer | no | `inv_agent_*`, one or more |
| `SERVICE` | a deterministic program with no judgement: sync engine, webhook ingestor, expiry sweeper | **no** — nothing to ask | no | a controlled service context; see below |

`runtime` (`claude-code`, `codex`, `lumenbox`, …) is **descriptive metadata on
an actor, not a kind.** Which model or harness is behind an agent changes how
you read its answers; it does not change what it is.

### 2. Principal context — proof of acting as an actor

The rule is not "every write presents a credential" (a `SERVICE` running
in-process has none, and v1 contradicted itself on this). The rule is:

> **Every domain write carries a trusted principal context. External callers
> establish it with a credential; internal tasks establish it through a
> controlled service context.**

`SERVICE` is itself a principal, not a fallback for "no principal was found".

For external callers the context is `AgentCredential`: the token a process
presents to act *as* an actor. Many per actor. Scoped, rotatable, revocable.
**A credential carries install metadata (which machine, which box) — the actor
does not.** A credential that is invalid, expired or revoked is rejected; it
never degrades to a service identity.

Four things a write must keep apart, because collapsing them is how
misattribution happens:

- **actor** — the authenticated principal that carries attribution for this write
- **initiator / delegation** — who triggered or authorized it (a human's PR
  merge, an agent's session, a cron schedule)
- **surface** — the mechanism it went through
- **execution** — which run, and which claim generation, did it

This is the whole answer to "does the machine / box / channel affect identity":
no. They affect *which credential* is presented. `@claude-chris` on the Mac and
`@claude-chris` on the box are one actor with two credentials, the same way one
person has two laptops.

Example of the four-way split: a human merges a PR and the webhook service
moves the work item to Done. **Actor** is `@github-webhook` (it authenticated
and wrote). **Initiator** is that GitHub event, ultimately the human. The human
being the root cause does not make it the human's write.

### 3. Write — what was done, by whom, from where

Every audited mutation records, on `WorkAudit`:

- `actorId` — **who** (the identity; already recorded)
- `sessionId` — **which execution** (already a column; currently never set)
- `surface` — **through what** (`mcp`, `graphql`, `hotfix-reflex`, `github-webhook`)
- `sourceMessageId` — **prompted by what** (the message, PR, or event)

Who and which-execution are separate columns on purpose. The session id is the
thread back to the transcript for as long as it exists; the actor id is what you
address when it does not.

### 4. Execution and claim — which run may answer right now

A `sessionId` on a write is **context for later**, not a credential now. It is
self-reported, so it cannot be what authorizes anything.

What authorizes an answer is the **claim generation**: every time a request is
taken — fresh, or after a lapsed lease — the server mints a new generation and
a claim token bound to that execution. Renewing and answering require the
token. This is what makes "the currently running session answers" true: two
sessions carrying the same actor credential are different executions, and the
one holding the current generation is the one that may speak. The stale one is
rejected as *superseded*, not accepted because it is the same actor.

(Closed in this revision: the v1 implementation let any execution of the same
actor renew and answer, so a stalled session could answer after a fresh one had
re-claimed.)

### 5. Receipt — what the actor knew when it wrote (to be built)

The session's relevant context, captured **at write time** and attached to the
write, so it outlives the session. This is the bridge across the gap the model
creates deliberately: the actor persists, the session dies, the receipt carries
what the session knew. Designed below.

## Answers to the concrete questions

### A coding CLI session (Claude Code, Codex, Grok) — what does it write as?

**As an explicitly registered, long-lived role.** Not as the session, not as
the CLI, and not as an install.

- The CLI is a runtime → metadata on the actor.
- The session is an execution → `sessionId` on each write, plus a receipt.
- The machine is an install → metadata on the credential.

`(runtime × owner)` — e.g. `@claude-chris`, "Chris's Claude Code" — is a sensible
**default when creating** a role. It is **not a uniqueness rule**: Chris may
legitimately run `@astra-reviewer` and `@astra-builder` on the same runtime, and
`@astra` may move runtimes and keep its history. Do not add a global unique
constraint on `(runtime, ownerId)`. The runtime's actual version, model and
configuration belong on the execution and its receipt as a snapshot of the
moment, not on the actor.

Ask a role later and the execution currently holding the claim generation
answers — from the receipt, not from memory it cannot have.

Why not one actor per session: nothing survives to answer. Why not one actor per
CLI globally (`@claude-code`): you could not tell whose.

### A lumenbox agent — is the agent the unit? Do box and channel matter?

**The agent is the unit.** Box → credential metadata (which install). Channel →
`surface` / `sourceMessageId` on the write (which conversation prompted it).
Neither is identity. A persona shared across several boxes is one actor with
one credential per box.

### Anything else: CI, cron, a script, a webhook receiver

If it has no judgement → `SERVICE`, registered, named, owned by a human, acting
under a controlled service context, cannot be asked, cannot pass human gates.
`@github-webhook`, `@github-sync`, `@expiry-sweeper`. External CI and cron are
`SERVICE` actors that present a credential like any external caller.

If it is an LLM that could reply → `AGENT`, with an owner.

**The norm is one sentence:** every write carries a trusted principal context;
every principal is a registered actor; every non-human actor has a human owner.
Compliance is checked at the write, not requested from the writer.

**An owner is a responsibility, not a permission.** The owner is who is
accountable for the actor and who receives its escalations. Owning an actor
grants no rights over what it writes, and does not mean each execution was the
owner's instruction. `actor.ownerId`, a work item's `assignee`, a request's
`requestedBy`, and the authorizer of a given execution are four different
fields and must never be merged into one.

### The hotfix reflex — corrected, including its auth path

`@hotfix-reflex` was registered as a `SERVICE` actor in #87 and used as the
reflex's identity. That was wrong on two counts, both fixed in this revision:

1. **Attribution.** The reflex has no judgement, but it is **invoked by an
   agent that does**. It now authenticates that agent (`INV_AGENT_TOKEN` →
   `resolveAgentPrincipal`, `propose` scope checked) and files as that agent
   with `surface: hotfix-reflex`. A token that is present but invalid, expired
   or revoked **fails**; it never degrades to the service identity. With no
   token, it files as `@hotfix-reflex` only under an explicit
   `HOTFIX_REFLEX_TRUSTED_SERVICE=true`.
2. **Impersonation.** `--commit` looked up *any* `HUMAN` admin and committed as
   them. Nothing in that path proved the person authorized the write. It is
   removed: committing is a human gate, and a human does it (AGENTS.md §6).

Principle: **attribution comes from authentication.** Swapping the actorId and
the display name without fixing the credential path would have changed the
label, not the truth.

## What is missing to make this real

1. **`User.ownerId`** — the human an `AGENT` or `SERVICE` is accountable to.
   Without it, "acts on behalf of a human" is prose, and escalation has no
   final human.
2. **Populate `sessionId` — and the rest of the execution context.** The
   column exists and is empty. This is *not* "one line per client": it also
   needs authentication-context propagation, the claim generation binding
   above, and audit coverage for the events a receipt attaches to.
3. **Provisioning for `SERVICE` actors** — issuance today supports `AGENT`
   only, and the directory lists `AGENT` only.
4. **Lifecycle.** `WorkAudit.actor` is `onDelete: SetNull`, so deleting an
   actor orphans its history — exactly the problem this model exists to
   remove. Actors are **deactivated and archived, never deleted**; their id is
   stable forever. Revoking a credential does not touch history. Owner
   departure or transfer needs an explicit hand-over of responsibility and
   permissions.

## Decision receipts — design against this model

A receipt is **the actor's own statement of what it knew and why**, written by
the actor at write time. It is therefore a *claim*, and is always rendered as
one: "claimed by `@mia` in session `S` at `T`".

```
DecisionReceipt {
  auditId          — the write this explains (1:1)
  actorId          — who (redundant with the audit; kept so a receipt is self-describing)
  sessionId        — which execution
  runtime          — descriptive, at time of writing
  contractRevision — what the work item said when the decision was made
  reasoning        — short, the agent's words, bounded
  evidence[]       — files / commits / URLs / other work items it relied on
  inputs[]         — what it was asked, what it read (ids, not transcripts)
}
```

Written through the existing verbs — `work_propose(receipt)`,
`run_report(receipt)`, `agent_request_answer(receipt)` — never as a separate
call, so a write and its receipt land in one transaction or not at all.

Three rules the review added, all necessary for the receipt to actually
support reconstruction later:

- **Identity and time are filled by the server; reasoning and references by
  the agent.** A self-reported `actorId` or execution id that disagrees with
  the audit record is rejected, not stored.
- **`inputs[]` by id alone does not preserve "what it saw".** Comments get
  edited, files change, URLs die. A key reference carries a version, a commit,
  a content digest, or a frozen excerpt; what cannot be preserved is marked
  unknown explicitly. A successor's answer says "from the record saved at the
  time" — it must not imply the original session's full knowledge was recovered.
- **Coverage must be decided before building.** `agent_request_answer` writes
  a comment, evidence and a state change but records **no `WorkAudit`**, so
  "receipt ↔ audit, 1:1" leaves the most important event uncovered. Either
  audit those events too, or let a receipt attach to more than one kind of
  immutable event.

Not stored: transcripts. They are large, format-specific, and belong to the
runtime. The receipt is what an *outsider* needs to reconstruct the decision.

**Human interaction:** the receipt shows on the write's audit entry and on the
agent's page. It is what a successor reads before answering. A human can read it
and disagree in the thread; that disagreement is a comment, not an edit to the
receipt.

## Successor hand-off — design against this model

When a request's target does not answer (deadline, or presence `away`/`stale`
for longer than a threshold), the request is **handed off, not reassigned**:

1. The original request moves to `failed` with reason `handed-off`.
2. A **new** request is opened, linked to the original by root request id, on
   the same thread, targeting in order: `successorActorId` if declared, else
   the target's **owner** (a human), else the team's human owners.
3. The successor answers **in its own name**, and the answer must say so:
   "answering for `@mia`, from receipt `R` and thread `T`". Impersonation is
   rejected at the write — an answer to a handed-off request that claims the
   original actor's identity fails.
4. If the original actor returns, it may add to the thread. The handed-off
   request is not reopened; its statement is a new comment.

A2A states stay untouched: hand-off is a **new** request, so no invented state.

**"Every actor has an owner" does not make the chain terminate.** With
`A.successor = B`, `B.successor = A`, the owner is never reached. So:

- track visited actors; enforce a maximum hop count and a total deadline for
  the whole chain;
- on hitting either limit, **force the hand-off to a valid human** — the
  target's owner, else the team's human owners;
- terminating the old request, opening the new one and linking them is one
  atomic, idempotently retryable step;
- a late answer from the previous holder races the hand-off through the same
  state and claim-generation checks as any other answer; the winner is whoever
  holds the current generation;
- naming a successor grants it nothing: it must already be able to read the
  thread and the receipt, or the hand-off is rejected.

What triggers a hand-off is the request's own **deadline, lease and progress**
— not the actor's global presence. `lastSeenAt` says a credential was used
recently; it says nothing about whether any consumer is working on *this*
request.

What this guarantees is **eventual escalation to a human**. It does not
guarantee that anyone answers.

**Human interaction:** the thread says, in place, "handed to `@kai`" or "handed
to Chris". A human can override — retarget, cancel, or answer themselves.

## Decisions taken

1. **Grain of a coding-CLI actor:** an explicitly registered long-lived role.
   `(runtime × owner)` is the default creation rule, not a uniqueness rule.
   Never per install.
2. **`SERVICE` actors have owners** — as the accountable party and escalation
   target. Ownership grants no permission and does not imply each execution was
   the owner's instruction.
3. **The reflex correction ships before receipts**, and it fixes the
   authentication path, not just the actorId and display name.

## Implementation order

1. Trusted principal context and execution-bound claims. **(done in this PR)**
2. Reflex attribution through authentication; `--commit` removed. **(done)**
3. `User.ownerId`; `SERVICE` provisioning; lifecycle rules.
4. Audit coverage for answer events; then decision receipts.
5. Automatic hand-off, with the termination rules above.
