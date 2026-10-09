---
name: attach-evidence
description: Use when attaching a durable PR, test, or artifact URL to an Involute run. Also moves work toward In Review.
---

# Attach evidence

Tool: `evidence` with `action: 'attach'` (default; the old name `evidence_attach` still works for one version, INV-1046)

## When

You have a durable pointer (PR URL, CI run, artifact path) proving the run.

## How

- Require `work_id`, `run_id`, `kind`, `url`, short `summary`.
- Prefer https PR/commit URLs; `file://` only for box-local receipts the operator can open.
- Never attach tokens, `.env`, or secret-bearing paths.

## Rules

- Evidence is not a substitute for `run_report` completed.
- Do not invent citations or fake URLs.

## Execution ownership (INV-943)

`work_claim` returns a secret `claim_token` and an `executionId`. Keep the token in this execution’s secret state; never put it in a comment, receipt, log or Git. Pass `claim_token` when renewing the lease, reporting a run, attaching evidence, releasing your claim (`work_claim_release`, with a reason), or retracting your own pre-acceptance evidence (`evidence_retract`, with a reason). Sharing an actor identity does not share execution authority. After lease expiry, acquire a new claim and use its new token; old runs cannot resume. A lost token cannot be recovered from context: wait for expiry or ask a person to release the claim in the UI. Completed runs retain their token binding for attaching evidence after completion.
