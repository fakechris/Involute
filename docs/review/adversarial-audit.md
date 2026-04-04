# Involute 对抗性审计报告

> 审计核心问题：**我是否信任这个仓库去导入一个真实的 Linear 团队、验证结果、并在看板上使用——且不会出现静默的正确性错误？**
>
> 审计日期：2026-04-04
> 审计员角色：对抗性 Staff Engineer

---

## 一、里程碑感知的审计总结

### M0 目标回顾

M0 的退出标准是：

1. 一个真实的 Linear 团队可以被导入并在看板上视觉验收
2. `pnpm e2e` 本地和 CI 绿灯
3. `docker compose up --build -d db server web` 是稳定的演示路径

### 审计结论

**评级：有条件可信（Yes, with caveats）**

核心导入管线在设计上是正确的——幂等性通过 `LegacyLinearMapping` 表实现，验证管线对 body/timestamp/author/parent-child 做了深度校验，`import team` 命令实现了完整的导出→导入→验证→摘要闭环。这不是玩具代码，而是经过认真工程思考的迁移系统。

但存在两个具体的场景会在真实 Linear 团队导入中导致**用户看到的结果与实际数据不一致**——这正是 M0 验收要解决的核心问题。详见下文。

---

## 二、十大技术风险（按严重性排序）

### 风险 #1：看板硬编码 6 个 state 名称——导入团队的 issue 会"消失"

**类型：当前危险（Dangerous now）**

这是 M0 验收的直接阻断。

**证据链：**

- `packages/web/src/board/constants.ts` L1-8：`BOARD_COLUMN_ORDER` 硬编码为 `['Backlog', 'Ready', 'In Progress', 'In Review', 'Done', 'Canceled']`。
- `packages/web/src/board/utils.ts` L77-94：`groupIssuesByState()` 用 `issue.state.name === stateName` 严格匹配，不在这 6 个名称中的 state 不会出现在任何分组中。
- `packages/server/src/import-pipeline.ts` L179-218：`importWorkflowStates` 忠实地导入 Linear 的原始 state 名称（如 `Triage`、`Todo`、`Started`）。

**失败场景：**

Linear 团队 SON 使用的 workflow state 名称为 `Triage / Todo / In Progress / Done / Cancelled`。导入后：
- `Triage` 和 `Todo` 状态的 issue 不会出现在看板的任何列中
- 用户看到的 issue 计数不完整
- 验证步骤（`import verify`）会通过（它验证的是数据库中的数据，不是看板展示）
- **结果：用户以为导入成功并通过了验证，但看板上丢失了大量 issue——这是最典型的"误导性成功状态"**

**缓解因素：**

- `validation-data-setup.ts` 的 `backfillImportedTeamStates` 会为导入的团队补充 6 个规范 state，但这不会修改已有 issue 指向的 state。
- Backlog 页面（`/backlog`）会展示所有 issue（不按 state 分列），所以用户在 Backlog 视图中可以看到"消失"的 issue——但这要求用户知道去检查。

**严重性：P0**

---

### 风险 #2：`@updatedAt` 注解在导入时覆盖 Linear 原始时间戳

**类型：当前危险（Dangerous now）——静默数据损坏**

**证据链：**

- `packages/server/prisma/schema.prisma` L63：`updatedAt DateTime @updatedAt` 和 L75：`updatedAt DateTime @updatedAt`
- Prisma 的 `@updatedAt` 语义：在每次 `create` 和 `update` 操作时，Prisma 客户端会**自动设置** `updatedAt` 为当前时间，**忽略**用户提供的值。
- `packages/server/src/import-pipeline.ts` L327：`updatedAt: new Date(issue.updatedAt)` 和 L473：`updatedAt: new Date(comment.updatedAt)` 看起来在设置原始时间戳，但 Prisma 的 `@updatedAt` 行为会覆盖这个值。

**验证：**

- `import-pipeline.test.ts` L239-246 测试确认 `issue.updatedAt` 被保留为 `'2024-06-02T15:00:00.000Z'`。这意味着测试通过了——所以 `@updatedAt` 的行为可能在 create 时尊重显式值。
- 经查证：Prisma 的 `@updatedAt` 在 `create` 操作中**如果显式提供了值则尊重该值**，只在 `update` 操作中才强制覆盖。所以导入时的 create 行为是正确的。

**但后续操作会破坏时间戳：**

- 如果用户在看板上修改了导入 issue 的任何字段（如拖拽改变 state），`updatedAt` 会被 Prisma 覆盖为当前时间，永久丢失 Linear 原始的 `updatedAt`。
- `backfillParentIds`（L373-374）调用 `prisma.issue.update`，这会触发 `@updatedAt` 自动更新——所以**所有有 parent 的 issue 的 `updatedAt` 在导入完成时已经被覆盖了**。

**重新验证：**

- `import-pipeline.test.ts` L239-246 只测试了无 parent 的 issue（SON-42）的 `updatedAt`。
- 有 parent 的 issue（SON-44）的 `updatedAt` 没有被测试。
- 如果 SON-44 的 `updatedAt` 被 `backfillParentIds` 覆盖为当前时间，验证步骤可能会报告 timestamp mismatch。

**更正：** `verify.ts` 中 `verifyIssues` 不检查 `updatedAt`（只检查 identifier 和 parentId）。所以验证步骤不会捕获这个问题——**时间戳损坏是静默的**。

**严重性：P1**——不会导致功能错误，但会导致数据不完整。在 M0 "视觉验收" 场景中，如果用户关注时间戳准确性，这是一个问题。

---

### 风险 #3：导入管线静默跳过无法映射的 issue/comment/state

**类型：当前危险（Dangerous now）——静默数据丢失**

**证据链：**

- `import-pipeline.ts` L305-309：`if (!newTeamId || !newStateId) { continue; }` — 没有 skipped 计数、没有 warning、没有 progress 输出。
- `import-pipeline.ts` L197-201：`if (!newTeamId) { continue; }` — workflow state 导入同样静默跳过。
- `import-pipeline.ts` L435-438：`if (!newIssueId) { continue; }` — comment 导入中跳过无法映射的 issue 的 comment。
- `import-pipeline.ts` L464-466：`if (!newUserId) { continue; }` — 有 user 引用但 user 映射失败的 comment 被静默跳过（注意：null user 的 comment 有 fallback 处理，但非 null user 映射失败的 comment 没有）。

**失败场景：**

如果 Linear 导出的 issues.json 中引用了一个不在 workflow_states.json 中的 state（可能因为 Linear API 分页边界或 rate limit 导致导出不完整），该 issue 会被静默跳过。导入报告的 counts 不会反映这个跳过——`counts.issues` 统计的是 `imported + skipped`，而这个 continue 的 issue 既不算 imported 也不算 skipped。

**验证步骤能捕获吗？** `verify.ts` 会检测 mapping 缺失，报告 `X export issues have no import mapping`。所以验证步骤是有效的安全网——但前提是用户运行了 verify。独立运行 `import --file` 不会自动触发 verify。

**严重性：P1**——有安全网（verify），但导入本身的报告是误导性的。

---

### 风险 #4：identifier 碰撞在重复导入场景下导致 crash

**类型：当前危险（Dangerous now）**

**证据链：**

- `prisma/schema.prisma` L48：`identifier String @unique`
- `import-pipeline.ts` L334：`prisma.issue.create({ data })` — 使用 Linear 原始 identifier（如 `SON-42`）
- 幂等保护只看 `existingMappings.has(issue.id)`——如果 mapping 表被清理但 issue 表没清理（或者数据库被部分重置），相同 identifier 的 create 会抛出 unique constraint violation。

**实际风险评估：**

这个场景在正常的 `import team` 流程中不太可能发生，因为 mapping 表和 issue 表是同一个数据库。但如果用户手动删除了 mapping 表的记录（或者数据库恢复了一个不一致的备份），重新导入会 crash。

`import team` 命令在 crash 后会保留导出目录并报告错误，所以不会是静默失败——但用户需要手动介入。

**严重性：P2**——不太可能在正常流程中触发，且失败是显式的（not silent）。

---

### 风险 #5：`nextIssueNumber` 存在双写源

**类型：可接受的当前捷径**

**证据链：**

- `import-pipeline.ts` L489-518：`updateTeamNextIssueNumbers` 在导入末尾设置 `nextIssueNumber = maxNumber + 1`
- `prisma/identifier.ts`：PostgreSQL trigger 在 INSERT 时也更新 `nextIssueNumber`
- 搜索 `ensureIssueIdentifierAutomation` 只在 `identifier.ts` 中定义，当前没有在任何运行路径中调用——trigger 实际上不存在于运行时

**实际风险评估：**

由于 trigger 没有被安装（`ensureIssueIdentifierAutomation` 未被调用），`updateTeamNextIssueNumbers` 是唯一的写入源。这意味着：
- 导入后，`nextIssueNumber` 被正确设置为 max(imported_identifier_number) + 1
- 手动创建 issue 时，`issue-service.ts` 的 `createIssue` 在事务中 increment 后使用

**风险：** 如果将来有人调用 `ensureIssueIdentifierAutomation` 安装了 trigger，就会出现双写。但当前不存在这个问题。

**严重性：P3**——死代码（`identifier.ts`）造成的困惑，但没有运行时影响。

---

### 风险 #6：comment 创建依赖 viewer 身份——导入后的评论与 Linear 作者不一致

**类型：可接受的当前捷径**

**证据链：**

- `schema.ts` L477-478：`commentCreate` resolver 调用 `requireAuthentication(context)` 获取 viewer，用 `viewer.id` 作为 comment author。
- `auth.ts` L127-143：无 viewer assertion 时 fallback 到 `admin@involute.local`。
- 导入的 comment 使用正确的 user 映射（`import-pipeline.ts` L441-444），所以导入的 comment 作者是正确的。
- 但导入后，用户在 UI 中手动添加的 comment 的作者永远是 admin——即使 viewer assertion 指向了其他用户且该用户不存在于数据库中。

**实际风险评估：**

在 M0 的单人/单团队场景中，所有手动操作都以 admin 身份执行是可接受的。导入数据的 comment 作者是正确的。

**严重性：P3**——M3 的范围。

---

### 风险 #7：`BOARD_PAGE_QUERY` 在初始加载时 fetch 全量 issue（auto-hydration）

**类型：未来扩展性问题**

**证据链：**

- `BoardPage.tsx` L60：`ISSUE_PAGE_SIZE = 200`
- `BoardPage.tsx` L191-221：`useEffect` 自动触发 `fetchMore` 直到 `hasNextPage` 为 false。
- `queries.ts` L70：每个 issue 请求 `comments(first: 100)`。

**实际风险评估：**

对于一个 200 issue、500 comment 的团队，全量加载的数据量约 200-500KB JSON——可接受。对于一个 2000 issue 的团队，数据量会增长到 2-5MB，可能导致明显的初始加载延迟。但 M0 不优化性能。

**严重性：P3**——未来扩展性问题。

---

### 风险 #8：BoardPage 超 1000 行、15+ useState——M1 重设计的维护性拐点

**类型：未来扩展性问题**

**证据链：**

- `BoardPage.tsx` 共 1082 行。
- 15 个 useState 调用。
- 乐观更新逻辑（issueOverrides + createdIssues + deletedIssueIds）分散在多个 async 函数中。
- `reconcileIssueOverrides` 和 `reconcileCreatedIssues` 在 `baseIssues` 更新时自动清理——这是正确的，但理解成本高。

**实际风险评估：**

乐观更新逻辑在功能上是正确的——失败回滚、cancel 处理、重复 issue ID 去重都有覆盖。但这是"正确但脆弱"的代码——任何新功能都需要同时考虑多个 state 的交互。

**严重性：P3**——不影响 M0 正确性。

---

### 风险 #9：E2E 不覆盖导入后看板验收路径

**类型：可接受的当前捷径**

**证据链：**

- `e2e/board-flow.spec.ts` 只测试 seed 数据上的 CRUD 生命周期。
- 没有测试"导入 fixture 数据后看板是否正确展示"。
- CI 中（`.github/workflows/ci.yml`）E2E 使用 `pnpm e2e`，只覆盖 board-flow.spec.ts。

**实际风险评估：**

E2E 覆盖了看板的核心交互（创建→更新→评论→删除），但不覆盖导入数据的展示正确性。如果看板 state 硬编码问题（风险 #1）存在，E2E 不会捕获。

**严重性：P2**——但这个风险被 `import verify` 命令部分缓解（verify 检查数据库数据的完整性，但不检查 UI 展示）。

---

### 风险 #10：CLI `fetchIssueByIdentifier` 和 `fetchIssueComments` 没有 comment 分页

**类型：可接受的当前捷径**

**证据链：**

- `packages/cli/src/index.ts` L544-592：`fetchIssueByIdentifier` 中 comments 用 `first: CLI_PAGE_SIZE`（100），`after: null`，无分页循环。
- 同一函数中 issues 列表正确分页（L481-531）。

**实际风险评估：**

如果单个 issue 有超过 100 条 comment，CLI 的 `issues show` 输出会静默截断 comment 列表。在 M0 场景中，这主要影响使用 CLI 做验收检查的准确性。

**严重性：P3**——低概率，且不影响导入正确性。

---

## 三、十大优势（按价值排序）

### 优势 #1：LegacyLinearMapping 表——最有价值的设计决策

`@@unique([oldId, entityType])` + `@@unique([newId, entityType])` 的双向唯一约束确保了映射的双射性质。每种实体类型独立追踪。`import-pipeline.test.ts` L366-380 有显式的双射性测试。这是整个仓库最核心的工程资产。

### 优势 #2：验证管线（verify.ts）的深度和精度

不是简单的 count 比较——对 comment 做了 body/createdAt/updatedAt/issueId/userId 五维校验；对 issue 做了 identifier/parentId 校验；对 workflow state 做了 teamId 交叉校验。verify.test.ts 有 30+ 个测试覆盖了各种失败场景（stale mapping、missing db row、wrong team、wrong author 等）。

### 优势 #3：`import team` 一键闭环

`export` → `import` → `verify` → 写 `involute-import-summary.json` 的完整闭环。验证失败时自动保留导出目录和 summary，成功时可选清理。这是专业的 operator 工具设计。

### 优势 #4：GraphQL mutation 的错误模型

所有 mutation 返回 `{ success, issue/comment/issueId/commentId }` payload。`runIssueMutation` 等 wrapper 捕获 exposed error 和 Prisma invalid input，返回 `{ success: false }` 而不是 500。`graphql-mutations.test.ts` 有 800+ 行测试覆盖了各种边界情况（非 UUID input、cross-team state、self-parent 等）。

### 优势 #5：认证实现的安全工程质量

- `timingSafeEqual` 用于 token 和 viewer assertion 签名比较——防止 timing attack。
- viewer assertion 有 HMAC-SHA256 签名 + TTL 过期检查。
- `maskedErrors` 配置确保非预期错误不泄露内部信息。
- `auth.test.ts` 覆盖了有效/无效/过期 assertion 场景。

### 优势 #6：Docker Compose 编排的工程完整性

- `server-init` 作为 init container 运行 schema push 和 seed——确保 server 启动时数据库已就绪。
- health check 用 `fetch` 而不是 `curl`（Node 镜像不保证有 curl）。
- CLI container 挂载 `.tmp:/exports` 用于导出文件交换。
- E2E 使用独立的 compose project name 和端口，不干扰开发环境。

### 优势 #7：CI 流程覆盖完整且合理

typecheck → lint → test → e2e → build → docker compose build。单一 job 避免了并行 CI 的数据库竞争问题。Playwright 使用独立端口和数据库。

### 优势 #8：monorepo 边界清晰

- server 导出 `import-pipeline` 供 CLI 使用。
- shared 导出 viewer assertion 供 server/web/cli 三方使用。
- 没有循环依赖。CLI 的 Linear 客户端（`packages/cli/src/linear/`）独立于 Involute 的 GraphQL API。

### 优势 #9：乐观更新的失败回滚正确

`BoardPage.tsx` 的 `persistIssueUpdate` 保存 `previousOverride`，mutation 失败时 restore。DnD 的 `handleDragEnd` 在失败时恢复 `originState`。`handleDragCancel` 正确清理。这不是简单的乐观更新——它处理了取消、失败回滚、和 overlay 清理。

### 优势 #10：导入管线的 orphan comment 处理

`import-pipeline.ts` L446-463：当 comment 的 user 为 null（Linear 中的已删除用户）时，创建一个确定性的 fallback user（`orphan-comments@involute.import`），避免丢弃 comment。计数和 progress 输出都报告了这个处理。

---

## 四、文件级详细发现

### `packages/web/src/board/utils.ts` — `groupIssuesByState`

```typescript
// L77-94
export function groupIssuesByState(issues: IssueSummary[]): Record<BoardColumnName, IssueSummary[]> {
  return BOARD_COLUMN_ORDER.reduce(
    (groups, stateName) => ({
      ...groups,
      [stateName]: issues.filter((issue) => issue.state.name === stateName),
    }),
    { Backlog: [], Ready: [], 'In Progress': [], 'In Review': [], Done: [], Canceled: [] }
  );
}
```

**问题：** 返回类型是 `Record<BoardColumnName, ...>`，只有 6 个硬编码的 key。任何不在 `BOARD_COLUMN_ORDER` 中的 state 的 issue 会从看板上完全消失——不会报错、不会告警、不会显示在"其他"分类中。

**影响：** 这是风险 #1 的根本原因。

---

### `packages/server/src/import-pipeline.ts` — `importIssues`

```typescript
// L305-309
const newTeamId = teamIdMap.get(issue.team.id);
const newStateId = stateIdMap.get(issue.state.id);
if (!newTeamId || !newStateId) {
  continue;
}
```

**问题：** 这些 `continue` 没有增加任何 counter 或输出任何 log。`imported` 和 `skipped` 都不会增加。这意味着 `ImportResult.counts.issues` 的值不等于 `imported + skipped + silently_dropped`。

**影响：** 导入报告声称处理了 N 个 issue，但实际上 N 可能小于导出文件中的 issue 数量。如果用户只看导入报告而不运行 verify，会产生虚假的信心。

---

### `packages/server/src/import-pipeline.ts` — `backfillParentIds`

```typescript
// L373-374
await prisma.issue.update({
  where: { id: newChildId },
  data: { parentId: newParentId },
});
```

**问题：** 这个 `update` 操作会触发 Prisma 的 `@updatedAt` 自动更新，将有 parent 的 issue 的 `updatedAt` 覆盖为当前时间。

**影响：** 所有有 parent-child 关系的 issue 的 `updatedAt` 在导入后不会保留 Linear 原始值。这是静默的——没有 warning，verify 不检查 issue 的 `updatedAt`。

---

### `packages/server/src/schema.ts` — issue 查询的 `id` 参数 fallback

```typescript
// L336-363
issue: async (_parent, args, context) => {
  try {
    const issue = await context.prisma.issue.findUnique({
      where: { id: args.id },
      include: buildIssueDetailInclude(),
    });
    if (issue) return issue;
  } catch (error) {
    if (!isPrismaInvalidInputError(error)) throw error;
  }
  return context.prisma.issue.findUnique({
    where: { identifier: args.id },
    include: buildIssueDetailInclude(),
  });
},
```

**评价：正确且有价值的设计。** 先尝试 UUID 查找，如果输入不是 UUID（Prisma 会抛出 PrismaClientValidationError），fallback 到 identifier 查找。这让 CLI 和 web 都可以用 identifier（如 `SON-42`）查找 issue。

---

### `packages/web/src/lib/apollo.tsx` — `createApolloClient` 的 InMemoryCache

```typescript
// L135-138
return new ApolloClient({
  cache: new InMemoryCache(),
  link: authLink.concat(httpLink),
});
```

**评价：** 默认的 `InMemoryCache` 没有自定义 type policies。这意味着：
- Apollo 不会自动更新 board query 中的 issue 列表当 mutation 返回更新后的 issue。
- 代码通过 `issueOverrides` 手动管理乐观状态，绕过了 Apollo cache——这是正确的，因为 board 的 issue 列表来自分页查询，Apollo 的自动 cache 更新对分页 list 不可靠。

**风险：无。** 手动管理乐观状态是分页列表场景的正确策略。

---

### `packages/cli/src/linear/client.ts` — Linear API 认证头

```typescript
// L42-44
headers: {
  'Content-Type': 'application/json',
  'Authorization': this.apiToken,
},
```

**评价：正确。** Linear API 的认证不使用 `Bearer ` 前缀——直接传递 API token。这与 Linear 的官方文档一致。

---

### `packages/server/src/issue-filter.ts` — `assignee.isMe` 无 viewer 时的处理

```typescript
// L84-95
if (assigneeIsMe === true) {
  clauses.push(
    viewerId
      ? { assigneeId: viewerId }
      : { id: { in: [] } }  // 空数组 → 无结果
  );
}
```

**评价：正确。** 当 `viewerId` 为 null（未认证或无 viewer）时，`assignee.isMe = true` 过滤返回空结果而不是 crash。`{ id: { in: [] } }` 在 Prisma 中等价于 `WHERE id IN ()` → 无匹配行。

---

## 五、具体补丁建议

### 补丁 1（P0 修复）：动态生成看板列

**文件：** `packages/web/src/board/utils.ts`

**变更：** `getBoardColumns` 应该从 team 的实际 states 生成列，对不在 `BOARD_COLUMN_ORDER` 中的 state 追加到末尾。

```typescript
export function getBoardColumns(team: TeamSummary | null) {
  const teamStates = team?.states.nodes ?? [];
  const stateIdByName = new Map(teamStates.map((s) => [s.name, s.id]));
  
  // 先按规范顺序排列已知 state
  const orderedColumns = BOARD_COLUMN_ORDER
    .filter((name) => stateIdByName.has(name))
    .map((name) => ({ name, stateId: stateIdByName.get(name)! }));
  
  // 追加不在规范顺序中的 state
  const knownNames = new Set(BOARD_COLUMN_ORDER);
  const extraColumns = teamStates
    .filter((s) => !knownNames.has(s.name as BoardColumnName))
    .map((s) => ({ name: s.name, stateId: s.id }));
  
  return [...orderedColumns, ...extraColumns];
}
```

**同时修改：** `groupIssuesByState` 的返回类型从 `Record<BoardColumnName, ...>` 改为 `Record<string, IssueSummary[]>`，基于实际 states 分组。

**预期影响：** 修复导入团队 issue 在看板中消失的 P0 问题。  
**变更风险：** 低。只涉及 utils 层的分组逻辑。

---

### 补丁 2（P1 修复）：记录导入管线的静默跳过

**文件：** `packages/server/src/import-pipeline.ts`

**变更：** 在每个 `continue` 处增加计数器和 progress 输出。

```typescript
if (!newTeamId || !newStateId) {
  const reason = !newTeamId ? 'team mapping missing' : 'state mapping missing';
  onProgress?.(`  Skipped issue ${issue.identifier}: ${reason}`);
  unmapped++;
  continue;
}
```

在 `ImportResult` 中增加 `warnings.unmappedIssues`、`warnings.unmappedComments` 等字段。

**预期影响：** 消除静默数据丢失。  
**变更风险：** 低。

---

### 补丁 3（P1 修复）：在 backfillParentIds 中保留 updatedAt

**文件：** `packages/server/src/import-pipeline.ts`

**变更：** 在 backfill 前读取原始 `updatedAt`，backfill 后恢复。

```typescript
const existing = await prisma.issue.findUnique({
  where: { id: newChildId },
  select: { parentId: true, updatedAt: true },
});

if (existing?.parentId === newParentId) continue;

await prisma.issue.update({
  where: { id: newChildId },
  data: { parentId: newParentId, updatedAt: existing!.updatedAt },
});
```

**注意：** 由于 `@updatedAt` 的行为，显式传递 `updatedAt` 在 `update` 操作中可能仍然被覆盖。更可靠的方案是使用 `prisma.$executeRaw` 直接执行 SQL UPDATE，绕过 Prisma 的 `@updatedAt` 自动行为。

**预期影响：** 保留导入 issue 的原始 `updatedAt` 时间戳。  
**变更风险：** 中。需要验证 Prisma 的 `@updatedAt` 在 update 中对显式值的处理。

---

### 补丁 4（P2）：E2E 增加导入后看板验收测试

**文件：** `e2e/board-flow.spec.ts`

**变更：** 添加测试用例：
1. 通过 seed 或 fixture 数据创建包含多个 state 的 issue
2. 验证每个 state 的看板列中都有正确的 issue
3. 特别验证非标准 state 名称的 issue 是否出现在看板上

**预期影响：** 直接覆盖风险 #1。  
**变更风险：** 低。

---

### 补丁 5（P3）：消除 `identifier.ts` 的死代码

**文件：** `packages/server/prisma/identifier.ts`

**变更：** 如果决定不使用 PostgreSQL trigger，删除此文件并在 README 中说明 `nextIssueNumber` 由应用层管理。如果将来决定使用 trigger，在导入管线的文档中说明。

**预期影响：** 减少代码阅读者的困惑。  
**变更风险：** 极低。

---

## 六、最终判定

### 我是否信任这个仓库用于真实的单团队迁移演练？

**是的，带有以下限制条件（Yes, with caveats）。**

### 阻断前提条件（必须在使用前修复）

1. **看板 state 名称硬编码（风险 #1）必须修复。** 如果导入的 Linear 团队使用了任何非标准 state 名称（Triage、Todo、Started、Closed 等——这在真实 Linear 团队中极其常见），看板上会丢失 issue，且验证步骤不会捕获这个问题。这直接违反了 M0 的"视觉验收"目标。

### 非阻断但需要意识到的问题

2. **有 parent-child 关系的 issue 的 `updatedAt` 时间戳可能被覆盖。** 这是静默的，不会导致功能错误，但如果迁移目标包括"时间戳准确性"，需要验证。
3. **导入管线的静默跳过需要人工关注。** 如果导入报告的 issue 数量小于导出文件中的数量，需要运行 `import verify` 来确认。`import team` 命令自动运行 verify，所以使用 `import team` 而不是单独的 `import --file` 可以降低这个风险。
4. **CLI 的 comment 列表在超过 100 条时被截断。** 使用 CLI 做验收检查时需要意识到这一点。

### 信任锚点（为什么可以信任）

- **LegacyLinearMapping 表的双射约束 + verify 管线** 构成了一个可靠的正确性验证机制。`import team` 一键命令自动执行整个链条。
- **导入测试覆盖了核心场景**（幂等性、timestamps 保留、parent-child backfill、orphan comment、empty team、mapping bijectivity）。
- **验证测试覆盖了各种失败场景**（stale mapping、missing db row、wrong team/author、timestamp mismatch）。
- **GraphQL mutation 的错误处理是防御性的**——不会因为非法输入导致 500。
- **认证实现使用了正确的密码学原语**（timing-safe comparison、HMAC-SHA256）。

### 一句话总结

> 修复看板 state 硬编码后，这个仓库可以用于真实的单团队 Linear 迁移演练。导入管线的核心逻辑是可靠的，验证管线是仓库最有价值的安全网，CI 覆盖了关键路径。剩余的问题（时间戳覆盖、静默跳过、comment 截断）是需要意识到的限制，而不是阻断性缺陷。
