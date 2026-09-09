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
- Include `team`, `title`, and `description`.
- **Hierarchy (`parent_id`)**: Always pass `parent_id` (e.g. `INV-2` or parent UUID) when nesting an Issue under a Milestone or Milestone under a Project. This guarantees top-down `CONTAINS` linking and prevents relationship inversion.
- **Mandatory Structured Chinese Description**:
  Every proposal must follow the 3-section format:
  - `### 1. 目标与架构定位`: Role in system architecture, rationale.
  - `### 2. 核心功能与交付范围`: Modules, APIs, components affected.
  - `### 3. 验收标准与验证方案`: Concrete vitest/jest commands, exit 0 criteria.
- Set `repository` (e.g. `fakechris/Involute`) and `kind` (`ISSUE`, `MILESTONE`, `PROJECT`).
- Candidates do **not** enter the ready queue until committed by a human (via Web UI `/candidates` or `pnpm candidates:batch-commit`).

## Rules

- Never use propose as a TODO dump.
- Agents do not unilaterally `work_commit` or reject candidates via MCP — humans commit.
- For unplanned hotfixes / bugfixes: run `pnpm hotfix:reflex` to propose and link with `DISCOVERED_DURING`.
- All production code changes must link to a committed `INV-xxx` (enforced by Layer 1 Git guardrail).
