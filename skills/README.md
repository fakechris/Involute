# Involute skills (Notion-aligned)

Layout: `skills/<slug>/SKILL.md`. Overview: [involute](involute/SKILL.md). Setup: [`docs/agent-setup.md`](../docs/agent-setup.md). MCP example: [`mcp.json`](../mcp.json).

| Skill | MCP tool(s) | Use when |
|---|---|---|
| [involute](involute/SKILL.md) | (index) | Starting any Involute session — rules + map |
| [search-work](search-work/SKILL.md) | `work_search` | Find existing work before propose/claim |
| [get-context](get-context/SKILL.md) | `work_get_context` | Load one work item’s contract |
| [list-ready](list-ready/SKILL.md) | `work_list_ready` | Show claimable ready work |
| [propose-work](propose-work/SKILL.md) | `work_propose` | Create a candidate (human commits) |
| [claim-work](claim-work/SKILL.md) | `work_claim` | Lease one ready item |
| [update-work](update-work/SKILL.md) | `work_update` | Change contract with `expected_revision` |
| [report-run](report-run/SKILL.md) | `run_report` | running / blocked / completed → In Review |
| [attach-evidence](attach-evidence/SKILL.md) | `evidence_attach` | PR/test/artifact URL |
| [agent-setup](agent-setup/SKILL.md) | — | Wire MCP + Bearer (no tokens in git) |

Hard rules (no TODO dumps; agents never Done; human commit/reject; search before propose) live in the overview skill and are repeated where relevant.
