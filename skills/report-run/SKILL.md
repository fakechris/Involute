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
