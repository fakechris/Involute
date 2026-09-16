# Agent identity is first-class

Status: proposed (v2, revised after review) · 2026-09-16 · INV-573

## The principle

**Every write to the work graph is attributable to a registered actor, and the
system retains honest evidence of who that was.**

Two halves, and the second matters as much as the first: attribution that can be
fabricated, silently dropped, or destroyed later is not attribution.

## What is actually broken today

Verified in this checkout, not assumed:

1. **Internal callers write anonymously.** `INTERNAL_WRITE_ACTOR` carries no
   actorId, so the hotfix reflex and friends produce
   `actorKind: SERVICE, actorId: null`. This is why INV-583 names nobody.
2. **Not every write is audited at all.** `github-webhook-state-machine.ts`
   moves issues between states with a direct `tx.issue.updateMany` and contains
   **zero** `recordWorkAudit` calls. Any design that works by tightening
   `WriteActor` cannot see these writes.
3. **`SERVICE` bypasses the agent permission gate.** `assertActorCan` returns
   immediately unless `actorKind === 'AGENT'` (`claim-service.ts:95`), so a
   SERVICE actor may `commit`, `reject` and `accept` — the three things agents
   are forbidden. **Minting SERVICE actors for automation without fixing this
   first is a privilege escalation.**
4. **Attribution is destructible.** `WorkAudit.actor` is `onDelete: SetNull`,
   and deleting an issue cascades its audits away.
5. **Nothing records where an actor came from.** `User`/`AgentCredential` do not
   store who created the actor, and an audit does not record which credential or
   rights were used.

## Rejected: the escape-hatch gate

The original proposal — require a client-generated UUID, reject the first
unattributed write, admit a retry carrying the same UUID — is rejected, and so
is my own "accept and attribute to a placeholder" variant. Reasons, in order of
severity:

- **A UUID identifies an operation, not a client.** It cannot distinguish "never
  told" from "told and carried on": a client mints a fresh UUID per operation,
  and receiving a response does not prove anyone read it. This kills the gate
  *and* kills the ledger I proposed to replace it with.
- **Admitting on a second attempt requires no new evidence.** Any client that
  retries — automatically or by hand — is through. Enforcement must require
  *new evidence* (authenticating as a registered actor), not another attempt.
- **A placeholder actor grants rights.** Per finding 3 above, `@unidentified-*`
  as a SERVICE actor would be more privileged than a real agent.
- **A per-surface placeholder relocates the anonymity.** `@unidentified-graphql`
  says where a request entered, not which script, credential or owner sent it.
- **"Flip the flag when the ledger is empty" has no exit condition.** An
  append-only ledger never empties, and zero observed events does not prove
  every writer migrated — infrequent jobs may not have run.
- **"Never silent" is unsupported.** `emitOpsAlert` is best-effort with no
  delivery retry (`ops-alerts.ts:17`).

Keep one thing from the proposal: **the client-generated id**, which we already
have as `idempotencyKey`. It is idempotency, not identity. Do not overload it.

## The design

### A. Fix the permission hole first (blocking prerequisite)

`assertActorCan` must decide on an explicit capability set per actor kind, not
on "is it an AGENT". Until this lands, no new SERVICE actors are provisioned.

### B. Close the audit bypasses

An unaudited write is invisible to every other mechanism here. Route the GitHub
state machine (and any peer found by audit) through the audited path, and add a
test asserting that a state transition produces a `WorkAudit`.

### C. Give internal services real, provisioned identities

- A trusted provisioning path for `SERVICE` actors (issuance currently supports
  AGENT only; the directory lists AGENT only).
- Named identities with owners: `@hotfix-reflex`, `@github-webhook`,
  `@github-sync`, each with a declared owner and a deletion policy.
- Explicit actor propagation through every writer; remove the nameless
  `INTERNAL_WRITE_ACTOR` default only after the callers pass a real one.

### D. Compatibility for known legacy writers — allowlisted, not general

For writers we cannot migrate on day one: an **explicit, named, time-bounded
exemption** bound to a specific existing credential and scope. Not a general
placeholder path.

- Invalid, expired, revoked, or absent credentials never enter it. Only a caller
  that is *already authorized through a known credential but lacks individual
  attribution* qualifies — `auth.ts` already distinguishes these cases.
- Each exemption has an owner and an expiry date and is permission-limited.
- Exit condition is the allowlist being empty, which is decidable, unlike "the
  ledger stopped growing".

### E. Preserve honest history

- **Do not backfill.** Labelling existing `actorId: null` rows as
  `@hotfix-reflex` fabricates evidence. Mark them `legacy-unknown` and leave
  them unknown.
- Retain attribution through deletion: tombstone actors rather than
  `SetNull`, and define a retention contract for a deleted issue's audits.
- Enforce non-null `actorId` as a **database constraint at the end** of the
  migration, not as a TypeScript type at the start. A string type proves
  nothing about actor existence, kind, authorization, or that an audit was
  written; runtime validation is still required.

### F. Record the provenance of actors themselves

Store who created an actor and when, and record on each audit which credential
and rights were used. Without this, "who is this and who made it" remains
unanswerable no matter how good the directory page is.

### G. Speaking for someone with no account

An authenticated actor may attach a display name for a human with no actor here,
rendered **"origin claimed by @agent"** — never as verified human authorship.
The claim must not affect permissions, mentions, or actor resolution.

## Migration order

1. Fix `assertActorCan` (A).
2. Close audit bypasses (B).
3. Provision service identities with permissions, owners, deletion policy (C).
4. Propagate explicit actors through all writers; drain old workers.
5. Resolve the idempotency namespace change — keys are scoped
   `team + actor + operation + key`, so moving a caller from one actor to
   another re-opens a key that was already consumed (`idempotency.ts:12`).
6. Mark legacy rows unknown (E); never backfill.
7. Add the DB constraint and deletion-retention contract.
8. Retire allowlisted exemptions as they expire.

## Acceptance

- A state transition from the GitHub webhook produces a `WorkAudit` naming a
  registered service actor.
- `assertActorCan` denies `commit`/`reject`/`accept` to SERVICE actors.
- INV-583-style writes name `@hotfix-reflex`; pre-existing anonymous rows still
  read `legacy-unknown` and are not rewritten.
- An unauthenticated or revoked caller is rejected, never attributed.
- Deleting an issue does not erase who did what.
- Every actor in the directory answers: what am I, who created me, when, with
  what rights, am I alive, what have I done.

## Out of scope

Successor hand-off (INV-556) and decision receipts (docs/54 §B3).
