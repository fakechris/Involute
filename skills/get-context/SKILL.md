---
name: get-context
description: Use when you need the full contract for one Involute work item — ancestors, blockers, active claim, and audits — before claiming or reporting.
---

# Get context

Tool: `work_get_context` (argument: work `id` UUID)

## When

After search/list-ready picks a target, and before claim / update / run_report.

## How

- Pass the work UUID (`id`), not only the public identifier.
- Read acceptance, constraints, parent PROJECT, and blockers.
- Note `revision` for later `work_update` (`expected_revision`).

## Rules

- Context stays in your session — do not paste huge dumps back into Involute as comments.
