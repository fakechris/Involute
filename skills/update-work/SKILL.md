---
name: update-work
description: Use when changing Involute work fields with optimistic concurrency via expected_revision, or proposing a change to a committed contract (work_propose_amendment).
---

# Update work

Tool: `work_update`

## When

Scope or acceptance must change mid-flight, or metadata needs a correction.

## How

- Read current `revision` from `work_get_context`.
- Call `work_update` with `expected_revision` and only the fields you mean to change.
- For newly confirmed separate work, prefer `work_propose` + `DISCOVERED_DURING` instead of bloating the parent.
- `work_update` never sets `CANCELED`, and moves work to `DONE` only for a committed research ISSUE (Type: Research, INV-912): its deliverable is the record, so once a person has committed it you may close it. Refused if it is a candidate, not an ISSUE, claimed by another actor, or lacks the three-section description. Everything else stops at In Review.

## Committed work: propose, do not ask

Agents cannot change the contract of committed work (acceptance, scope,
verification, outcome, constraints); `work_update` refuses. When the contract is
wrong — written against an old rule, impossible as stated, missing acceptance —
call `work_propose_amendment` with the new values and a reason that says where
the right rule is written. A person accepts it in one click (it becomes their
edit) or rejects it with a note. Read the outcome in `work_get_context`
(`contractAmendments`). Do not put the fix only in a run summary and ask a
person to retype it.

## Rules

- Expanding scope without update/propose is a failure mode.
- Do not write shell logs or local TODOs into contract fields.
