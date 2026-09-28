---
name: file-bug
description: File a Type: Bug in Involute. Committed directly — never Candidates. Priority is required because it sets the SLA.
---

# File a bug

Tool: `work_file_bug` (prefer this). Fallback: `work_propose` with `labels: ['bug']`.

## When

The defect is a Type: Bug — found by you or reported by a person in the conversation.

## Required

| Field | Why |
|---|---|
| `team` | Team key |
| `title` | What is broken |
| `priority` | **Sets the SLA.** 1 Urgent 24h, 2 High 48h, 3 Medium 7 days, 4 Low 7 days. Omit and the call is refused. |
| `steps_to_reproduce` | How to see it. Omit and the call is refused. |
| `acceptance` | What must be true when it is fixed. Omit and the call is refused: the bug is committed on filing and agents cannot add acceptance afterwards, so it could never be claimed. |
| `parent_id` or `related_work_id` | Placement. Inherited from related work when `parent_id` is omitted. No live parent → refused. |

Also pass the three-section Chinese `description`. Already fixed: `initial_state: 'REVIEW'`.

## Rules

- A bug is **committed directly**. It does not go to Candidates.
- Do not `work_propose` a bug without `priority` hoping a human will pick SLA later.
- Owner is the agent's human owner. SLA starts at this call.
- Humans who are unsure of the project still use Report bug in the UI (that path may triage).
