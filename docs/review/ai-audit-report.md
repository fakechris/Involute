# 🗄️ Involute Repository Audit Report

## 1. 概览 (Milestone-aware Audit Summary)
对 Involute 的代码审计显示，这套系统作为概念验证 (PoC) 和小规模试验已经展现了良好的基础结构设计与架构封装，但**不适合在今天作为实际单一团队的迁移演练与生产环境使用**。其乐观更新机制中存在一个严重的状态破坏漏洞，导入数据幂等性不能在意外中断时完全保证无副作用的恢复，且缺乏细粒度的 GraphQL 权限管控与树形死循环保护逻辑。当务之急需解决数据破坏（Data Corruption）及 Auth 配置安全降级漏洞。

## 2. Top 10 全局技术风险 (Top 10 Technical Risks)
1. **[Dangerous Now] 拖拽操作取消导致状态强制迁移 (UI State Corruption)**: 在 Kanban 面板拖拽并按下 `Escape`（或拖至无效区域）时，会误用回退机制读取 `dragPreviewStateId`，将 issue 强制移动到未确认的预览列。这导致严重的 silently status corruption。
2. **[Dangerous Now] 认证静默降级为 Admin 权限 (Auth Fallback Vulnerability)**: 如果部署时未配置 `INVOLUTE_VIEWER_ASSERTION_SECRET` 参数，Token 验证流程将返回 `null` 并触发后备逻辑自动将身份硬分配给 `DEFAULT_ADMIN_EMAIL`。这意味着掌握主 `AUTH_TOKEN` 的所有端均可获得越权访问。
3. **[Dangerous Now] 导入管道的非事务性插入与映射表不一致 (Non-transactional Imports)**: 在 `import-pipeline.ts` 中，`issue` / `comment` 及其对应的 `legacyLinearMapping` 是通过循环分开 Upsert 并且未用 `$transaction` 包裹。导入中断崩溃后会造成“有实体但无映射”的幽灵状态。
4. **[Dangerous Now] N+1 问题触发数据库严重开销**: 在处理 Issue 导入及 `updateTeamNextIssueNumbers` 中进行了 `for` 循环全量匹配，时间复杂度极大，单团队导入数千条 Issues 及历史评论时会带来极长耗时并可能导致连接池枯竭。
5. **[Scalability] 全量内存加载导致大文件导入 OOM 风险**: 导入幂等去重检测 (`getExistingMappings`) 会提前把所有同类的记录通过 `findMany` 引入服务进程内存的 JavaScript `Map` 中，无法应对庞大体积的 Linear 全历程记录导出文件。
6. **[Dangerous Now] 父子关联无限死循环陷阱 (Infinite Hierarchy Loops)**: GraphQL Schema 设置 `parentId` 仅校验了本身不得成为本身的父类 (`parentId === id`)，但没能防止隐式的 `A -> B -> C -> A` 嵌套。系统在随后渲染或请求其树形层级时极易造成堆栈溢出。
7. **[Acceptable Shortcut for Current Scope] 未实现 GraphQL 节点顺序管理 (Missing Ordering API)**: `UpdateIssueInput` 缺失用来手动标定优先级的游标 (`position`)。拖拽后在 UI 各列上展示的顺序并不能有效持久化保存下来。
8. **[Scalability] GraphQL 查询缺少服务器端防御限制 (Unbounded Query Limits)**: 大量 `first: Int!` 接口请求前未经后台限额校验 (比如 `first: 100000`) ，有可能一次指令就压倒整个数据库计算资源。
9. **[Fidelity] 自动化测试套件缺少异常中断验证与大规模压力测试**: `import-pipeline.test.ts` 测试非常完美的 “乐观路径”。未考虑到文件格式缺失报错、数据库拒绝服务中断回放的幂等效果测试，难以预演真实数据破损行为。
10. **[Acceptable Shortcut for Current Scope] 未封装底层的批量写入能力**: 系统的任何大量批量改动都依赖单个轮询请求或者 O(n) 的独立 GraphQL mutations，缺少了 Batch API 的支持，导致在大体量任务下会有延迟。

## 3. Top 10 全局技术亮点 (Top 10 Strengths)
1. **强大的 Typescript 类型安全约束**: GraphQL Schema 的类型与后端 Prisma ORM 生成的类型定义紧密闭合。定制化的错误类 (`isPrismaInvalidInputError`) 边界分明。
2. **极具现代感的基础骨架与 DND-kit 集成**: 即使核心逻辑伴随瑕疵，但从 `pointerWithin` 等冲突处理配置与 CSS 动画中能看出高水准的数据呈现和拖拽物理反馈设计。
3. **优秀的乐观更新心智模型 (Optimistic Context Reconciling)**: 代码明确区分了 `createdIssues` 和 `issueOverrides` 缓存层，用最小代价局部映射取代了激进的回滚，实现无阻碍刷新体验。
4. **高质量的 CLI Command Router 设计**: `commander` 工具流剥离了规范的 Option / Config 注册，巧妙复用了通过环境变量重写上下文的方法。输出模式高度统一。
5. **抽象且易溯源的 API 侧设计逻辑**: `issue-service.ts` 优雅地封装了深层依赖注入，把业务限制（如：标签是否匹配 Team，能否自我嵌套）写在了 Mutation 函数中。
6. **防御计时器攻击的认证方式**: 对普通 Token 校验使用到了 Node.js `.crypto` 层的 `timingSafeEqual` 工具，符合安全最佳实践。
7. **清晰的 Import Pipeline 纯化步骤处理**: 读取 JSON、处理基础数据字典、按步骤生成外键挂载的阶段步骤具有高度的模块化。
8. **符合 Relay 规范的分页 Cursor 使用设计**: 内部基于 Timestamp + ID 构建的复合 Token `<base64url>` 转译极大的契合了 GraphQL 的官方游标推荐，不存在深层 Offset SQL 损耗。
9. **对 React 内存和阻塞的高效利用**: 通篇极其审慎地使用了 `useMemo` 计算并聚合 `visibleIssues` 与分类列视图，完全消解了重复渲染造成的应用冻结感。
10. **代码基的高可读性与精悍分离**: 没有冗长拖沓的逻辑，结构划分为 `web`、`server`、`cli`、`shared` 四大包结构以及完善的基础配置文件。

## 4. 文件级问题与证据 (File-specific Findings with evidence)

### `packages/web/src/routes/BoardPage.tsx`
- **漏洞类型**: `UI 操作错误还原 (State Integrity Broken)`
- **主要证据**: 第 520 行逻辑：
  `const targetStateId = getDropTargetStateId(event) ?? dragPreviewStateId;`
  如果被拖拽物体被放置在浏览器无效区域、外边距或触发 `Escape` 按键而中止时，获取的 targetState 会被判定为 null。代码本应该退回到起点，它却立刻利用空值合并操作符 `??` 转而提取 `dragPreviewStateId` (最后一个曾滑过但不希望生效的列)，并强制触发 `persistIssueUpdate` 入网库突变。

### `packages/shared/src/viewer-assertion.ts` & `packages/server/src/auth.ts`
- **漏洞类型**: `越权漏洞 (Privilege Escalation & Fallback Access)`
- **主要证据**: 在 `viewer-assertion.ts` 的头部校验流程中，当部署环境变量没有提供密钥：
  `if (!assertion || !secret) { return null; }`
  验证逻辑安静地返回空。然而来到 `auth.ts` 解析中，由于无记录或返回空，请求回退执行并认定用户：
  `return { email: DEFAULT_ADMIN_EMAIL };`
  即所有未配置签名秘钥系统的默认动作都不是阻断或“未认证”，而是不合理地发放系统全局最高行政权限。

### `packages/server/src/import-pipeline.ts`
- **漏洞类型**: `导入数据腐败 (Missing Idempotency Transactions) / 性能退化 (N+1 Querying)`
- **主要证据 1**: 在 `importIssues` 与后续处理节点（如 305 行左右循环处），当实体利用 `upsert` 或 `create` 被存入库中之后，另一条命令 `createMapping` 才向辅助映射表里抛送依赖数据，此时并没有 Prisma `$transaction` 执行保护机制。若在保存阶段二之间崩溃断连，原已产生的 Issue 孤岛无法被下一次重启发现 (`existingMappings.has(X)` 返回错误判定)，必将发生副本重现或丢失父节点关连。
- **主要证据 2**: 第 512 行开始在 `updateTeamNextIssueNumbers`，业务方并非提交一个 SQL `MAX()` 进行聚合，反而依靠在 Javascript 堆栈内存中使用被引入海量 `issues` 的数组利用 `reduce` 和 RegExp 进行逐条比对。

### `packages/server/src/issue-service.ts`
- **漏洞类型**: `逻辑盲点 (Insufficient GraphQL Cycle Checks)`
- **主要证据**: 追踪 Update 逻辑 `if ('parentId' in input)` (第 210 行)。
  服务拦截仅保障了最浅显的一层闭环引用 `input.parentId === id`，但不能预防由多层引用的嵌套死锁行为引起的无限循环关系。

## 5. 具体修复建议 (Concrete Patch Recommendations)

1. **修正看板组件内强制回落状态的问题 (BoardPage.tsx)**:
   - 移除在意外无目的地下退还给 `dragPreviewStateId` 的设计盲点。
   - 实现：直接验证 `targetStateId` 的真伪，若为负或假，直接进入 `originState` 重置刷新态并阻止发起后端请求：
     ```tsx
     const targetStateId = getDropTargetStateId(event);
     if (!targetStateId) {
       // Only restore locally, DO NOT CALL PERSIST OR USE PREVIEW
       if (issue && originState && issue.state.id !== originState.id) { ... }
       return;
     }
     ```

2. **终止危险的 Admin 降级提权行为 (auth.ts)**:
   - 除非客户端指明请求特定凭证模式，系统应该明确隔离普通 API 用户或无权态。不应仅仅抓取到 Default Config 就赋予高级特权。建议一旦由于签报或验证不足均抛错并以 `401 Unauthorized` 中断访问。

3. **重构管道引入逻辑用以完全贯彻 Transaction 幂等保证 (import-pipeline.ts)**:
   - 全部的数据插放必须以 Prisma 批量 API (`createMany`) 实现或者在一个全功能事务体 (`return prisma.$transaction(async (tx) => { ... })`) 中严格保证“数据添加 + mapping 添加”同步提交及回滚。
   - 用高效直接的 `COUNT` 聚合重构通过 `reduce` 解析尾缀的任务序列生成计算器。
   - 对内存去重做分组游标拆片读取，而非在方法起始通过 `findMany` 强制压入字典 `getExistingMappings` 防爆栈。

4. **强化 GraphQL 的保护限额设置 (schema.ts / issue-service.ts)**:
   - 增加关于分页拉取时最大条数 `MAX_TAKE = 100` 的断言约束条件以遏制过度提取资源的行为。
   - 强化树逻辑断层算法，在向 `Issue` 请求建立或覆盖 `parentId` 的 `Mutation` 时，顺藤摸瓜检索三度以下的关联来排查自锁环 (Tree Cycle Guard)。

## 6. 最终审计判断 (Final Judgment)

**判断: “Would you trust this repo for a real single-team migration rehearsal today?” (您今天是否信任并在正式且单团队的环境中使用它执行真实迁移验收？)**

**结果: NO. (否决)**

**核心理由 (Blocking Reasons)**:
1. **无法容忍的 UI 操作破损**：团队在验收拖拽流转过程中必定会试错并将卡片拖出边框或是按下 `ESC` 进行打断。而目前的机制会导致它们像黑洞一样吸入不明区域（`dragPreview`），其破坏行为还是永久入库更新的。极易摧毁用户接纳使用它的信心。
2. **缺乏防坠网络保护网的导入设计**：处理单团队成千上万的历史任务与评论对内存和传输开销都是考验。非原子的 `$transaction` Upserts 会让不小心遭遇超时错码的运维人员重新操作第二次时遇到难以抹平的脏读副本重叠灾难。真实部署迁移演习必须保证绝对无污染反复进退，系统恰在此存在了硬伤。
3. **静默鉴权崩溃**：生产演练不可能将空配置文件放行并通过 Auth Fallback 将操作员推入最高权限状态。这会让跨平台验证或者用户区分等检查工作彻底失效。
