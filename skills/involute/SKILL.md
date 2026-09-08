---
name: involute
description: Use Involute as the project-state and work-graph kernel. Start here for the tool map and hard rules; then open the focused skills for search, claim, report, and evidence. Use when tracking tasks, issues, blockers, or delivery contracts outside the current coding session.
---

# Involute (overview)

Involute stores long-lived work identity, contracts, links, status, and evidence. Your coding agent is the working surface — do **not** treat Involute as a TODO list or dump local plan steps into it.

Connect: Streamable HTTP MCP at `http://127.0.0.1:4200/mcp` (local) with `Authorization: Bearer inv_agent_…`. Full client matrix in `docs/agent-setup.md`. Prefer `/mcp/readonly` until you need to create or claim work. **Never commit tokens.**

## Skill index

| Skill | When |
|---|---|
| [search-work](../search-work/SKILL.md) | Find existing work before creating anything |
| [get-context](../get-context/SKILL.md) | Load contract, ancestors, blockers, claim, audits |
| [list-ready](../list-ready/SKILL.md) | Committed, unblocked, unclaimed work |
| [propose-work](../propose-work/SKILL.md) | Candidate only; does not enter ready queue |
| [claim-work](../claim-work/SKILL.md) | Lease ready work after the user chooses it |
| [update-work](../update-work/SKILL.md) | Contract fields with `expected_revision` |
| [report-run](../report-run/SKILL.md) | Phase / block / complete (In Review, never Done) |
| [attach-evidence](../attach-evidence/SKILL.md) | PR/test/artifact URL |
| [agent-setup](../agent-setup/SKILL.md) | Wire MCP + Bearer token (secrets stay out of git) |

## Hard rules (all skills)

1. Search before propose. Duplicate titles are a failure.
2. Fuzzy discoveries go through `work_propose`, never straight to committed issues.
3. Do not create a child unless it can be independently accepted.
4. Do not write local TODOs, grep results, or shell steps into Involute.
5. `work_claim` after the user chooses a ready item — do not grab the whole queue.
6. `work_commit` and candidate rejection are **human** actions. Agents stop and ask.
7. Run complete is not work accepted. **Never** move work to Done yourself.
8. Expanding scope requires `work_update` with `expected_revision` or a new candidate linked `DISCOVERED_DURING`.
9. Keep plans/findings local. Sync only phases, blockers, decisions, and evidence pointers.

## Typical loop

```text
work_list_ready / work_search → work_get_context → work_claim
(local plan — do not upload)
work_update or work_propose for newly confirmed work
run_report + evidence_attach → In Review (human accepts → Done)
```
