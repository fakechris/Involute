# Involute 代码仓库评审报告

> 评审人角色：高级架构师（Staff Engineer）
> 评审日期：2026-04-04
> 评审范围：全仓库，聚焦 M0 里程碑（单团队迁移验收）

---

## 执行摘要

- **方向正确**：仓库在 M0 里程碑上方向清晰，核心导入/验证/看板展示路径已完整实现。
- 代码质量整体偏高：命名统一、错误体系完整、类型安全意识强、monorepo 边界清晰。
- 导入管线幂等性设计（LegacyLinearMapping）是最大的架构亮点，为重复导入奠定了安全基础。
- E2E 覆盖了看板核心生命周期，CI 跑通了 typecheck/lint/test/e2e/build/docker compose build 全流程。
- **M0 最大风险**：
  1. 导入管线中 issue 的 `identifier` 唯一约束与 `nextIssueNumber` 在重复导入/混合手动创建下有碰撞风险。
  2. 硬编码的 6 个 workflow state 名称（`BOARD_COLUMN_ORDER`）在导入的 Linear 团队使用自定义 state 名称时会导致 issue "消失"在看板中。
  3. BoardPage 超过 1000 行，状态逻辑（15+ 个 useState）已接近维护性拐点。
- **三大优势**：
  1. 幂等导入管线 + 映射表 + 自动验证，是整个仓库最有价值的资产。
  2. CLI 的 `import team` 一键导出→导入→验证→摘要的闭环体验非常好。
  3. monorepo 结构和 Docker Compose 编排清晰合理，开箱即用。

---

## 架构判定

**评级：Mostly Sound（大体健全）**

理由：
- monorepo 分包合理，server/web/cli/shared 职责边界清晰，没有循环依赖。
- 数据模型对 M0 场景适度设计，没有过度抽象，也没有明显缺失。
- 导入管线是最大的设计亮点，但 identifier 碰撞和 state 名称硬编码是两个具体威胁 M0 验收的问题。
- Web UI 功能完整，但 BoardPage 的状态管理复杂度正在接近可维护性上限。
- Auth 模型（共享 token + viewer assertion）对 M0 可接受，但 fallback 到 `admin@involute.local` 的行为需要理解其影响。

---

## 按严重性分类的发现

### P0 关键

#### [P0] 硬编码 workflow state 名称导致导入的 issue 在看板中"消失"

- **分类**：ui-state | import-pipeline
- **为什么重要**：这直接威胁 M0 的验收目标——"打开看板，视觉验收导入的数据"。
- **证据**：
  - `packages/web/src/board/constants.ts`: `BOARD_COLUMN_ORDER = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done', 'Canceled']`
  - `packages/web/src/board/utils.ts`: `groupIssuesByState()` 使用 `issue.state.name === stateName` 严格匹配。
  - `packages/server/src/constants.ts`: `DEFAULT_WORKFLOW_STATE_ORDER` 定义了同样的 6 个名称。
  - Linear 导出格式的 `ExportedWorkflowState` 包含任意的 `name` 字段。
- **风险**：
  - 如果 Linear 团队使用 "Todo" 而不是 "Ready"，或 "Closed" 而不是 "Done"，这些 issue 将不会出现在任何看板列中。
  - 用户会看到"issue count looks complete"但看板上看不到这些 issue，造成误导性的验收结果。
  - `validation-data-setup.ts` 的 `backfillImportedTeamStates` 尝试为导入的团队补充规范 state，但这不会修改已有 issue 指向的 state，也不会在看板上显示 Linear 原始的 state 名称。
- **建议**：
  - 方案 A（最小改动）：看板从 API 获取团队实际的 states，动态生成列，而不是使用硬编码的 `BOARD_COLUMN_ORDER`。
  - 方案 B（保守）：在导入管线中增加 state 名称映射（将 Linear 的 state type 映射到 Involute 的规范名称），并在验证步骤中检查是否有 issue 指向了不在 `BOARD_COLUMN_ORDER` 中的 state。
- **置信度**：高

---

#### [P0] `identifier` 唯一约束在重复导入 + 手动创建混合场景下有碰撞风险

- **分类**：data-model | import-pipeline
- **为什么重要**：M0 的验收循环是"反复导入同一个团队"，这个场景下 identifier 碰撞会导致导入失败。
- **证据**：
  - `prisma/schema.prisma` L48: `identifier String @unique`
  - `import-pipeline.ts` L319-334: 导入 issue 时直接使用 `issue.identifier`（如 `SON-42`）调用 `prisma.issue.create`。
  - 幂等保护只在 `existingMappings.has(issue.id)` 层面生效——跳过已有映射的 issue。
  - 但如果用户在导入后手动创建了 issue（走 `issue-service.ts` 的 `createIssue`），`nextIssueNumber` 自增可能产生与下一次导入冲突的 identifier。
  - `updateTeamNextIssueNumbers` 在导入后更新了 `nextIssueNumber`，但如果手动创建的 issue 编号已经用掉了导入 issue 的编号，下次导入同一个 Linear 数据会因为 `identifier` 唯一约束冲突而 crash。
  - `prisma/identifier.ts` 中的 PostgreSQL trigger `assign_issue_identifier` 也操作 `nextIssueNumber`，但只在 `identifier` 为空时分配，导入时 identifier 已提供，所以不会触发自增逻辑。但 trigger 中的 `GREATEST` 逻辑和 `updateTeamNextIssueNumbers` 的逻辑重复，两个写入源竞争同一个字段。
- **风险**：
  - 场景：导入 SON 团队（max identifier SON-150）→ 手动创建 issue（SON-151）→ 重新导入 SON 团队 → 新导入的 issue 尝试 create identifier=SON-151 → unique constraint violation → 导入管线 crash（没有 catch）。
  - 这直接破坏"可重复验收循环"的 M0 目标。
- **建议**：
  - 在 `importIssues` 中，对已存在 identifier 的 issue 使用 `upsert` 而不是 `create`，或者先检查 identifier 是否已存在。
  - 同时考虑在 `identifier` 冲突时生成一个新的 identifier 而不是直接失败。
  - 消除 `updateTeamNextIssueNumbers` 和 PostgreSQL trigger 之间的重复逻辑——目前有两个不同的代码路径写 `nextIssueNumber`。
- **置信度**：高

---

### P1 高

#### [P1] 导入管线对 Linear state 到 Involute state 的映射静默跳过不匹配的 issue

- **分类**：import-pipeline
- **为什么重要**：导入时如果某个 issue 的 `state.id` 在 `stateIdMap` 中找不到映射，该 issue 会被静默跳过（`continue`），不报错、不计入 skipped 计数。
- **证据**：
  - `import-pipeline.ts` L305-309:
    ```ts
    const newTeamId = teamIdMap.get(issue.team.id);
    const newStateId = stateIdMap.get(issue.state.id);
    if (!newTeamId || !newStateId) {
      continue;  // 静默跳过
    }
    ```
  - 同样的问题出现在 workflow state 导入（L197-201）中 `newTeamId` 查找失败时。
  - 同样的问题出现在 comment 导入（L435-438）中 `newIssueId` 查找失败时。
  - 同样的问题出现在 comment 导入（L464-466）中 `newUserId` 为 null 时。
- **风险**：
  - 用户以为导入成功（管线报告 "Import complete"），但部分 issue/comment 被静默丢弃。
  - 验证步骤会捕获计数不一致，但无法告诉用户哪些 issue 被跳过、为什么被跳过。
- **建议**：
  - 在 `ImportResult` 中增加 `silentSkips` 字段，记录每种实体的跳过原因。
  - 至少通过 `onProgress` 回调输出跳过的具体 issue identifier。
- **置信度**：高

---

#### [P1] Auth fallback 到 `admin@involute.local` 导致所有无 viewer assertion 的请求以 admin 身份操作

- **分类**：auth
- **为什么重要**：在 M0 验收场景中，web UI 的 compose 配置没有设置 `VITE_INVOLUTE_VIEWER_ASSERTION`，所以所有请求都会 fallback 到 admin。这在单人使用时不是问题，但会产生两个隐性影响：
  1. `User.isMe` 字段对所有 issue 的 assignee 判断不准确——如果导入的 issue 的 assignee 不是 admin@involute.local，`isMe` 永远返回 false。
  2. comment 创建时使用 admin 用户的 ID，导致导入后手动添加的 comment 作者始终是 admin，而不是导入时匹配的用户。
- **证据**：
  - `auth.ts` L127-143: `getViewerLookup` 在无 viewer assertion 时返回 `{ email: DEFAULT_ADMIN_EMAIL }`。
  - `schema.ts` L477-478: `commentCreate` resolver 调用 `requireAuthentication(context)` 获取 viewer，然后将 `viewer.id` 传给 `createComment`。
  - 如果 `admin@involute.local` 用户不存在（比如数据库是全新的且未 seed），`createGraphQLContext` 中 `prisma.user.findUnique` 返回 null，导致 `context.viewer` 为 null，所有需要认证的操作（commentCreate）都会失败。
- **风险**：对 M0 可接受，但需要确保 seed 流程始终运行。当前 `docker-compose.yml` 中 `SEED_DATABASE` 默认为 true，这是安全的。但如果用户在非 Docker 环境下跳过 seed，会遇到难以诊断的 "Not authenticated" 错误。
- **建议**：
  - 在 README 的 "Local development without Docker" 部分明确提示需要先运行 seed。
  - 考虑在 `createGraphQLContext` 中，当 viewer 查找失败时输出更具体的错误信息（而不是静默返回 viewer: null）。
- **置信度**：高

---

#### [P1] 导入管线中 `nextIssueNumber` 更新存在竞态和重复写入

- **分类**：data-model | import-pipeline
- **为什么重要**：`nextIssueNumber` 由三处代码写入，逻辑可能不一致。
- **证据**：
  1. `import-pipeline.ts` L489-518: `updateTeamNextIssueNumbers` 在导入末尾批量设置 `nextIssueNumber = maxNumber + 1`。
  2. `prisma/identifier.ts` L27-32: PostgreSQL trigger 在每次 insert 时执行 `GREATEST(nextIssueNumber, provided_issue_number)`。
  3. `issue-service.ts` L67-81: `createIssue` 中 `nextIssueNumber: { increment: 1 }`。
  - 如果 trigger 存在（通过 `ensureIssueIdentifierAutomation` 安装），导入期间每个 issue 的 INSERT 都会触发 trigger 更新 `nextIssueNumber`，然后 `updateTeamNextIssueNumbers` 又在末尾覆盖它。两者结果一致（都会设置为 max+1），但 trigger 导致 N 次不必要的 UPDATE。
  - 但如果 trigger 不存在（没人调用 `ensureIssueIdentifierAutomation`），`updateTeamNextIssueNumbers` 是唯一的写入源。当前代码库中搜索后发现 `ensureIssueIdentifierAutomation` 只在 `docker-entrypoint.sh` 和测试中调用。
- **风险**：中等。目前结果正确，但代码阅读者很难理解 `nextIssueNumber` 的最终值是由谁决定的。
- **建议**：选择一个权威写入源，移除另一个，并在代码注释中说明。
- **置信度**：高

---

### P2 中

#### [P2] BoardPage.tsx 超 1000 行，15+ 个 useState，维护性接近拐点

- **分类**：ui-state | maintainability
- **为什么重要**：M1（UI/UX 重新设计）需要在这个文件上做大量修改，当前的复杂度会显著增加重新设计的成本和风险。
- **证据**：
  - `BoardPage.tsx` 共 1082 行。
  - useState 使用：`selectedTeamKey`, `isHydratingAllIssues`, `hydrationFailed`, `issueOverrides`, `createdIssues`, `deletedIssueIds`, `activeIssueId`, `selectedIssueId`, `mutationError`, `isSavingState`, `isCreateOpen`, `createTitle`, `createDescription`, `dragPreviewStateId`, `dragOriginStateId`（15个）。
  - 导出了 7 个函数/常量用于测试：`mergeIssueWithPreservedComments`, `mergeBoardPageQueryResults`, `getDropTargetStateId`, `moveIssueToState`, `DND_ACTIVATION_DISTANCE`, `kanbanCollisionDetection` 等。
- **风险**：不影响 M0 正确性，但增加 M1 重新设计时的风险。
- **建议**：M0 后，将 board state 逻辑提取为自定义 hook（如 `useBoardState`），将 DnD 逻辑提取为 `useBoardDnd`，将 mutation 处理提取为 `useBoardMutations`。
- **置信度**：高

---

#### [P2] GraphQL 查询在 BoardPage 和 mutation 响应中均请求 100 条 comments，数据量大时性能问题

- **分类**：api | performance
- **为什么重要**：`BOARD_PAGE_QUERY` 为每个 issue 请求 `comments(first: 100)`，如果团队有 200 个 issue 且每个有 20 条 comment，单次查询的数据量将非常大。
- **证据**：
  - `packages/web/src/board/queries.ts` L70: `comments(first: 100, orderBy: createdAt)`
  - 每个 mutation 响应（issueUpdate, issueCreate）也返回完整的 comments。
  - schema 的 `buildIssueListInclude` 在请求 comments 时会 include `user`。
- **风险**：对中等规模的导入团队（200+ issues, 1000+ comments），初始加载可能明显变慢。但 M0 关注的是正确性而非性能。
- **建议**：M0 后考虑在 list query 中不请求 comments，只在 detail query 中按需加载。
- **置信度**：中

---

#### [P2] IssueLabel 的 `name` 是全局唯一约束，不支持跨团队同名标签

- **分类**：data-model
- **为什么重要**：M2 多团队导入时，两个 Linear 团队可能有同名但含义不同的标签。
- **证据**：
  - `prisma/schema.prisma` L34: `name String @unique`
  - `import-pipeline.ts` L237-238: label 按 `name` upsert。
- **风险**：不影响 M0（单团队），但会在 M2 造成问题。
- **建议**：M2 前改为 `@@unique([name, teamId])`（需要给 IssueLabel 加 teamId）。或者保持现有设计，将 label 视为全局共享资源——但需要在 M2 文档中明确这个决策。
- **置信度**：高

---

#### [P2] CLI `fetchIssues` 分页正确，但 `fetchIssueComments` 没有分页

- **分类**：cli
- **为什么重要**：CLI 的 `fetchIssueByIdentifier` 只请求第一页（100条）comments，如果 issue 有超过 100 条 comment，CLI 会静默截断。
- **证据**：
  - `packages/cli/src/index.ts` L544-592: `fetchIssueByIdentifier` 中 `comments(first: $first, after: $after)` 使用 `first: CLI_PAGE_SIZE, after: null`，且没有分页循环。
  - `fetchIssueComments` 同样没有分页。
- **风险**：在 M0 的验收中，如果导入的 issue 有大量 comment，CLI 的 `issues show` 和 `comments list` 输出将不完整。
- **建议**：为 comment 查询添加与 `fetchIssues` 相同的分页循环逻辑。
- **置信度**：高

---

#### [P2] `readJsonFile` 无任何运行时校验，恶意或畸形导出数据可导致难以诊断的错误

- **分类**：import-pipeline
- **为什么重要**：`readJsonFile<T>()` 只是 `JSON.parse(content) as T`，没有任何 schema 校验。
- **证据**：
  - `import-pipeline.ts` L104-107 和 `packages/cli/src/commands/shared.ts` L29-31。
  - 如果 `issues.json` 中某个 issue 缺少 `state` 字段，管线会在 `issue.state.id` 处 crash，错误信息为 `Cannot read properties of undefined`。
- **风险**：M0 场景下，用户使用的是自己刚导出的数据，畸形数据的概率低。但如果 Linear API 返回的格式发生变化，导出数据的 schema 可能不符合预期。
- **建议**：在 `runImportPipeline` 开头添加轻量的结构检查（如检查必填字段是否存在），在错误时给出明确提示。不需要引入 zod 等重量级方案。
- **置信度**：中

---

#### [P2] `areIssuesEquivalent` 使用 JSON.stringify 比较，性能和正确性风险

- **分类**：ui-state
- **为什么重要**：这个函数在每次 `baseIssues` 更新时为每个 override 调用，JSON.stringify 的性能和顺序敏感性可能导致问题。
- **证据**：
  - `BoardPage.tsx` L1028-1029: `JSON.stringify(toComparableIssue(left)) === JSON.stringify(toComparableIssue(right))`
  - `toComparableIssue` 中对 `labelIds` 和 `childIds` 做了 sort，对 `comments` 也做了 sort，这减轻了顺序敏感性问题。
- **风险**：当前实现功能正确（因为做了 sort），但在 issue 数量多时可能有性能问题。
- **建议**：M1 后考虑结构化比较或使用 immutable-aware 的比较策略。
- **置信度**：低

---

### P3 低

#### [P3] `orderWorkflowStates` 在 `schema.ts` 和 `issue-service.ts` 中重复实现

- **分类**：maintainability
- **证据**：
  - `schema.ts` L689-699: `orderWorkflowStates(states: WorkflowState[])`
  - `issue-service.ts` L383-394: `orderWorkflowStates(states: WorkflowStateSelection[])`
  - 两个函数逻辑完全相同，只是类型不同。
- **建议**：提取到共享位置（如 `constants.ts` 中添加排序工具函数），使用泛型。
- **置信度**：高

---

#### [P3] `workflowStateOrder` Map 在 `schema.ts` 和 `issue-service.ts` 中也重复声明

- **分类**：maintainability
- **证据**：`schema.ts` L67-69 和 `issue-service.ts` L44-46 完全相同。
- **置信度**：高

---

#### [P3] `runIssueMutation` / `runCommentMutation` / `runIssueDeleteMutation` / `runCommentDeleteMutation` 四个函数逻辑几乎相同

- **分类**：maintainability
- **证据**：`schema.ts` L870-936，四个函数只有类型约束不同，catch 逻辑完全一致。
- **建议**：泛型化为一个 `runMutationWithFallback<T>()` 函数。
- **置信度**：高

---

#### [P3] E2E 只测试了一个流程（create→update→comment→delete comment→delete issue），没有覆盖导入后的看板验收

- **分类**：testing
- **证据**：`e2e/board-flow.spec.ts` 只有一个测试用例。
- **风险**：不影响 M0 的 CI 绿灯，但没有自动化验证导入后的看板展示正确性。
- **建议**：M0 退出前增加一个测试用例：seed 一些数据后检查看板列是否正确展示。
- **置信度**：高

---

### 延迟 / 当前非缺陷

#### [延迟] 共享 token 认证模型

- 当前使用单一 `AUTH_TOKEN` + viewer assertion 的模型对 M0 单人/单团队场景完全足够。M3 明确列为"later"。
- 无需现在投入。

#### [延迟] IssueLabel 缺少颜色字段

- Linear 导出包含 `color`，但 Involute schema 没有存储。
- 这是 M1（视觉重新设计）的范围，不是 M0 缺陷。

#### [延迟] 缺少 priority 字段

- Linear issue 有 `priority`，但 Involute schema 不存储。
- 这属于功能性后续迭代，不影响 M0 迁移验收。

#### [延迟] 多团队 workspace 导入

- 明确在 M2。当前单团队导入路径是正确的。

---

## 交叉分析

### 导入正确性与重放语义

导入管线的幂等性设计（LegacyLinearMapping 表）是整个仓库最有价值的设计决策。每种实体类型（team, workflow_state, label, user, issue, comment）都有独立的 old_id→new_id 映射，重复导入时通过查询映射表跳过已导入的记录。

**主要风险点**：
- identifier 碰撞（见 P0）是重放语义的最大威胁。
- 静默跳过（见 P1）意味着用户无法区分"因为已导入而跳过"和"因为数据缺失而跳过"。
- 验证步骤（`verify.ts`）设计良好，做了实体级别的深度校验（comment body、timestamp、author、issue link），这是一个重要的安全网。

### API 一致性与错误模型

- 错误体系（`errors.ts`）设计良好：明确的 exposed error code 映射、cause chain 追踪、Prisma invalid input 检测。
- 所有 mutation 使用 `success/entity` payload 模式，与 Linear 的 API 风格一致。
- `maskedErrors` 配置确保非预期错误不会泄露内部信息。
- 一个小问题：mutation 失败时返回 `{ success: false, issue: null }`，但不包含错误信息。客户端只知道"失败了"但不知道为什么。对 M0 可接受。

### UI 状态复杂度

- BoardPage 的状态管理策略（baseIssues + issueOverrides + createdIssues + deletedIssueIds → merged allIssues）是一个自制的乐观更新方案。逻辑正确但理解成本高。
- `reconcileIssueOverrides` 和 `reconcileCreatedIssues` 在 `baseIssues` 更新后自动清理过时的 override，避免了 stale state 问题。
- 自动 hydration（`fetchMore` 在 `useEffect` 中自动触发）确保导入后的大量 issue 不会被截断在第一页。
- 最大的状态一致性风险：DnD 操作中的 `handleDragOver` 乐观更新和 `handleDragEnd` 的 mutation 之间的窗口期。代码处理了 cancel 和失败回滚，但逻辑分散在多个 handler 和 state setter 中。

### 信任边界

- bearer token 比较使用 `timingSafeEqual`，viewer assertion 签名也使用 `timingSafeEqual` — 正确。
- viewer assertion 有 TTL 过期检查 — 正确。
- `DEFAULT_AUTH_TOKEN = 'changeme-set-your-token'` 在 dev mode 自动使用 — 对开发体验友好，但如果用户忘记在生产环境修改会有风险。`.env.example` 中的注释提醒了这一点。
- GraphQL URL 运行时覆盖只允许 `127.0.0.1` 和 `localhost` — 正确的安全约束。

### 测试充分性 vs 里程碑

- 单元测试覆盖了 auth、import-pipeline、issue-filter、schema mutations、seed 等核心逻辑。
- CLI 测试覆盖了 export、import、verify 命令。
- Web 测试覆盖了 board state、drag utils、comments、navigation、routing 等。
- E2E 覆盖了完整的 board lifecycle。
- **缺失的关键测试**：
  1. 没有自动化测试验证"导入真实 Linear 数据后看板正确展示"（需要 fixture 数据 + E2E）。
  2. 没有测试 identifier 碰撞场景下的行为。
  3. 没有测试 Linear state 名称与 Involute 规范名称不匹配时的行为。

---

## 最佳下一步行动

### 本周立即修复的 3 件事

1. **修复看板 state 名称硬编码**：让 `getBoardColumns` 从 team 的实际 states 生成列，对不在 `DEFAULT_WORKFLOW_STATE_ORDER` 中的 state 追加到末尾。这是 M0 验收最大的功能性阻断。
2. **修复导入管线的静默跳过**：当 `newTeamId` 或 `newStateId` 查找失败时，记录到 `ImportResult` 的 warning 中，并通过 `onProgress` 回调输出被跳过的 issue identifier。
3. **为 identifier 碰撞添加防护**：在 `importIssues` 中，在 `prisma.issue.create` 前检查 identifier 是否已存在，如果存在则尝试 upsert 或报告冲突。

### M0 绿灯后的 3 个重构

1. 将 BoardPage 的 board state 逻辑拆分为 `useBoardState` / `useBoardDnd` / `useBoardMutations` 自定义 hook。
2. 消除 `orderWorkflowStates` / `workflowStateOrder` 在 `schema.ts` 和 `issue-service.ts` 之间的重复。
3. 为 `nextIssueNumber` 选择一个权威写入源（推荐保留 PostgreSQL trigger，移除 `updateTeamNextIssueNumbers`），消除双写。

### 明确推迟的 3 件事

1. IssueLabel 的 team-scoping（M2 范围）。
2. 多用户认证和权限模型（M3 范围）。
3. 大规模性能优化（M2+ 范围）。

---

## 补丁候选列表

| # | 文件路径 | 变更摘要 | 预期影响 | 变更风险 |
|---|---------|---------|---------|---------|
| 1 | `packages/web/src/board/utils.ts` | `getBoardColumns` 从 team states 动态生成列，fallback 到 `BOARD_COLUMN_ORDER` | 修复导入团队 issue 在看板中消失的 P0 问题 | 低 |
| 2 | `packages/server/src/import-pipeline.ts` | `importIssues` 中对 `newTeamId`/`newStateId` 查找失败时记录 warning | 消除静默数据丢失 | 低 |
| 3 | `packages/server/src/import-pipeline.ts` | `importIssues` 中 create 前检查 identifier 冲突 | 防止重复导入 crash | 中 |
| 4 | `packages/web/src/board/constants.ts` + `utils.ts` | `groupIssuesByState` 改为基于 team states 动态分组 | 配合 P0 修复 | 低 |
| 5 | `packages/server/src/import-pipeline.ts` | 在 `ImportResult` 中增加 `warnings.silentSkips` 字段 | 提高导入可观测性 | 低 |
| 6 | `packages/cli/src/index.ts` | `fetchIssueByIdentifier` 和 `fetchIssueComments` 添加 comment 分页 | 修复 CLI comment 截断 | 低 |
| 7 | `packages/server/src/schema.ts` + `issue-service.ts` | 提取共享的 `orderWorkflowStates` 到 `constants.ts` | 减少重复 | 低 |
| 8 | `packages/server/src/schema.ts` | 合并 4 个 `runXxxMutation` 为 1 个泛型函数 | 减少样板代码 | 低 |
| 9 | `packages/server/src/import-pipeline.ts` | 在 `readJsonFile` 后添加必填字段存在性检查 | 改善错误诊断 | 低 |
| 10 | `e2e/board-flow.spec.ts` | 添加测试用例：seed 后检查看板列内容 | 增强 M0 验收自信 | 低 |

---

## 维护者直言

### 我会保持原样的部分

- **monorepo 结构和包边界**：server/web/cli/shared 分得恰当，没有过度抽象。
- **导入管线的幂等性设计**（LegacyLinearMapping）：这是整个仓库的核心价值，设计正确。
- **验证管线**（`verify.ts`）：深度校验（body、timestamp、author、issue link）比简单的 count 比较可靠得多。
- **认证体系**：shared token + viewer assertion 对 M0 恰到好处，不需要提前投入 M3。
- **CLI 的 `import team` 一键流程**：导出→导入→验证→摘要的闭环是很好的用户体验设计。
- **CI 流程**：typecheck → lint → test → e2e → build → docker compose build 覆盖完整。
- **GraphQL schema 和错误模型**：设计合理，与 Linear 的 API 风格保持一致。

### 我在信任真实 Linear 团队导入前会修改的部分

1. **让看板列基于团队实际的 workflow states 动态生成**——否则任何使用非标准 state 名称的 Linear 团队导入后看板都会"空白"。
2. **修复导入管线中的静默跳过**——导入报告"成功"但实际丢失了部分 issue 是不可接受的。
3. **修复 identifier 碰撞风险**——在"反复导入同一个团队"的核心验收循环中，这个 bug 会直接导致 crash。
4. **确保 `nextIssueNumber` 只有一个权威写入源**——当前的双写（PostgreSQL trigger + `updateTeamNextIssueNumbers`）虽然结果一致，但在 edge case 下（如部分导入中断后重试）可能产生意外。

### 我不会在当前阶段花时间的部分

- 不会投入时间做性能优化（GraphQL query 的 N+1、comments 一次性加载等）——M0 关注正确性。
- 不会投入时间做 IssueLabel 的 team scoping——M2 的问题。
- 不会投入时间做真正的多用户认证——M3 明确列出。
- 不会投入时间做 BoardPage 的大重构——等 M1 UI 重新设计时一起做。
- 不会投入时间为导出数据添加 schema 校验（zod 等）——当前用户自己导出、自己导入，畸形数据概率低。
