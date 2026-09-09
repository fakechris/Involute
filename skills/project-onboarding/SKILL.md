---
name: project-onboarding
description: Use when onboarding a repository to Involute. Discovers existing TODOs/milestones, proposes a PROJECT root node and MILESTONE/ISSUE tree via MCP, enforces rich Chinese descriptions, aligns codebase reality, links them with CONTAINS, and establishes AGENTS.md.
---

# Project Onboarding (Involute Work-Graph Blueprint)

Tool dependencies: `work_search`, `work_propose`, `work_link`, `work_get_context`, `work_list_ready`, `work_claim`, `run_report`, `evidence_attach`.

## When to use

- A new or existing repository is being connected to Involute for task and work-graph tracking.
- The human user asks: "把当前项目接入 Involute" or "初始化当前项目的 Involute 节点与里程碑".
- An agent opens a codebase and needs to map existing TODOs, milestones, and issues into Involute without creating duplicate or junk records.

---

## The "First-Time Right" Golden Rules (首次接入五大铁律)

1. **Strict 3-Tier Hierarchy (严谨的三层拓扑结构)**:
   - Root: Exactly one `kind: 'PROJECT'` node matching `<owner/repo>`.
   - Mid-tier: Delivery phases as `kind: 'MILESTONE'` linked to PROJECT via `CONTAINS`.
   - Leaf-tier: Independently verifiable tasks as `kind: 'ISSUE'` linked to corresponding MILESTONE via `CONTAINS`.
   - **Never** propose orphan or flat-list issues during onboarding.

2. **Mandatory Rich Structured Chinese Descriptions (强制提供结构化中文详细描述)**:
   - **Absolute prohibition**: `description: null`, empty descriptions, or brief one-line links like `ref docs/foo.md`.
   - Every Milestone and Issue proposed must contain a complete Markdown `description` with:
     - `### 1. 目标与架构定位` (Why it exists, problem solved, architectural role)
     - `### 2. 核心功能与交付范围` (Concrete changes, components, APIs, UI behaviors)
     - `### 3. 验收标准与验证方案` (Concrete test paths, verification commands, exit 0 criteria)

3. **Codebase Reality Alignment (现状与代码真实进度对齐)**:
   - Run tests and inspect commits before deciding status.
   - **Already implemented & passing tests**: After the human commits the candidate, the agent must immediately `work_claim` -> `run_report(completed)` -> `evidence_attach` to move it to `In Review`. **Do NOT leave completed historical work sitting in `Ready`**.
   - **Truly unstarted work**: Remains in `Ready` for future sprint claims.

4. **Zero Scratchpad Pollution (严禁倾倒临时杂质)**:
   - Do NOT dump local grep logs, shell traces, or one-line refactor scratchpad notes into Involute.
   - Only track deliverables with independent acceptance value.

5. **Batch-Friendly Presentation (一键批量审核保障)**:
   - Present a clear markdown tree with Web UI links to the user.
   - Support batch approval via Web UI floating batch bar (`/candidates`) or CLI batch commit (`pnpm candidates:batch-commit`).

---

## Detailed Execution Protocol

### Step 1: Discover Repository Context
1. Detect Git Remote origin:
   ```bash
   git remote get-url origin
   ```
   Normalize to `<owner/repo>` (e.g. `fakechris/Involute`, `fakechris/lumenbox`).
2. Identify Team Key: Defaults to `INV` (or read from project `mcp.json`).
3. Survey codebase structure, existing tests, and architecture.

### Step 2: Check or Propose PROJECT Root Node
1. Search for existing project:
   ```json
   { "name": "work_search", "arguments": { "query": "<owner/repo>", "team_key": "INV" } }
   ```
2. If `kind: 'PROJECT'` with `repository: "<owner/repo>"` exists:
   - Record its `identifier` (e.g. `INV-2`) and UUID `id`.
   - Do **NOT** propose a duplicate project root.
3. If not found, propose the root node:
   ```json
   {
     "name": "work_propose",
     "arguments": {
       "team": "INV",
       "title": "<owner/repo>",
       "kind": "PROJECT",
       "repository": "<owner/repo>",
       "description": "### 仓库定位\n<owner/repo> 的顶级 Work-Graph 根节点，作为所有子里程碑与功能的挂载根基。\n\n### 交付范围\n涵盖全仓库的代码实现、测试用例、自动化流程与运维文档。",
       "scope": "Full repository scope across frontend, backend, and documentation.",
       "outcome": "Canonical top-level work-graph root for this repository.",
       "acceptance": "Repository tracks all milestones and issues under this root.",
       "source": "agent-onboarding"
     }
   }
   ```

### Step 3: Audit Codebase & Propose Milestones & Issues
1. Scan repository sources for roadmaps:
   - `ROADMAP.md`, `MILESTONES.md`, `TODO.md`, `docs/*`.
   - Recent commit logs (`git log -n 30 --oneline`).
   - Vitest / Jest / pytest test suites to determine what is already built and working.
2. For each Milestone (`kind: 'MILESTONE'`):
   - Propose with `related_work_id: <PROJECT_ID>`, `related_work_type: 'CONTAINS'`.
   - Must include complete structured Chinese `description`.
3. For each Issue (`kind: 'ISSUE'`):
   - Propose with `related_work_id: <MILESTONE_ID>`, `related_work_type: 'CONTAINS'`.
   - Must include complete structured Chinese `description`.

### Step 4: Generate or Update `AGENTS.md`
Write `AGENTS.md` in repository root binding:
- Root Project Identifier and UUID.
- MCP connection URLs (developer machine vs VPS local).
- Hard rule: **Agents never unilaterally mark work as Done** (transition to `In Review` with durable evidence; Done is human-reviewed or graded auto-accept).
- Claim-driven execution (`work_claim` before coding).

### Step 5: Present Batch Review to Human
Print a structured summary for the human operator:
1. Root Project & Milestones & Issues hierarchy.
2. Direct link to Candidates review queue: `http://100.114.30.43:4201/candidates?project=<owner/repo>`.
3. Inform the user:
   - "可在 Web 端点击项目胶囊过滤，使用浮动操作栏点击 **Batch Commit (N)** 一键批准";
   - 或对 Agent 下达指令：*"这批全部通过，帮我批量 commit"*。

### Step 6: Post-Commit State Alignment (历史存量状态对齐)
Once committed:
1. Identify items whose features are **already complete and tested in the repository**.
2. For each completed item:
   - Call `work_claim` to lease the task.
   - Call `run_report` with `status: "completed"`, `phase: "Verification"`, and summary.
   - Call `evidence_attach` with `kind: "test"` or `"pr"`, passing test suite path or PR URL.
3. The items move smoothly to **`In Review`**, leaving only genuine pending work in **`Ready`**.
