---
name: involute
description: Use Involute as the project-state and work-graph kernel. Search, load context, propose candidates, claim ready work, and attach only durable evidence. Use when tracking tasks, issues, blockers, or delivery contracts outside the current coding session.
---

# Involute

Involute stores long-lived work identity, contracts, links, status, and evidence. Codex / Claude Code is the working surface. Do not treat Involute as a TODO list or a place to dump local plan steps.

Connect (any MCP-compatible client; full guide in `docs/agent-setup.md`):

```bash
codex mcp add involute --url https://<host>/mcp
# analysis-only:
codex mcp add involute-readonly --url https://<host>/mcp/readonly
```

```bash
claude mcp add --transport http involute https://<host>/mcp \
  --header "Authorization: Bearer inv_agent_…"
```

Cursor (`.cursor/mcp.json`) and Opencode (`opencode.json`) take a remote
server entry with the same URL plus an
`Authorization: Bearer inv_agent_…` header. Kimi / Droid / Amp / ZCode / Agy
and other clients: add a Streamable HTTP MCP server with that URL + header.

Prefer `/mcp/readonly` until you have been asked to create or claim work.

## Tools

- `work_search` — find existing work before creating anything
- `work_get_context` — load contract, ancestors, blockers, claim, audits
- `work_list_ready` — committed, unblocked, unclaimed work
- `work_propose` — candidate only; does not enter the ready queue
- `work_commit` — humans only; requires acceptance criteria and a human owner
- `work_update` — contract fields with `expected_revision`
- `work_link` — typed relations (`CONTAINS`, `BLOCKS`, `DISCOVERED_DURING`, …)
- `work_claim` — lease work; does not change the human assignee
- `run_report` — high-level phase/block/complete; completed runs go to In Review, never Done
- `evidence_attach` — PR/test/artifact URL; also moves work to In Review

Do not substitute comments for run reports or evidence.

## Rules

1. Search before propose. Duplicate titles are a failure.
2. Fuzzy discoveries and investigation leftovers go through `work_propose`, never straight to committed issues.
3. Do not create a child/sub-issue unless it can be independently accepted.
4. Do not write local TODOs, grep results, or shell steps into Involute.
5. `work_claim` after the user chooses a ready item. Do not grab the whole queue.
6. `work_commit` and candidate rejection are human actions. If you are an agent and commit fails, stop and ask. Do not try to reject work through MCP.
7. Run complete is not work accepted. Never move work to Done yourself.
8. Expanding scope requires `work_update` with `expected_revision` or a new candidate linked `DISCOVERED_DURING`.
9. Keep `task_plan.md` / `findings.md` local. Sync only phases, blockers, decisions, and evidence pointers.

## Typical loop

```text
work_list_ready / work_search
work_get_context
work_claim
(local plan.md — do not upload)
work_update or work_propose for newly confirmed work
```
