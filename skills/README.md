# Involute skills (Notion-aligned)

Layout: `skills/<slug>/SKILL.md`. Overview: [involute](involute/SKILL.md). Setup: [`docs/agent-setup.md`](../docs/agent-setup.md). MCP example: [`mcp.json`](../mcp.json).

| Skill | MCP tool(s) | Use when |
|---|---|---|
| [involute](involute/SKILL.md) | `agent_inbox`, `protocol_get_guide` | Starting any Involute session — rules, inbox check (`agent_inbox` + `ack`), and tool map |
| [search-work](search-work/SKILL.md) | `work_search` | Find existing work before propose/claim |
| [get-context](get-context/SKILL.md) | `work_get_context` | Load one work item’s contract and current `commitmentStatus` |
| [list-ready](list-ready/SKILL.md) | `work_list_ready` | Show claimable ready work |
| [propose-work](propose-work/SKILL.md) | `work_propose` | Create a candidate (human commits; decisions arrive in `agent_inbox`) |
| [file-bug](file-bug/SKILL.md) | `work_file_bug` | Type: Bug — committed directly; priority sets SLA |
| [claim-work](claim-work/SKILL.md) | `work_claim` | Lease one ready item |
| [update-work](update-work/SKILL.md) | `work_update` | Change contract with `expected_revision` |
| [report-run](report-run/SKILL.md) | `run_report` | running / blocked / completed → In Review |
| [attach-evidence](attach-evidence/SKILL.md) | `evidence` (action `attach`) | PR/test/artifact URL |
| [agent-setup](agent-setup/SKILL.md) | `protocol_get_guide`, `agent_inbox` | Wire MCP + Bearer (no tokens in git) + optional turn-start `agent_inbox` hook |

Hard rules (status is read via `agent_inbox` / `commitmentStatus`, never remembered; no TODO dumps; agents never Done except committed Type: Research (INV-912); human commit/reject; search before propose) live in the overview skill and are repeated where relevant.
