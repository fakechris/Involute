# Involute 异步解耦与事件驱动架构设计规范（对标 Linear 工业级体系）

> **版本**：v1.2 (Kimi 复审通过定稿版 - Final Approved)  
> **审查记录**：已通过 Kimi（Pane `wE:p3`）Round 1 & Round 2 双轮严格审查并获裁决 **PASS**。  
> **目标**：彻底解绑 Involute 与 Git 本地提交的强耦合，建立单调递增状态机、持久化游标对账、多仓库动态路由与离线 CI 门禁的工业级闭环。

---

## 一、 问题根因复盘与设计动机

### 1.1 现存架构的致命缺陷
在过去的设计中，Involute 试图通过“三层防御金字塔”在本地 Git 提交时实施强控制，暴露了三大架构硬伤：

1. **分布式系统的主客颠倒（反人类的强同步阻塞）**：
   - Git 本质是无中心、离线优先的分布式版本控制系统；Involute 是工作图与任务跟踪系统。
   - 现存方案在 `.githooks/commit-msg` 中强行进行同步拦截，一旦 Involute 宕机、端口不可达、或者开发者离线开发，本地连 `git commit` 都无法执行。没有任何一家成熟产品会允许外部辅助系统勒死代码生产线。
2. **仪式感过载（Process Ceremony Overhead）逼迫模型作弊**：
   - 现存体系要求 Agent 遵循繁重的 5 步仪式（`propose` -> `commit` -> `claim` -> `run_report` -> `evidence_attach`）。
   - 在高压排查或即时救火时，模型注意力被代码问题占满，为了绕过耗时的多轮网络调用，必然倾向于走“阻力最小路径”（如偷用已有任务编号 `[INV-84]` 糊弄正则）。
3. **假硬门禁（Goodhart's Law 的必然失效）**：
   - 本地 Hook 仅做了表面正则字符串校验，没有校验工单真实生命周期（是否已交付、是否属于当前会话），既带来了阻塞风险，又没有真正防住脏数据。

---

## 二、 Linear 工业级架构基准研究 (Linear Benchmark)

根据对 Linear 官方架构的深入研究，其与 GitHub 整合的核心逻辑可概括为：**零客户端侵入、分支即契约、单向事件驱动、最终一致性。**

```
┌────────────────────────────────────────────────────────┐
│             开发者 / Agent 本地开发机                   │
│  • 零本地 Git Hook 侵入                                │
│  • 100% 离线可用，断网随意 git commit                   │
│  • 遵循分支命名约定：feat/INV-123-optimize-queries       │
└───────────────────────────┬────────────────────────────┘
                            │ git push origin feat/...
                            ▼
┌────────────────────────────────────────────────────────┐
│                   GitHub 代码主干                      │
│  • 独立作为代码事实主干（Source of Truth）              │
│  • 离线 PR CI 正则检查（不依赖外部网络）                 │
│  • PR 开启 / 合并毫秒级完成，绝不阻塞等待外部响应        │
└───────────────────────────┬────────────────────────────┘
                            │ GitHub Webhook (异步投递)
                            ▼
┌────────────────────────────────────────────────────────┐
│               Involute 服务端 (观察者与工作图)           │
│  • Webhook 接收端点 (POST /api/webhooks/github)         │
│  • 快速 200 应答 + 异步按工单分键串行队列               │
│  • 单调前移 CAS 状态机 (防乱序与状态回退)               │
│  • 持久化水位线游标对账器 (Reconciliation Watermark)     │
└────────────────────────────────────────────────────────┘
```

### Linear 的四大核心设计支柱：
1. **零侵入与离线优先（Zero-Touch Client & Local-First）**：
   - 本地仓库不安装任何阻塞网络请求的 Git Hook；
   - Linear 宕机时，GitHub 的代码开发、提交、PR 创建与合并 100% 正常进行。
2. **分支即契约（Convention over Ceremony）**：
   - 开发者或 Agent 认领任务后，只需基于任务标识创建分支（如 `feat/INV-123-title`）；
   - 后续无需在每个 Commit 中重复声明，也无需手动调接口汇报执行进度，分支即为天然上下文绑定。
3. **单向事件驱动与容灾（Asynchronous Webhooks with Retry）**：
   - GitHub 通过 Webhook 向 Involute 推送事件；
   - Involute 将对账扫描器作为主保障、Webhook 作为低延迟加速器，即使事件丢包也能自愈。
4. **确定性双重保险（Reconciliation Engine）**：
   - 基于持久化水位线游标对账，拉取 PR 与 Merge 记录，主动对齐状态。

---

## 三、 Involute 目标架构设计（Review 补正终版）

### 3.1 子系统一：本地客户端彻底解耦 (Zero-Touch Client)
1. **废除本地网络门禁**：
   - 彻底移除 `.githooks/commit-msg` 中任何调用外部脚本或网络查询的逻辑；
   - 保持原生 Git 提交毫秒级响应与离线可用性；
   - 保留 `AGENTS.md` 中的提报义务原则，但将其从阻断式门禁解耦为异步交付规范。
2. **纯离线 PR 规范 Lint（CI 离线门禁）**：
   - 在 GitHub Actions 中增加轻量 Bash 正则检查，监听 `pull_request` 的 `opened`, `reopened`, `edited`, `synchronize` 事件（确保修改标题后触发重检）；
   - 纯内存运行，0 外部网络调用，Involute 宕机依然秒级通过。

---

### 3.2 子系统二：多仓库动态路由与语义状态机映射
为彻底杜绝硬编码 `INV` 前缀和硬编码英文状态名引发的崩溃，引入动态路由表与语义类型映射：

1. **仓库路由注册表 (`repo_routing_table`)**：
   ```ts
   interface RepoRoute {
     repository: string;        // e.g. "fakechris/Involute" | "fakechris/lumenbox"
     teamKey: string;           // e.g. "INV" | "LUM"
     identifierPattern: RegExp; // e.g. /(INV|inv)-[0-9]+/ | /(LUM|lum)-[0-9]+/
     projectId: string;         // 默认根项目 UUID
   }
   ```
   *注：收到路由表外未配置仓库的 Webhook 事件，系统直接返回 200 + 丢弃 + 指标计数。*

2. **状态解析基于语义类型 (Semantic Workflow Type)**：
   - 严格禁止按名称（`name: "Ready"`）匹配状态；
   - 统一按照 `packages/server/src/workflow-state-order.ts` 中的标准语义类型查找：
     - `STARTED` 对应进行中（Rank 2）
     - `REVIEW` 对应待评审（Rank 3）
     - `COMPLETED` 对应已完成（Rank 4，吸收终态）
     - `CANCELED` 对应已取消（吸收终态）
   - 若团队缺失对应类型状态，系统记录 Warning 并安全跳过，**绝不抛 500**（防止 GitHub 判定交付失败）。

---

### 3.3 子系统三：事件映射表与状态机双轨 CAS 守卫

#### 1. 核心事件与状态机映射全表 (补正恢复)

| GitHub 事件 (action) | 触发条件 | 目标语义类型 | 守卫条件 (Guard Path) | 幂等键形 (EventSourceKey) | 关联数据持久化 |
|---|---|---|---|---|---|
| `create` (ref_type=branch) | 分支名匹配 `identifierPattern` | `STARTED` | 单调前移 CAS (`stateRank < 2`) | `github_branch_${repo}_${ref}_${deliveryGuid}` | 绑定分支名；若无租约则记录未认领告警 |
| `pull_request` (`opened`) | 分支名或标题包含工单号 | `REVIEW` | 单调前移 CAS (`stateRank < 3`) + 记录来源 PR | `github_pr_${pr.id}_opened_${pr.updated_at}` | 记录 `stateSourcePrId = pr.id`，挂载 PR Evidence |
| `pull_request` (`reopened`) | 分支名或标题包含工单号 | `REVIEW` | 单调前移 CAS (`stateRank < 3` AND `stateType != 'COMPLETED'`) | `github_pr_${pr.id}_reopened_${pr.updated_at}` | 重新激活 Review 状态 |
| `pull_request` (`closed`, merged=true) | PR 包含工单号且成功合并 | `COMPLETED` | 终态前移 CAS (`stateType != 'COMPLETED'`) | `github_pr_${pr.id}_merged_${pr.updated_at}` | 挂载 Merge Commit SHA 与人类合并验收审计 |
| `pull_request` (`closed`, merged=false) | PR 未合并直接关闭 | `STARTED` | **受限 Provenance 回退路径** (`stateSourcePrId == pr.id`) | `github_pr_${pr.id}_unmerged_${pr.updated_at}` | 解除 Review 来源，退回进行中 |

#### 2. 状态机双轨 CAS 守卫（消解单调 CAS 与回退的逻辑矛盾）
状态迁移分为两组互斥的执行通道：

- **通道 A：正向单调前移 CAS（默认路径）**：
  ```sql
  UPDATE "Issue"
  SET "stateId" = $targetStateId, "updatedAt" = NOW()
  WHERE "id" = $issueId
    AND "stateRank" < $targetStateRank
    AND "stateType" NOT IN ('COMPLETED', 'CANCELED');
  ```
- **通道 B：受限 Provenance 回退 CAS（唯一逆向例外）**：
  仅当当前工单是由该关闭 PR 推进到 Review 状态时，才允许单跳回退至 STARTED，非来源 PR 无权扰动：
  ```sql
  UPDATE "Issue"
  SET "stateId" = $startedStateId, "stateSourcePrId" = NULL, "updatedAt" = NOW()
  WHERE "id" = $issueId
    AND "stateType" = 'REVIEW'
    AND "stateSourcePrId" = $prId;
  ```

#### 3. 并发规则：
- **First-Merge-Wins**：工单关联多个 PR 时，首个合并的 PR 锁定 `COMPLETED`，后续 PR 合并仅追加 Evidence；
- **优先级**：单 PR 提取多工单时，分支名匹配优先级高于 PR 标题（Branch > Title）。

---

### 3.4 子系统四：持久化水位线游标对账引擎

```
               持久化水位线 (Watermark Cursor)
                              │
          上次成功同步时间戳   ▼ (例如: 2026-09-08T00:00:00Z)
  ───┼────────────────────────┼───────────────────────────────► 时间轴
     │ (已对账完毕)           │ (本轮对账拉取: updated >= Watermark)
                              │
                              ▼
           拉取 GitHub PR (按 updated 升序推进)
                              │
               逐条通过单调 CAS 引擎安全重放
                              │
                              ▼
                   更新持久化水位线 Watermark
```

1. **游标与同秒安全**：
   - 存储持久化游标 `github_sync_watermark_${repo}`；
   - 扫描拉取条件为 `updated:>=${watermark}`（结合数据库级唯一索引，消除同一秒多 PR 更新在中途崩溃时的截断漏单）；
   - 逐条按 `updated_at` 升序推进游标。
2. **毒消息隔离**：
   - 单条 PR 重放异常时记录失败日志，连续 3 次失败进入死信表并报警，推进游标跳过，绝不永久卡死对账流水线。

---

### 3.5 子系统五：物理幂等与端点安全防护

1. **数据库物理唯一约束**：
   - 建立 `WebhookEventLog` 表：
     `UNIQUE INDEX "idx_webhook_event_source" ("issueId", "eventSourceKey");`
   - 消除应用层 Check-Then-Insert 的 TOCTOU 竞态。
2. **异步队列**：
   - Webhook 端点验签后立即返回 `200 OK`，将 Payload 投入后台工作队列，按 `issueId` 分片串行消费。
3. **安全加固**：
   - HMAC 签名校验必须采用 `crypto.timingSafeEqual`，基于原始 Raw Body 计算；
   - 接入速率限制器（复用 `packages/server/src/rate-limit.ts`）。

---

## 四、 实施路线（四阶段按序推进）

1. **Phase 1：拆除遗留本地网络 Hook（即刻执行）**
   - 清理 `.githooks/commit-msg`，将 `scripts/verify-work-graph.sh` 改为纯本地正则检查并迁移至 GitHub Actions CI。
2. **Phase 2：Webhook 接收端点与双轨 CAS 状态机**
   - 建立 `/api/webhooks/github` 路由与验签中间件；
   - 实现包含正向单调 CAS 与 Provenance 回退 CAS 的状态流转器；
   - 编写乱序事件夹具测试（先 merged 后 opened 保持 COMPLETED；非来源 PR closed 不得回退）。
3. **Phase 3：水位线游标对账器与多仓库路由**
   - 实现基于 Watermark Cursor 的对账定时任务；
   - 接入多仓库路由表配置。
4. **Phase 4：文档与 Agent 闭环规范更新**
   - 更新 `AGENTS.md`，正式启用“分支即契约”的新交互规范。
