---
name: report-run
description: Use when recording Involute run progress — running, blocked, or completed. Completed runs go to In Review; agents never Done.
---

# Report run

Tool: `run_report`

## When

Starting work, hitting a blocker, or finishing a claim.

## How

- `work_id` + `status` (`running` | `blocked` | `completed`) + short `phase` / `summary`.
- Use `idempotency_key` for safe retries.
- Reuse `run_id` when continuing the same run.
- **No secrets** in summaries.

## Rules

- Completed → In Review. Never move work to Done yourself.
- Do not substitute chat comments for run reports.
- Blocked summaries must name the missing human/input path.

## Declined findings (INV-1432)

A receipt records what you did and why. It must also record what review asked for that you did **not** do — otherwise "why wasn't X handled?" can only be answered from a PR thread or a chat log, if at all.

When a `completed` run went through any review (local codex, PR bots, a person), `receipt.reasoning` lists every finding you declined or deferred, one per line:

- **source** — who raised it (e.g. `codex r2`, `coderabbit #515:491`, a person's handle);
- **finding** — one-line summary;
- **reason** — why not now (out of scope, pre-existing, cost exceeds the stake, disagree because …);
- **where it went** — a new `INV-n`, `won't do`, or `answered in the PR`.

If nothing was declined, write `Declined findings: none.` Fixed findings need no entry here; the commits and PR already show them. A deferral that needs follow-up gets its own item first, and the receipt names it.

## Execution ownership (INV-943)

`work_claim` returns a secret `claim_token` and an `executionId`. Keep the token in this execution’s secret state; never put it in a comment, receipt, log or Git. Pass `claim_token` when renewing the lease, reporting a run, attaching evidence, releasing your claim (`work_claim_release`, with a reason), or retracting your own pre-acceptance evidence (`evidence_retract`, with a reason). Sharing an actor identity does not share execution authority. After lease expiry, acquire a new claim and use its new token; old runs cannot resume. A lost token cannot be recovered from context: wait for expiry or ask a person to release the claim in the UI. Completed runs retain their token binding for attaching evidence after completion.
