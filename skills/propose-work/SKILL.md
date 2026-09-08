---
name: propose-work
description: Use when creating an Involute candidate (not committed). Search first. Humans commit or reject.
---

# Propose work

Tool: `work_propose`

## When

New independently acceptable work discovered during a run, or a scoped follow-up that is not yet committed.

## How

- `work_search` first — abort if a duplicate title/scope exists.
- Include `team`, title, description, acceptance; set `repository` and link `CONTAINS` to the PROJECT when known.
- Candidates do **not** enter the ready queue until a human commits.

## Rules

- Never use propose as a TODO dump.
- Agents do not `work_commit` or reject candidates via MCP — ask the human.
- Fuzzy leftovers → propose + optional `DISCOVERED_DURING` link, not silent scope creep.
