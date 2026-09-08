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

## Rules

- One claim at a time unless asked otherwise.
- Claim ≠ assignee change.
- If claim fails (lease held), stop and report — do not force.
