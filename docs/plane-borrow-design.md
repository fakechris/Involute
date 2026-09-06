# Plane 借鉴项融入设计

来源：2026-09 对 [makeplane/plane](https://github.com/makeplane/plane)（CE，AGPL）的对比研究。
每项设计独立可发布、可回滚；不改变公共标识符（`SON-42`、`revision`、MCP 工具名）；冻结面（Inbox/Cycles/Projects/MyIssues/Views 的产品语义）不动。

> **实施状态（2026-09-06）**：W1–W8 全部落地。与原设计的两处偏差：W6 IQL 的
> webhook 过滤在投递时对 work 快照求值（flush 批量加载，比原稿的 enqueue 时
> 求值更正确）；W6c 的 web 保存视图在客户端用共享解析器求值（`link:`/`has:`
> 字段客户端不判 Match）。另增两处计划外事项：`GET /ready` 就绪探针、AIO
> 镜像由 API 进程直接托管 web 静态构建（`INVOLUTE_WEB_DIST`）。

工作项编号 `W1`–`W8`，实施顺序见文末 roadmap。

---

## W1 看板列排序修正（状态组优先）

### 现状与差距

看板列已经是按真实 `WorkflowState` 行构建（`getBoardColumns` 按 `stateId` 建列，DnD 走 `issueUpdate { stateId }`，BOARD_PAGE_QUERY 已取 `team.states`），所以「导入的自定义状态被藏掉」不成立。真正的问题只剩排序：`packages/web/src/board/utils.ts` 的 `compareBoardStates`（utils.ts:278-290）按**状态名字符串**在 `BOARD_COLUMN_ORDER = ['Backlog','Ready','In Progress','In Review','Done','Canceled']` 中的下标排序，自定义名（Linear 导入的 `In Development`、`UAT` 等）全部落到队尾再按字母排，看板分组语义丢失。

### 设计

改排序规则为 Plane 的「closed group + open states」语义：**组枚举封闭，状态命名开放，排序先看组**。

```
compareStates(a, b):
  1. STATE_TYPE_ORDER = [BACKLOG, UNSTARTED, STARTED, REVIEW, COMPLETED, CANCELED]
     按 a.type / b.type 在表中的下标升序
  2. 同组按 position 升序
  3. 再按 name localeCompare（稳定兜底）
```

- 改动点 1：`packages/web/src/board/utils.ts` `compareBoardStates` 按上述规则重写；删除对 `BOARD_COLUMN_ORDER` 名字下标的依赖（常量文件可整体删除，`BoardColumnName` 类型一并清理）。
- 改动点 2：`packages/server/src/workflow-state-order.ts` 的 `orderWorkflowStates`（`Team.states` resolver 用它排序）对齐同一规则，使 CLI `states list`、web、MCP 看到的顺序一致。实现时先核对其现有实现，若已是 type→position 则只对齐残差。
- 不引入 group 表头/分栏折叠——v1 保持扁平列，组顺序天然把 Done/Canceled 推到最右。

### 测试与验收

- web 单测：混合状态集（如 `Idea/BACKLOG pos0`、`In Development/STARTED pos3`、`UAT/REVIEW pos0`、`Shipped/COMPLETED pos9`）断言列顺序为组序而非字典序。
- server 单测：`orderWorkflowStates` 同一断言。
- 既有 e2e「renders imported workflow states on the board」扩展断言列顺序。
- 验收：导入 Linear 团队后，看板列按 Backlog 组 → 进行中组 → 审查组 → 完成/取消组排列。

工作量：0.5 天。关闭 staff-audit 的 hardcoded-columns 项。

---

## W2 通知最小闭环

### 现状与差距

无 `Notification` 模型、无邮件；`/inbox` 是前端从 issue 查询现推的假收件箱（InboxPage.tsx `deriveEntries`，冻结不动）。核心风险在 human gate：`decision.requested` 只有打开网页才可见，agent 报告完成后无人被提醒。

### 数据模型（Prisma，单个 additive migration）

```prisma
model Notification {
  id            String    @id @default(cuid())
  userId        String
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  teamId        String?
  type          String    // decision.requested | run.completed | work.accepted | work.review_rejected | webhook.disabled
  workId        String?
  work          Issue?    @relation(fields: [workId], references: [id], onDelete: Cascade)
  sourceEventId String?   // EventOutbox.id，投影幂等键
  payload       Json      @default("{}")   // { runPublicId, evidenceCount, reason, ... }
  readAt        DateTime?
  emailedAt     DateTime?                  // 邮件通道水位
  emailAttempts Int       @default(0)
  createdAt     DateTime  @default(now())

  @@unique([sourceEventId, userId])
  @@index([userId, readAt, createdAt])
}
```

`@@unique([sourceEventId, userId])` 保证 exactly-once 投影；邮件失败靠 `emailedAt IS NULL AND emailAttempts < 5` 重扫。

### 产生路径：事务内同步投影（不走 outbox 消费者）

`enqueueWorkEvent`（event-outbox.ts:51）改为返回创建的 `EventOutbox` 行（现返回 void，调用点仅 9 处）。新增 `src/notification-service.ts`：

```ts
projectNotifications(tx, event: EventOutbox): Promise<void>
// 解析 event.type + payload → 收件人 → createMany，冲突跳过（unique 兜底）
```

在各服务事务内、`enqueueWorkEvent` 之后调用（claim-service / run-service 的相关调用点已在 `$transaction` 内；不在事务内的调用点靠 unique 约束去重即可，投影失败不回滚业务写入）。

**投影规则 v1（表格驱动，便于单测）：**

| 事件 | 收件人 | payload |
|---|---|---|
| `decision.requested` | work.assignee（若 actorKind=HUMAN）；否则该团队全部 OWNER（HUMAN）；上限 10 人 | `{ runPublicId, summary, externalUrl }` |
| `run.completed` | 同上（与 decision.requested 天然双发，UI 按 work 聚合；agent 不设 decisionRequested 标志时此事件兜底） | `{ runPublicId, phase }` |
| `work.accepted` / `work.review_rejected` | 该次 run 的 actor 若为 HUMAN 则通知之；AGENT 则跳过（agent 的反馈走 webhook，不造收件箱噪音） | `{ decisionId, reason }` |
| `webhook.disabled` | 全部 GLOBAL ADMIN（W3 的自动禁用触发） | `{ url, label, consecutiveFailures }` |

收件人解析 `resolveHumanRecipients(tx, work)`：assignee 优先，否则 OWNER 兜底——人必须始终有至少一个通知目标。

### 邮件通道（opt-in）

- env：`NOTIFICATION_EMAIL_ENABLED=false`（默认关）、`SMTP_HOST/PORT/USER/PASS/FROM`。
- 依赖 `nodemailer`（唯一新依赖）。
- 发送 worker：独立 `setInterval` 30s（不占用 outbox 的 2s tick），查询 `emailedAt IS NULL AND emailAttempts < 5 AND createdAt < now() - 2min`，按 user 分组合并成单封摘要（主题 `Involute：N 项工作等你验收`），逐条列出 `work.identifier + title + 链接 ${APP_ORIGIN}/work/${id}`，成功置 `emailedAt`。小批量窗口（2min）天然合并风暴。
- 模板：纯文本 + HTML 双 part，不引模板引擎。

### API（GraphQL）

```graphql
query notifications(first: Int, after: String, unreadOnly: Boolean): NotificationConnection!
query unreadNotificationCount: Int!
mutation notificationMarkRead(id: String!): NotificationRecord!
mutation notificationsMarkAllRead: Int!   # 返回置读条数
```

- 只读自己的（resolver 强制 `userId = viewer.id`；agent-token 身份也能读自己的通知——这对 agent 感知「我提交的 run 被拒了」是顺带收益）。
- `NotificationRecord { id type work payload readAt createdAt }`，cursor 分页沿用 `(createdAt, id)` keyset（schema.ts:2489 现成机制）。

### Web

- `App.tsx` 内联 nav 增加铃铛组件 `NotificationsBell`：未读徽标 + 下拉面板（最近 10 条，打开即 markRead，点击跳 `/work/:id`）。
- 唯一引入的轮询：`unreadNotificationCount` 每 60s 一次（全站仍无 websocket，与现状一致；后续如做 SSE 可换订阅）。
- **不复活 `/inbox`**：InboxPage 保持冻结，通知是独立模型与组件。
- `/settings/preferences` 增加一个开关 `emailNotifications: Boolean`（存 User 表新列 `notificationPrefs Json`，v1 只这一个键；邮件 worker 投递前检查）。

### 保留策略

flush tick 里加每日一次清扫：`readAt < now()-90d` 或 `readAt IS NULL AND createdAt < now()-180d` 的行删除，防止无限增长。

### 测试

- 投影规则表驱动单测（每事件类型 × assignee 是/否 HUMAN × 无 assignee）；幂等（同 event 重放 → 1 行）。
- GraphQL 测试：只能读自己的；markRead 越权 404。
- 邮件 worker：mock transport，断言分组合并、失败重试、prefs 开关。
- e2e 不覆盖邮件（CI 无 SMTP），加一条 GraphQL 级集成：runReport(complete, decisionRequested) → assignee 收到 decision.requested 通知。

工作量：3–4 天。这是对「run complete is not done」主线的补全。

---

## W3 Webhook payload v2 与退避补强

### 现状与差距

outbox 框架（签名、delivery 去重、8 次尝试、自动禁用）已与 Plane v2 同级，差距在三点：重试节奏（现在每 2s tick 重试，8 次 ≈ **16 秒**内打完，对方抖动一下就整批失败）；payload 缺稳定 `event_id` / 每次投递 `delivery_id` / 更新 diff；禁用时静默无通知。

### 3.1 Payload 增补（全 additive，不破坏现有消费者）

```jsonc
{
  "type": "work.committed",              // 保留，现有字段
  "event": "work.committed",             // 新增别名，Plane 风格点号事件名
  "event_id": "<EventOutbox.id>",        // 跨重试稳定，接收方幂等去重键
  "delivery_id": "<EventOutboxDelivery.id>",  // 每次投递唯一
  "occurred_at": "<EventOutbox.createdAt ISO>",
  "work": { "id": "...", "identifier": "SON-42" },
  "data": { /* 现有不变 */ },
  "updatedFrom": { /* 现有字段，覆盖面扩大，见 3.2 */ }
}
```

Header 增补：`involute-event-id`（= event_id，只看 header 的接收方用）、`involute-attempt`（第几次尝试）。`involute-signature` 继续对**原始 body** 做 HMAC-SHA256，签名文档写入 `docs/api.md`。

### 3.2 `updatedFrom` 覆盖面扩大

`EnqueueWorkEventInput.updatedFrom` 字段已存在，目前只有 committed/rejected/review_* 三类事件携带。补齐：

- `work.claimed`：before `{ claim: null, revision }`
- `run.completed` / `decision.requested`：before `{ stateId, revision }`（run-service 已先加载 work 行，快照即可）
- `artifact.attached` 不加（无意义）

### 3.3 指数退避与 4xx 短路

Prisma：`EventOutboxDelivery` 增加 `nextAttemptAt DateTime?` + `@@index([nextAttemptAt])`（additive migration）。

```
BACKOFF_SCHEDULE_MS = [60s, 5min, 30min, 2h, 10h]，每次 ±20% jitter
MAX_DELIVERY_ATTEMPTS 8 → 5
flush 间隔 2s → 10s（fresh 事件 nextAttemptAt 为 null，首轮照常即时投递）
```

- `deliverToTarget`：`now < nextAttemptAt` 则跳过；失败时 `attempts+1`、按表写 `nextAttemptAt`；HTTP 状态 **4xx（除 408/429）直接 terminal**（`attempts = MAX`，记 lastError），5xx/超时/429 走退避。
- 事件级 dead-letter 规则不变（allTerminal && anyExhausted）；最坏 ~17h 进死信，可接受。
- 自动禁用阈值维持 `consecutiveFailures >= 10`；禁用时改为**不再静默**：enqueue 一条 `webhook.disabled` 内部事件（只投影为 W2 通知，不外发），`WebhookSubscription` 增加 `createdById String?`（additive migration，`webhookCreate` 从 viewer 填入；legacy `INVOLUTE_WEBHOOK_URL` 创建的为 null → 通知 ADMIN）。

### 3.4 可观测性（可选，P3）

`query webhookDeliveries(webhookId: String!, first: Int): [WebhookDeliveryRecord!]!`——现有 `EventOutboxDelivery` 行直接暴露，按 `updatedAt desc`，供订阅方排障。

### 测试

- 改造现有 outbox 测试（run-service.test.ts:170 retry-only-failed 断言改为 `nextAttemptAt`）；新增：退避表取值与 jitter 边界、4xx 不重试、408/429 例外、禁用→通知创建、`event_id` 跨重试稳定而 `delivery_id` 每次不同。
- docs/api.md 增补 payload 契约与 header 语义一节。

工作量：2–3 天（禁用通知部分依赖 W2 的 Notification 模型，可拆为 W3a payload+退避、W3b 禁用通知两步落）。

---

## W4 MCP annotations 与协议自描述

### 现状与差距

`tools/list` 只返回 `{ name, description, inputSchema }`（mcp.ts:119-126），无标准 annotations；协议规则只藏在 server instructions 一句话里。

### 设计

1. `mcp-tools.ts` 工具描述符增加 `annotations`，`mcp.ts` tools/list 透传：

| 工具 | readOnlyHint | destructiveHint | idempotentHint |
|---|---|---|---|
| work_search / work_get_context / work_list_ready | true | false | — |
| work_propose | false | false | true（idempotencyKey 重放安全） |
| work_update | false | false | false（CAS） |
| work_link | false | false | true（unique 约束幂等） |
| work_claim | false | false | false（租约先到先得） |
| run_report | false | false | false |
| evidence_attach | false | false | true |
| work_commit | false | false | false（状态跃迁，不可重放） |

2. 新增只读工具 `protocol_get_guide`（scope `read`，两个端点都可用）：返回一段内嵌的 markdown 常量，内容为：四状态机表、commitment 门禁规则（human-only commit/reject/review）、scope 表、12 类事件目录、webhook 签名验证方法、指向 `/llms.txt`。对标 Plane 的 `get_pql_reference`；W6 落地后把 IQL 语法追加进去。
3. `instructions` 字符串扩为：

   > 'Involute is a project-state kernel. Search before creating work. Propose candidates instead of committed issues. Do not file local TODOs. Run complete is not work accepted. Call protocol_get_guide for the full protocol. Machine-readable docs: GET /llms.txt.'

### 测试

tools/list shape 断言（含 annotations、readonly 端点含 guide 工具）；scope map 增条目测试。

工作量：0.5–1 天。

---

## W5 /llms.txt 与文档端点

### 设计

新增 `src/docs-routes.ts`，挂在 index.ts 路由链（uploads 之后、yoga 之前），仅 GET：

- `GET /llms.txt` —— **代码内生成的常量**（不读文件），内容：一句话定位、MCP 端点（`/mcp`、`/mcp/readonly`）、四种 auth 模式与 scope 表、事件目录、协议要点、文档链接列表（`/docs/api.md` 等）与 `/llms-full.txt`。
- `GET /llms-full.txt` —— 白名单文档按序拼接。
- `GET /docs/<file>` —— 白名单 `{ api.md, agent-setup.md, ops.md, milestones.md, vision.md }`，从磁盘读。镜像内路径：Dockerfile base 阶段 `COPY . .` 已把仓库根 `docs/` 带进镜像（`/app/docs`），解析顺序 `process.env.INVOLUTE_DOCS_DIR` → `path.resolve(__dirname, '../../../docs')`（dist 在 `packages/server/dist` 时即 `/app/docs`；tsx 直跑 src 时即仓库 docs）。

响应头：`Content-Type: text/markdown; charset=utf-8`、`Cache-Control: public, max-age=300`。非白名单 / 超过 1MB / 路径穿越（`..`）一律 404。**这些文件必须保持无密钥内容**（现状如此，allowlist 显式列名防止未来误开新文件）。

### 测试

路由单测：200 + content-type、非白名单 404、`/docs/../.env` 拒绝、`llms.txt` 包含 MCP 端点与 scope 表。

工作量：0.5 天。性价比最高的一项：任何新 agent 连上即可自举。

---

## W6 IQL（Involute Query Language，统一筛选语言）

对标 Plane 的 PQL：**一个解析器喂五个面**（MCP、GraphQL、CLI、Web、webhook 过滤器），替代现在 `IssueFilter` / `ReadyWorkFilter` / `work_search` 参数三套并行。

### 语法 v1（term-based，无 OR、无括号——刻意做减法）

```
query   := term*
term    := '-'? ( field_expr | free_text )
field   := state | state-type | kind | commitment | assignee | label
         | priority | updated | link | has | team
value   := bareword | "quoted string" | v1,v2,v3（IN）
```

| 字段 | 示例 | 语义 |
|---|---|---|
| `team` | `team:SON` | team key |
| `state` | `state:"In Review"` | 状态名（按上下文 team 解析为 stateId 集合） |
| `state-type` | `state-type:STARTED` | WorkflowStateType |
| `kind` | `kind:PROJECT` | WorkKind |
| `commitment` | `commitment:CANDIDATE` | CommitmentStatus |
| `assignee` | `assignee:me` / `assignee:none` | `me` 解析为当前 viewer |
| `label` | `label:infra` | 标签名 |
| `priority` | `priority:>=2` | Int 比较符 |
| `updated` | `updated:>30d` | 时长比较（s/m/h/d/w） |
| `link` | `link:blocked-by:none` | `none` = 无该类型入边；`link:blocked-by:SON-12` = 存在指向该 id 的边。blocked-by:none 复用 readyWork 的 unblocked 判定（来自非终态的 BLOCKS 入边为 0） |
| `has` | `has:contract` / `has:claim` / `has:evidence` | 契约字段非空 / claim 存在 / 有 evidence |
| 自由文本 | `migration` | title/description contains |

`-state:done` 为取反。

### 代码组织

- `packages/shared/src/iql/`：`parse(query) -> IqlAst`（纯 TS 零依赖，可跨包用）、`describe(ast) -> string`（回显给 MCP/CLI）、`IqlParseError { term, position }`。
- Prisma where 编译器放 server 侧 `src/iql-compile.ts`（需要 viewer/team 上下文解析 `me`、状态名→id）；**IQL 与结构化 filter 按 AND 叠加**，不互斥。

### 铺开节奏（三个子阶段，各自独立可发布）

- **P2a 协议侧（先行）**：`work_search` / `work_list_ready` 增加可选 `query` 参数（tool description 内嵌迷你语法并指向 `protocol_get_guide`）；GraphQL `issues(first, after, filter, query: String)` 与 `readyWork(filter, query)`；CLI `issues list --query` / `work ready --query`。解析错误返回 GraphQL error `extensions.code = 'IQL_PARSE'` 带 position，**绝不静默返回空集**。
- **P2b Web**：命令面板与保存视图（/views，localStorage）存 `query` 字符串；看板/backlog 用 query 过滤的 issues 查询替代全量拉取。
- **P2c Webhook 过滤**：`WebhookCreateInput.filterQuery: String`，在 **enqueue 时**对 work 快照求值（事件产生时判定，不在投递时重查库），不匹配的事件对该订阅直接跳过。依赖 W3 payload 定稿。

### 测试

parser 黄金用例 + 模糊测试（任意输入不 panic，报 IqlParseError）；`describe` 往返；`toPrismaWhere` 集成测（含 `assignee:me`、`link:blocked-by:none` 与 readyWork 结果一致性）；MCP 端到端。

工作量：P2a 3 天，P2b 2 天，P2c 1–2 天，合计 6–8 天。**这是中期杠杆最大的一项，但明确排在 W1–W3 之后。**

---

## W7 自托管 AIO、setup.sh 与健康检查

### 现状与差距

compose + Ansible 对维护者好用，但对新用户门槛高；`/health` 只测进程存活（index.ts:109，无条件 200），无 DB 就绪信号；无升级检查点文档。

### 设计

1. **AIO 镜像**：Dockerfile 增加 `aio` target——server 构建 + web 静态构建 + caddy 二进制，`aio-entrypoint.sh` 用 `&` + `wait -n` + trap 起两个进程（不引 supervisor）：

   ```sh
   node packages/server/dist/index.js &
   caddy file-server --root /app/web-dist --listen :4201 &
   wait -n; exit 1
   ```

   配套 `docker-compose.aio.yml`：只有 `db` + `aio` 两个服务，Postgres 保持外置（不造嵌入式，维持「Postgres 是唯一存储」的运维事实）。
2. **setup.sh**（仓库根，bash 零依赖，可重复执行）：检查 docker/compose → `openssl rand -hex 24` 生成 `AUTH_TOKEN` / `VIEWER_ASSERTION_SECRET` / `POSTGRES_PASSWORD` → 交互问 `APP_DOMAIN`（或 `--local` 用 localhost）→ 写 `.env` → `docker compose pull` + up（server-init 自动 migrate）→ curl 冒烟。对标 Plane 的安装体验。
3. **健康检查**：`/health` 保持无条件 200（liveness，**不破坏现有 prod-smoke**）；新增 `GET /ready` 执行 `SELECT 1`，失败 503 + JSON 错误。`scripts/prod-smoke.sh` 增加 `/ready`。
4. **升级检查点**：新增 `docs/upgrading.md`——按版本列「破坏性 migration / 必读 env 变更 / 最低可升级版本」检查点表（第一个条目就是 W2/W3/W8 的三个 additive migration）；`docs/ops.md` 链过去。不引入版本门禁脚本，约定先行。

工作量：2–3 天。排在最后：先有值得分发的内核，再优化分发。

---

## W8 候选池 snooze 与 duplicate

### 现状与差距

CANDIDATE 池只进不出（reject 外无暂缓手段）；重复候选无归并语义（`WorkLinkType.DUPLICATE_OF` 存在但无流程入口）。

### 设计

- Prisma `Issue` 增列（additive migration）：`snoozedUntil DateTime?`、`source String?`（取值 `agent|human|web|cli|import`，自由 string 不加 enum，保留扩展）。
- duplicate **不加新字段**：以 `WorkLink(DUPLICATE_OF)` 为唯一事实源（避免第二套归并语义）。
- 语义：`snoozedUntil` 仅对 `commitmentStatus = CANDIDATE` 有意义；`readyWork` 与 candidates 查询排除 `snoozedUntil > now()` 的候选（查询级过滤）；已 committed 工作无视该字段。
- API：
  - `IssueUpdateInput` 增 `snoozedUntil: DateTime`（null 清除）；`Issue` 类型暴露 `snoozedUntil`、`source`。
  - `IssueFilter` 增 `snoozedUntil: DateTimeComparator`（先只 `gte`，供「已暂缓」分区查询）。
  - MCP `work_propose` 增可选 `source`（默认 `agent`）；web 创建默认 `web`。
- GraphQL 新增 `workLink(fromId: String!, toId: String!, type: WorkLinkType!): WorkLinkRecord!`（复用 MCP `work_link` 的 link-service 函数——目前该能力只有 MCP 面，web 需要）。
- Web `CandidatesPage`：「Snoozed (until X)」折叠分区 + 行内「暂缓 7 天 / 30 天」+「标记为重复」（弹选择器 → `workLink DUPLICATE_OF`；**不自动 reject**，拒绝仍走人工 `workReject`）。

### 测试

readyWork/candidates 排除 snoozed 的查询测；`workLink` 复用既有 link-service 唯一约束测；CandidatesPage 交互测。

工作量：1–2 天。

---

## 实施顺序与依赖

| Wave | 项 | 工作量 | 依赖 | 关闭的既有问题 |
|---|---|---|---|---|
| 1（第 1 周） | W1 看板排序 | 0.5d | 无 | staff-audit hardcoded columns |
| 1 | W5 llms.txt | 0.5d | 无 | — |
| 1 | W4 MCP annotations + guide | 1d | 无 | — |
| 1 | W3a payload + 退避 + 4xx | 2–3d | 无 | webhook 时序脆弱 |
| 2（第 2 周） | W2 通知闭环 | 3–4d | outbox（已有） | human gate 无人提醒 |
| 2 | W3b 禁用→通知 | 0.5d | W2 | 禁用静默 |
| 2 | W8 snooze + duplicate | 1–2d | 无 | 候选池淤积 |
| 3（之后） | W6 IQL P2a→P2b→P2c | 6–8d | P2c 依赖 W3a | 三套筛选并存 |
| 3 | W7 AIO + setup.sh + /ready | 2–3d | 无 | 分发门槛 |

## 兼容性与风险

- **W3 payload** 全 additive，现有订阅方零破坏；header 只增不改。退避改变投递时序预期（8×2s → 1m–10h），docs/api.md 必须同步改写「投递语义」一节。
- **W2** 通知行有保留策略兜底；邮件默认关，开箱零外部依赖。
- **W5** 公开文档路由必须保持白名单评审习惯；llms.txt 由代码常量生成，与 README 漂移风险接受（版本内一致即可）。
- **W6** 解析错误绝不静默空集；`me` 依赖 viewer 上下文，agent-token 场景解析为 AGENT user（与 `assignee.isMe` 现行为一致）。
- **W7** `/health` 语义不变，避免打破现有 smoke 与 Ansible 检查；`/ready` 为新增。
- 全部 migration 均为 additive，`prisma migrate deploy` 正常前滚；无数据回填脚本需求。
