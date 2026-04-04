# Involute Review Triage

日期：2026-04-04  
范围：`docs/review/` 下 4 份 review 文档的逐条 triage。  
方法：不是复述原文，而是把每条 review item 和当前 `main` 分支代码逐条对照，区分 `仍然成立`、`部分成立`、`已修复/已过期`、`当前非缺陷/延期`，再做去重归并。

## 判定口径

- `成立`：当前主线代码中仍然存在，且原 review 的问题表述基本准确。
- `部分成立`：问题方向是对的，但严重性、触发条件或细节表述不准确，或只剩下部分子问题。
- `已修复/已过期`：review 当时可能成立，但当前主线代码已不再成立。
- `当前非缺陷/延期`：这是产品缺口、范围取舍或后续里程碑工作，不计入当前缺陷清单。

## Canonical 问题清单（已去重，按重要性排序）

### G1 [P0] 看板列仍然硬编码 6 个 workflow state，非标准状态的 issue 会在 Board 中“消失”

- 来源合并：`ADV-01`、`CR-01`、`ST-02`
- 当前证据：
  - `packages/web/src/board/constants.ts:1-8` 固定了 `BOARD_COLUMN_ORDER`
  - `packages/web/src/board/utils.ts:58-66` 的 `getBoardColumns()` 仍只按这 6 个名字建列
  - `packages/web/src/board/utils.ts:77-93` 的 `groupIssuesByState()` 仍按 `issue.state.name === stateName` 严格匹配
- 影响：
  - 导入团队若使用 `Todo / Triage / Started / Closed / Cancelled` 等非标准名字，issue 已导入但不出现在 Board 列中
  - `verify` 会通过，UI 仍可能给出误导性“导入成功”观感

### G2 [P0] 导入回放语义仍不稳：非事务写入、静默跳过、identifier 冲突三件事叠在一起

- 来源合并：`AI-03`、`ADV-03`、`ADV-04`、`CR-02`、`CR-03`、`ST-01`、`ST-03`
- 当前证据：
  - `packages/server/src/import-pipeline.ts:299-338`：`prisma.issue.create()` 和 `createMapping()` 分开执行，未包进 `$transaction`
  - `packages/server/src/import-pipeline.ts:305-310`：`newTeamId/newStateId` 缺失直接 `continue`
  - `packages/server/src/import-pipeline.ts:197-200`、`435-438`、`465-466`：workflow state / comment 的映射失败也直接 `continue`
  - `packages/server/src/import-pipeline.ts:319-334`：导入 issue 直接使用原始 `identifier` 做 `create`
  - `packages/server/prisma/schema.prisma:46-49`：`Issue.identifier @unique`
- 影响：
  - 中断时可能出现“实体已创建但 mapping 未落库”的半成功状态
  - 重跑时只依赖 mapping 判断已导入，不能保证重放安全
  - 混入本地新建 issue 后，重导入有机会被 `identifier` 唯一约束直接打断
  - 某些映射缺失现在会静默丢数据，导入 summary 也不精确

### G3 [P1] 鉴权仍会在缺少有效 viewer assertion 时回退到默认 admin 身份

- 来源合并：`AI-02`、`CR-04`、`ST-05`
- 当前证据：
  - `packages/server/src/auth.ts:69-72`：context 总是按 `getViewerLookup()` 查用户
  - `packages/server/src/auth.ts:127-142`：无有效 assertion 时直接 `return { email: DEFAULT_ADMIN_EMAIL }`
  - `packages/server/src/schema.ts:473-490`：`commentCreate` 直接使用 `requireAuthentication(context)` 返回的 viewer 作为作者
- 影响：
  - 只要通过共享 `AUTH_TOKEN`，但 assertion 缺失或无效，就会落到默认 admin 身份
  - 这会把“当前操作者是谁”和“系统默认管理员是谁”混在一起

### G4 [P1] 拖拽取消问题已修一半，但“越界 drop 落到最后预览列”的风险仍在

- 来源合并：`AI-01`、`ST-04`
- 当前证据：
  - `packages/web/src/routes/BoardPage.tsx:822-845`：`onDragCancel` 已经会把 ESC 取消回滚到 `originState`
  - `packages/web/src/routes/BoardPage.tsx:518-543`：`handleDragEnd` 仍然使用 `getDropTargetStateId(event) ?? dragPreviewStateId`
  - `packages/web/src/routes/BoardPage.tsx:617`：`handleDragOver` 会持续刷新 `dragPreviewStateId`
- 判定说明：
  - “按 ESC 取消会错误入库”这部分已经不成立
  - “拖出有效区域/越界释放后可能沿用最后一个 preview 列”这部分仍成立

### G5 [P1] 导入的 `updatedAt` 只能在 create 阶段保住；有 parent 的 issue 会在 backfill 时被覆盖

- 来源合并：`ADV-02`
- 当前证据：
  - `packages/server/src/import-pipeline.ts:326-327`：导入 issue create 时显式写入 `updatedAt`
  - `packages/server/src/import-pipeline.ts:345-376`：`backfillParentIds()` 对有 parent 的 issue 做 `prisma.issue.update({ data: { parentId } })`
  - `packages/server/prisma/schema.prisma:62-63`：`Issue.updatedAt @updatedAt`
- 判定说明：
  - “导入 create 阶段完全保不住 `updatedAt`”不成立
  - “父子回填阶段会触发 `@updatedAt`，导致这部分 issue 的原始时间戳丢失”成立

### G6 [P1] parent cycle guard 仍只防自指，不防多跳环

- 来源合并：`AI-06`
- 当前证据：
  - `packages/server/src/issue-service.ts:203-236`：只检查 `input.parentId === id`，然后校验 parent 存在和 team 一致
  - 没有向上追链检查 `A -> B -> C -> A`
- 影响：
  - 仍然可以构造跨多跳的 parent cycle

### G7 [P2] API/UI 查询防线偏弱：`first` 无上限，Board 仍会拉重 payload

- 来源合并：`AI-08`、`ADV-07`、`CR-07`
- 当前证据：
  - `packages/server/src/schema.ts:364-389`：`issues(first: Int!)` 直接 `take: args.first + 1`，没有 `MAX_TAKE`
  - `packages/server/src/schema.ts:640-668`：`comments(first)` 同样没有上限
  - `packages/web/src/routes/BoardPage.tsx:176-199`：Board 自动 `fetchMore` 直到把整个 team 拉完
  - `e2e/board-flow.spec.ts:1-59`：E2E 仍只覆盖 lifecycle，不覆盖导入大团队后的 Board 展示
- 说明：
  - 当前不是 correctness blocker，但已经是明显的 guardrail 缺口

### G8 [P2] 导入扩展性问题仍在：全量 mapping 预载 + JS 扫描 `nextIssueNumber`

- 来源合并：`AI-04`、`AI-05`、`ST-06`、`ST-07`
- 当前证据：
  - `packages/server/src/import-pipeline.ts:120-128`：`getExistingMappings()` 把某类 mapping 全量 `findMany()` 进内存
  - `packages/server/src/import-pipeline.ts:489-518`：`updateTeamNextIssueNumbers()` 在 JS 里 `filter + reduce + regex`
- 判定说明：
  - “N+1 查询”这个说法并不精确；更准确的问题是“全量内存预载 + JS 端扫描/串行处理”
  - 问题对大导出包仍然成立

### G9 [P2] 验收与异常场景测试仍有明显缺口

- 来源合并：`AI-09`、`ADV-09`、`CR-15`
- 当前证据：
  - `e2e/board-flow.spec.ts:1-59` 仍只有 create/update/comment/delete 的 lifecycle 用例
  - `packages/server/src/import-pipeline.test.ts:175-473` 基本都是 happy-path / idempotent-path，没有“中断后重放”“畸形 JSON”“映射缺失 warning”类覆盖
- 影响：
  - 当前自动化还没有把“真实导入后 Board 正确展示”锁死
  - 也没有把 G2 相关失败模式回归锁住

### G10 [P3] 可维护性债务已形成，但不是当前 blocker

- 来源合并：`ADV-08`、`CR-06`、`CR-11`、`CR-12`、`CR-13`、`CR-14`、`ST-08`
- 当前证据：
  - `packages/web/src/routes/BoardPage.tsx` 仍是超大组件，drag、optimistic merge、hydration、mutation 都耦合在一起
  - `packages/web/src/routes/BoardPage.tsx:1028-1059` 仍使用 `JSON.stringify(toComparableIssue(...))`
  - `packages/server/src/schema.ts:67-70`, `689-699` 与 `packages/server/src/issue-service.ts:44-46`, `383-393` 一套 workflow 排序逻辑重复
  - `packages/server/src/schema.ts:870-936` 仍有四个高度相似的 `runXxxMutation`
- 说明：
  - 这些问题真实存在，但当前更像 M1 重构负债，而不是 M0/M0.5 correctness bug

### G11 [P3] `IssueLabel.name` 全局唯一，跨团队同名标签仍不支持

- 来源合并：`CR-08`
- 当前证据：
  - `packages/server/prisma/schema.prisma:32-35`：`IssueLabel.name @unique`
- 说明：
  - 这是当前 schema 限制，单团队可接受，多团队导入前必须重做

### G12 [P3] 导入 JSON 仍缺运行时结构校验

- 来源合并：`CR-10`
- 当前证据：
  - `packages/server/src/import-pipeline.ts:104-106`：`JSON.parse(...) as T`
  - `packages/cli/src/commands/shared.ts:29-31`：同样是 `JSON.parse(...) as T`
- 说明：
  - 当前是诊断质量问题，不是主流程 blocker
  - 但一旦 export 格式漂移，错误会很难读

## 逐条回应矩阵

说明：

- `去重` 列中的 `-> Gx` 表示该条已并入上面的 canonical 问题。
- `无` 表示这条不进入当前缺陷清单。
- 本节只覆盖 review 里的“发现项/延期项”，不重复收录 strengths、patch 建议和结论段。

## A. `ai-audit-report.md`

1. `AI-01` 拖拽操作取消导致状态强制迁移
   - 判定：部分成立
   - 证据：`packages/web/src/routes/BoardPage.tsx:518-543`, `821-845`
   - 去重：`-> G4`
   - 说明：ESC 取消已在 `onDragCancel` 回滚；但 `handleDragEnd` 仍对无效 drop 使用 `dragPreviewStateId` 回退。

2. `AI-02` 认证静默降级为 Admin 权限
   - 判定：成立
   - 证据：`packages/server/src/auth.ts:69-72`, `127-142`
   - 去重：`-> G3`

3. `AI-03` 导入管道非事务性插入与映射表不一致
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:299-338`, `469-480`
   - 去重：`-> G2`

4. `AI-04` N+1 问题触发数据库严重开销
   - 判定：部分成立
   - 证据：`packages/server/src/import-pipeline.ts:120-128`, `489-518`
   - 去重：`-> G8`
   - 说明：问题方向对，但更准确的表述是“全量内存预载 + JS 扫描/串行处理”，不完全是经典 N+1。

5. `AI-05` 全量内存加载导致大文件导入 OOM 风险
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:120-128`
   - 去重：`-> G8`

6. `AI-06` 父子关联无限死循环陷阱
   - 判定：成立
   - 证据：`packages/server/src/issue-service.ts:203-236`
   - 去重：`-> G6`

7. `AI-07` 未实现 GraphQL 节点顺序管理
   - 判定：当前非缺陷/延期
   - 证据：`packages/server/src/issue-service.ts`, `packages/server/prisma/schema.prisma`
   - 去重：无
   - 说明：这是明确的产品缺口，不是当前 bug。

8. `AI-08` GraphQL 查询缺少服务器端防御限制
   - 判定：成立
   - 证据：`packages/server/src/schema.ts:364-389`, `640-668`
   - 去重：`-> G7`

9. `AI-09` 自动化测试缺少异常中断验证与大规模压力测试
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.test.ts:175-473`, `e2e/board-flow.spec.ts:1-59`
   - 去重：`-> G9`

10. `AI-10` 未封装底层批量写入能力
    - 判定：当前非缺陷/延期
    - 证据：现有 schema/CLI 均以单条 mutation 为产品边界
    - 去重：无
    - 说明：是规模化能力缺口，不是当前 defect。

## B. `adversarial-audit.md`

1. `ADV-01` 看板硬编码 6 个 state 名称
   - 判定：成立
   - 证据：`packages/web/src/board/constants.ts:1-8`, `packages/web/src/board/utils.ts:58-93`
   - 去重：`-> G1`

2. `ADV-02` `@updatedAt` 导入时覆盖 Linear 原始时间戳
   - 判定：部分成立
   - 证据：`packages/server/src/import-pipeline.ts:326-327`, `345-376`; `packages/server/prisma/schema.prisma:62-63`
   - 去重：`-> G5`
   - 说明：create 阶段显式提供 `updatedAt` 仍能保住；但 `backfillParentIds()` 的 update 会覆盖 parent issue 的原始时间戳。

3. `ADV-03` 导入管线静默跳过无法映射的 issue/comment/state
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:197-200`, `305-310`, `435-438`, `465-466`
   - 去重：`-> G2`

4. `ADV-04` identifier 碰撞在重复导入场景下导致 crash
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:319-334`; `packages/server/prisma/schema.prisma:46-49`
   - 去重：`-> G2`

5. `ADV-05` `nextIssueNumber` 存在双写源
   - 判定：已过期/当前不成立
   - 证据：`packages/server/prisma/identifier.ts:51-54` 定义了 trigger 安装函数，但 `packages/server/docker-entrypoint.sh:1-4` 和 `docker-compose.yml:16-32` 当前运行路径并未调用它
   - 去重：无
   - 说明：这是死代码/认知负担，不是当前运行态缺陷。

6. `ADV-06` comment 创建依赖 viewer 身份，导入后的评论与 Linear 作者不一致
   - 判定：当前非缺陷/产品边界
   - 证据：导入 comment 仍按映射用户导入，新增 comment 则按当前 viewer 写入
   - 去重：无
   - 说明：导入数据作者正确；“后续人工新建 comment 不是 Linear 原作者”本身不是 bug。

7. `ADV-07` `BOARD_PAGE_QUERY` 初始加载自动拉全量 issue
   - 判定：成立
   - 证据：`packages/web/src/routes/BoardPage.tsx:176-199`
   - 去重：`-> G7`

8. `ADV-08` BoardPage 超 1000 行、15+ useState
   - 判定：成立
   - 证据：`packages/web/src/routes/BoardPage.tsx`
   - 去重：`-> G10`

9. `ADV-09` E2E 不覆盖导入后看板验收路径
   - 判定：成立
   - 证据：`e2e/board-flow.spec.ts:1-59`
   - 去重：`-> G9`

10. `ADV-10` CLI `fetchIssueByIdentifier` 和 `fetchIssueComments` 没有 comment 分页
    - 判定：已修复/已过期
    - 证据：`packages/cli/src/index.ts:534-653`, `834-930`
    - 去重：无

## C. `code-review.md`

1. `CR-01` 硬编码 workflow state 名称导致导入 issue 在看板中消失
   - 判定：成立
   - 证据：`packages/web/src/board/constants.ts:1-8`, `packages/web/src/board/utils.ts:58-93`
   - 去重：`-> G1`

2. `CR-02` `identifier` 唯一约束在重复导入 + 手动创建混合场景下有碰撞风险
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:319-334`; `packages/server/prisma/schema.prisma:46-49`
   - 去重：`-> G2`

3. `CR-03` 导入管线静默跳过不匹配 issue
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:197-200`, `305-310`, `435-438`, `465-466`
   - 去重：`-> G2`

4. `CR-04` Auth fallback 到默认 admin
   - 判定：成立
   - 证据：`packages/server/src/auth.ts:127-142`
   - 去重：`-> G3`

5. `CR-05` `nextIssueNumber` 更新存在竞态和重复写入
   - 判定：部分成立
   - 证据：`packages/server/src/import-pipeline.ts:489-518`, `packages/server/src/issue-service.ts:67-92`, `packages/server/prisma/identifier.ts:51-54`
   - 去重：无
   - 说明：`updateTeamNextIssueNumbers()` 与 `createIssue()` 确实都写 `nextIssueNumber`，但 review 里依赖“trigger 已安装”的部分在当前运行态不成立。

6. `CR-06` BoardPage.tsx 维护性接近拐点
   - 判定：成立
   - 证据：`packages/web/src/routes/BoardPage.tsx`
   - 去重：`-> G10`

7. `CR-07` BoardPage / mutation 响应请求 comments 过重
   - 判定：成立
   - 证据：`packages/server/src/schema.ts:374-380`, `640-668`; `packages/web/src/routes/BoardPage.tsx:176-199`
   - 去重：`-> G7`

8. `CR-08` IssueLabel 的 `name` 是全局唯一
   - 判定：成立
   - 证据：`packages/server/prisma/schema.prisma:32-35`
   - 去重：`-> G11`

9. `CR-09` CLI `fetchIssueComments` 没有分页
   - 判定：已修复/已过期
   - 证据：`packages/cli/src/index.ts:534-653`, `834-930`
   - 去重：无

10. `CR-10` `readJsonFile` 无运行时校验
    - 判定：成立
    - 证据：`packages/server/src/import-pipeline.ts:104-106`; `packages/cli/src/commands/shared.ts:29-31`
    - 去重：`-> G12`

11. `CR-11` `areIssuesEquivalent` 使用 JSON.stringify
    - 判定：部分成立
    - 证据：`packages/web/src/routes/BoardPage.tsx:1028-1059`
    - 去重：`-> G10`
    - 说明：正确性风险被排序逻辑部分缓解；主要还是低优先级性能/维护性债务。

12. `CR-12` `orderWorkflowStates` 重复实现
   - 判定：成立
   - 证据：`packages/server/src/schema.ts:689-699`, `packages/server/src/issue-service.ts:383-393`
   - 去重：`-> G10`

13. `CR-13` `workflowStateOrder` Map 重复声明
    - 判定：成立
    - 证据：`packages/server/src/schema.ts:57-60`, `packages/server/src/issue-service.ts:44-46`
    - 去重：`-> G10`

14. `CR-14` 4 个 `runXxxMutation` 高度重复
    - 判定：成立
    - 证据：`packages/server/src/schema.ts:870-936`
    - 去重：`-> G10`

15. `CR-15` E2E 没有覆盖导入后的看板验收
    - 判定：成立
    - 证据：`e2e/board-flow.spec.ts:1-59`
    - 去重：`-> G9`

16. `CR-16` 共享 token 认证模型
    - 判定：当前非缺陷/延期
    - 证据：当前产品仍是单实例/轻量身份模型
    - 去重：无

17. `CR-17` IssueLabel 缺少颜色字段
    - 判定：当前非缺陷/延期
    - 证据：schema 当前确实无 color，但属于 M1/M2 功能扩展
    - 去重：无

18. `CR-18` 缺少 priority 字段
    - 判定：当前非缺陷/延期
    - 证据：schema 当前确实无 priority，但不是当前 defect
    - 去重：无

19. `CR-19` 多团队 workspace 导入
    - 判定：当前非缺陷/延期
    - 证据：当前里程碑仍是单 team 导入
    - 去重：无

## D. `staff-audit-report.md`

1. `ST-01` Identifier uniqueness collisions in mixed import scenarios
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:319-334`; `packages/server/prisma/schema.prisma:46-49`
   - 去重：`-> G2`

2. `ST-02` Hardcoded workflow states cause imported issues to disappear
   - 判定：成立
   - 证据：`packages/web/src/board/constants.ts:1-8`, `packages/web/src/board/utils.ts:58-93`
   - 去重：`-> G1`

3. `ST-03` Non-transactional import entity/mapping insertion
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:299-338`, `469-480`
   - 去重：`-> G2`

4. `ST-04` Cancelled DnD interactions commit to wrong state
   - 判定：部分成立
   - 证据：`packages/web/src/routes/BoardPage.tsx:518-543`, `821-845`
   - 去重：`-> G4`
   - 说明：ESC cancel 已修；越界 drop 仍有风险。

5. `ST-05` Silent escalation of privileges via Admin Fallback
   - 判定：成立
   - 证据：`packages/server/src/auth.ts:127-142`
   - 去重：`-> G3`

6. `ST-06` In-memory map iteration risks OOM on large exports
   - 判定：成立
   - 证据：`packages/server/src/import-pipeline.ts:120-128`
   - 去重：`-> G8`

7. `ST-07` N+1 calculation for nextIssueNumber
   - 判定：部分成立
   - 证据：`packages/server/src/import-pipeline.ts:489-518`
   - 去重：`-> G8`
   - 说明：问题点存在，但更准确是 JS 端全量扫描，不是典型 DB N+1。

8. `ST-08` Redundant `orderWorkflowStates` implementations
   - 判定：成立
   - 证据：`packages/server/src/schema.ts:689-699`, `packages/server/src/issue-service.ts:383-393`
   - 去重：`-> G10`

9. `ST-09` Missing Issue Position/Ordering
   - 判定：当前非缺陷/延期
   - 证据：当前 schema 没有 `position` 字段，但这是 roadmap 范围
   - 去重：无

## 已确认过期或不计入当前缺陷清单的高频条目

- CLI comment 分页缺失：当前已修，`packages/cli/src/index.ts:534-653`, `834-930`
- ESC 取消拖拽必然错误入库：当前不成立，`onDragCancel` 已处理；剩的是越界 drop 风险
- `nextIssueNumber` 运行时双写：当前主运行路径未安装 identifier trigger，不算现时缺陷
- ordering / priority / color / batch API / workspace import：当前都属于 roadmap 缺口，不计入 defect

## 建议的下一步执行顺序

1. 先修 `G1` 和 `G2`
   - 这是最直接影响“真实 team 导入后可视化验收”的 correctness 问题
2. 再修 `G3` 和 `G4`
   - 这两项分别影响信任边界和日常交互一致性
3. 然后补 `G5`、`G6`、`G9`
   - 它们会决定系统在反复演练和数据可信度上的上限
4. 最后再处理 `G7`、`G8`、`G10`、`G11`、`G12`
   - 这些更偏 guardrail、扩展性和维护性收口
