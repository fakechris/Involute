---
name: list-ready
description: Use when you need committed, unblocked, unclaimed Involute work the user can choose from.
---

# List ready

Tool: `work_list_ready`

## When

Starting a coding turn, or when the user asks “what’s ready?”

## How

- List ready nodes for the scoped team/repo token.
- Present options to the user; **they** choose.
- Then `work_get_context` → `work_claim`.

## Rules

- Do not claim the whole queue.
- PROJECT roots may appear ready — prefer child ISSUEs unless explicitly routing a project-level task.
