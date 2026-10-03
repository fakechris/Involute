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

The `pages` object explicitly marks truncated children, typed links, comments, audits, runs, evidence, verifications, reviews and amendments. Continue each needed section with `work_read_page(id, section, after: pageInfo.endCursor)` while `hasNextPage` is true. Do not treat the initial bundle as the complete history.

For inherited implementation work, also call `work_delivery_context(id)`. Read the approved generation, paths, actions, environments and unit criteria before execution. `technicalReady` is verified CI coverage, not human acceptance. Missing or stale proof blocks a predecessor even if its graph edge was removed. Read candidate decisions with `work_read_page(section: 'delivery_changes')`.
