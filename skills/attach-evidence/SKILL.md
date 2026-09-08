---
name: attach-evidence
description: Use when attaching a durable PR, test, or artifact URL to an Involute run. Also moves work toward In Review.
---

# Attach evidence

Tool: `evidence_attach`

## When

You have a durable pointer (PR URL, CI run, artifact path) proving the run.

## How

- Require `work_id`, `run_id`, `kind`, `url`, short `summary`.
- Prefer https PR/commit URLs; `file://` only for box-local receipts the operator can open.
- Never attach tokens, `.env`, or secret-bearing paths.

## Rules

- Evidence is not a substitute for `run_report` completed.
- Do not invent citations or fake URLs.
