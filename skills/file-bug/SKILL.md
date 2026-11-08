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
| `acceptance` | What must be true when it is fixed. Omit and the call is refused: the bug is committed on filing, agents cannot write acceptance on committed work (they can only propose it with `work_propose_amendment`, which waits for a person), and without it nobody can claim it. |
| `parent_id` or `related_work_id` | Placement. Inherited from related work when `parent_id` is omitted. No live parent → refused. |

Also pass the three-section Chinese `description`. Already fixed: `initial_state: 'REVIEW'`.

## Screenshot

If you can see the bug, do not leave the picture only in the chat.

- An image already on S3, Aliyun OSS, Qiniu, or a CDN host in `INVOLUTE_IMAGE_HOSTS`: put `![](https://…)` in the description. A presigned URL is fine.
- A local png, jpeg, gif, or webp: after `work_file_bug` returns, `work_attach_file` it (or `involute work attach-file <id> <path>`), then add `![](/uploads/…)` with `work_update` or `work_comment`.

The page renders those addresses. The server does not fetch them. An acceptance picture of the fix goes on the run as `evidence(action: 'attach', kind: 'screenshot', url)`.

## Rules

- A bug is **committed directly**. It does not go to Candidates.
- Do not `work_propose` a bug without `priority` hoping a human will pick SLA later.
- Owner is the agent's human owner. SLA starts at this call.
- Humans who are unsure of the project still use Report bug in the UI (that path may triage).
