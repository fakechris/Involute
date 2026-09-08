---
name: update-work
description: Use when changing Involute contract fields (scope, acceptance, etc.) with optimistic concurrency via expected_revision.
---

# Update work

Tool: `work_update`

## When

Scope or acceptance must change mid-flight, or metadata needs a correction.

## How

- Read current `revision` from `work_get_context`.
- Call `work_update` with `expected_revision` and only the fields you mean to change.
- For newly confirmed separate work, prefer `work_propose` + `DISCOVERED_DURING` instead of bloating the parent.

## Rules

- Expanding scope without update/propose is a failure mode.
- Do not write shell logs or local TODOs into contract fields.
