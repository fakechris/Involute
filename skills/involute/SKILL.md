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
| [propose-work](../propose-work/SKILL.md) | Candidate proposal with optional initial_state ('REVIEW'/'STARTED'/'UNSTARTED') |
| [claim-work](../claim-work/SKILL.md) | Lease ready work after the user chooses it |
| [update-work](../update-work/SKILL.md) | Contract fields with `expected_revision` |
| [report-run](../report-run/SKILL.md) | Phase / block / complete (In Review, never Done) |
| [attach-evidence](../attach-evidence/SKILL.md) | PR/test/artifact URL |
| [agent-setup](../agent-setup/SKILL.md) | Wire MCP + Bearer token (secrets stay out of git) |
| [project-onboarding](../project-onboarding/SKILL.md) | Initial repo onboarding, 3-tier tree, reality alignment |

## Hard rules (all skills)

1. Search before propose. Duplicate titles are a failure.
2. Fuzzy discoveries go through `work_propose`, never straight to committed issues. Set `initial_state: 'REVIEW'` for completed features so they commit directly to `In Review`; candidate `initial_state` cannot be `COMPLETED` or `CANCELED`.
3. Do not create a child unless it can be independently accepted.
4. Do not write local TODOs, grep results, or shell steps into Involute.
5. `work_claim` after the user chooses a ready item — do not grab the whole queue. Use the returned `suggested_branch` verbatim as your git branch name; never invent branch names containing issue identifiers.
6. `work_commit` and candidate rejection are **human** actions. Agents stop and ask.
7. Run complete is not work accepted. **Never** move work to Done yourself.
8. Expanding scope requires `work_update` with `expected_revision` or a new candidate linked `DISCOVERED_DURING`.
9. Keep plans/findings local. Sync only phases, blockers, decisions, and evidence pointers.

## Unplanned Work & Hotfix Protocol (即时热修与计划外工作自动闭环法则)

Any bugfix or unplanned modification touching product source code MUST adhere to this automatic reflex:

1. **触发时机 (Trigger)**:
   当 Agent 在排查或重构中，修改了超出当前 Claim 任务原始范围的代码（例如修复了底层公共库、修了系统服务 Bug、更新了通信协议）。
2. **执行原则（动量优先 - Momentum First）**:
   Agent 可以先就地改好代码、通过本地测试，绝不打断修复心流与工程动量。
3. **自动化闭环（禁止幽灵代码 - No Ghost Fixes）**:
   - **在向用户输出回复前，Agent 必须强制调用 `work_propose`**；
   - 参数固定为：
     - `kind: 'ISSUE'`
     - `related_work_id: <当前任务/父里程碑>`
     - `related_work_type: 'DISCOVERED_DURING'`
   - 自动生成标准的结构化中文描述（定位、根因与范围、验证方案）。
4. **汇报义务 (Reporting Accountability)**:
   在最终向用户回复时，必须附带一条：
   > *“排查过程中顺带修复了底层 Bug，已自动向 Involute 提报 `INV-xxx`（DISCOVERED_DURING），证据已挂载。”*

## Typical loop

```text
work_list_ready / work_search → work_get_context → work_claim
(local plan — do not upload)
work_update or work_propose for newly confirmed work
run_report + evidence_attach → In Review (human accepts → Done)
```
