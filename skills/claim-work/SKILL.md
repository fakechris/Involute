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
