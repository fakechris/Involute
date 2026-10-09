---
name: claim-work
description: Use when leasing one ready Involute work item after the user selects it. Does not change the human assignee.
---

# Claim work

Tool: `work_claim` (argument: work `id` UUID)

## When

User (or router) picks a ready committed item for you to execute.

## How

- `work_get_context` first.
- Claim with `id` (UUID).
- Start `run_report` status `running` with a short phase/summary.

## Branch name (harness-issued)

- The claim response includes `suggested_branch` (GraphQL `suggestedBranch`): e.g. `feat/inv-456-harness-issued-branch-names`.
- Create your git branch with that name **verbatim**. Never invent branch names containing issue identifiers — the traceability guard only trusts harness-issued references unconditionally.

## Rules

- One claim at a time unless asked otherwise.
- Claim ≠ assignee change.
- If claim fails (lease held), stop and report — do not force.

## Execution ownership (INV-943)

`work_claim` returns a secret `claim_token` and an `executionId`. Keep the token in this execution’s secret state; never put it in a comment, receipt, log or Git. Pass `claim_token` when renewing the lease, reporting a run, attaching evidence, releasing your claim (`work_claim_release`, with a reason), or retracting your own pre-acceptance evidence (`evidence_retract`, with a reason). Sharing an actor identity does not share execution authority. After lease expiry, acquire a new claim and use its new token; old runs cannot resume. A lost token cannot be recovered from context: wait for expiry or ask a person to release the claim in the UI. Completed runs retain their token binding for attaching evidence after completion.

## Approved delivery units

`delivery(action: 'execution_create', work_id, unit_key, expected_grant_revision)` materializes a unit and its predecessors from an approved delivery package; retries in the same generation return the same tasks. It does not accept a new contract. Claim the returned ready task normally. A new goal, contract, path, action or environment requires `work_delivery_propose` and approval in Candidates. Finish implementation runs in Review; the person accepts the entire package from In Review. CI dependency release requires the server's configured GitHub evidence verifier; a PR link or Review state alone is insufficient.
