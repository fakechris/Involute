# Involute

[![npm version](https://img.shields.io/npm/v/@turnkeyai/involute?label=npm)](https://www.npmjs.com/package/@turnkeyai/involute)
[![CI](https://github.com/fakechris/Involute/actions/workflows/ci.yml/badge.svg)](https://github.com/fakechris/Involute/actions/workflows/ci.yml)
[![Docker Publish](https://img.shields.io/badge/Docker%20Publish-workflow-blue)](https://github.com/fakechris/Involute/actions/workflows/docker-publish.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

[English](README.md) | 中文 | [用户手册（英文）](docs/manual/README.md)

> **Agent 原生的项目状态与工作图内核。**
> Involute 保存长期有效的工件身份、交付契约、类型化链接、决策与验收证据。
> Codex、Claude Code 等 Agent 通过 MCP 连接；用户可以在 Web 界面规划、编辑和验收工作。
> 支持无头（headless）运行，可自托管，不依赖 LLM。

**状态** 最新发布 [`npm-v0.3.0`](docs/releases/npm-v0.3.0.md)（2026-11-24）· 生产运行于 [involute.lumenopen.com](https://involute.lumenopen.com/) · 工作图内核、自治策略 L0–L3、缺陷与事故流程已交付 · Apache-2.0

## 🖥️ 界面预览

| 看板（只展示已承诺的工单） |
|---|
| ![Involute 看板](assets/board.jpg) |

## ✨ 特性

- 🧠 **工作图内核（Work-graph kernel）** —— 每个工作项都是图上的节点：稳定身份（`SON-18`、`INV-142`）、交付契约（outcome、scope、约束、验收、验证方式）、类型化链接（`contains`、`blocks`、`derived_from`、`discovered_during`）。
- 🤖 **MCP 原生 Agent 协议** —— 21 个分组工具，走 Streamable HTTP MCP（`/mcp`，只读镜像 `/mcp/readonly`）：`work_search` / `work_get_context` / `work_list_ready` / `work_propose` / `work_file_bug` / `work_claim` / `work_update` / `run_report` / `evidence` / `agent_inbox` 等。`protocol_get_guide` 返回完整协议，`/llms.txt` 列出文档索引。
- 🛡️ **关键处设人类闸门** —— 提案通常先进入 *candidate*（候选）队列等待决策。**Run 完成不等于工作已验收**；除非符合已启用的[自治策略](docs/autonomy-policy.md)等明确规则，否则由人工决定。
- 🧾 **Run + 证据** —— 每次执行尝试都是一条 run：阶段报告、阻塞、附带的 PR / 测试 / 产物链接；自报证据保留在 In Review，等待人工验收。
- 🖥️ **Web 工作区** —— 在看板和待办列表创建、编辑及流转已承诺的工作，在 Candidates 决定是否承诺提案，在 In Review 审查证据，在 **Needs you** 一处看到所有等你决定的事。支持撤销、自定义字段、保存视图、键盘优先操作，统一设计规范。
- ⚖️ **自治策略 L0–L3** —— 按团队和项目设定的[自治策略](docs/autonomy-policy.md)决定 Agent 可以自行承诺、验收或委派什么；每个自动决定都有审计，人可以退回。
- 🐞 **缺陷与事故** —— 零缺陷分诊（SLA、值班轮换）、回归与重复；Type: Incident 带严重度、影响时间戳、复盘和后续项期限；**Involute Capture** Chrome 扩展可从任意页面提交缺陷。
- 🔎 **搜索与工作图** —— 一个排序搜索（关键词、中文全文、本地语义）服务 ⌘K、看板和 Agent；工单邻域图、项目图、时间线、交付时延与燃尽图。
- 📥 **Linear 导入闭环** —— 导出一个 Linear 团队快照，导入、校验、上看板；历史承诺一次性载入，之后由内核接管。
- 📦 **可自托管** —— 单容器 `involute-aio`、完整 compose 栈、Docker Hub 发布镜像、Ansible playbook、私有化 Kubernetes 部署、按团队的 GitHub App 连接、带校验的备份/恢复脚本。
- 🔐 **认证与 RBAC** —— Google OAuth 会话、仅受邀与批准域名登录、工作区角色 Admin / Member / Guest、团队角色 Viewer / Editor / Owner、项目分享、可撤销且仅限 MCP 的 Agent 凭证（[docs/permissions.md](docs/permissions.md)）。
- 🧰 **CLI** —— `involute` 管理 config、teams、issues、labels、comments、导入/导出、viewer assertion。

## 🚀 快速开始

### 1. 跑起来（单容器）

```bash
./setup.sh --local    # 生成 .env，启动 docker-compose.aio.yml，等待 /ready
```

一个 `involute-aio` 镜像跑 API、执行迁移并伺服 Web 应用；只有 Postgres 在容器外。完整多容器方案见[本地栈快速开始](#本地栈快速开始)。

### 2. 接入 Agent

```bash
codex mcp add involute --url http://localhost:4200/mcp
```

Claude Code、Cursor、Opencode 等客户端的接入、token 与轮换见 [docs/agent-setup.md](docs/agent-setup.md)。Agent 侧的协议纪律在 skill 包里：[skills/involute/SKILL.md](skills/involute/SKILL.md)。

### 3. 或者用 CLI

```bash
npm install -g @turnkeyai/involute
involute config set server-url https://involute.example.com/graphql
involute config set token YOUR_AUTH_TOKEN
involute teams list
```

## 🌐 入口导航

| 内容 | 位置 |
|---|---|
| 在线实例（本项目自己的工作台） | <https://involute.lumenopen.com/> |
| 用户手册 | [docs/manual/README.md](docs/manual/README.md) |
| Agent 接入（MCP 客户端、token） | [docs/agent-setup.md](docs/agent-setup.md) · 技能包 [skills/involute/SKILL.md](skills/involute/SKILL.md) |
| Agent 协议（所有 Agent 遵守的规则） | [AGENTS.md](AGENTS.md) · MCP 的 `protocol_get_guide` · `GET /llms.txt` |
| API 参考 | [docs/api.md](docs/api.md) |
| 运维手册（部署、备份、恢复、冒烟） | [docs/ops.md](docs/ops.md) · [docs/upgrading.md](docs/upgrading.md) |
| 发布说明 | [docs/releases/](docs/releases/) —— 最新 [npm-v0.3.0](docs/releases/npm-v0.3.0.md) |

Web 应用中的页面（路径相对于你的服务器）：

| 路径 | 页面 |
|---|---|
| `/` · `/backlog` | 看板与 Backlog —— 只显示已承诺的工作 |
| `/candidates` | Candidates —— 等待承诺或拒绝的提案 |
| `/in-review` | In Review —— 待验收或退回的已完成工作 |
| `/todo` | Needs you —— 所有等你决定的事 |
| `/search` · `/views` | 搜索（IQL）与保存的视图 |
| `/graph` · `/projects` · `/milestones` · `/delivery` | 工作图、项目、里程碑、交付时延与燃尽 |
| `/bugs` · `/incidents` | 缺陷分诊与指标、事故与 MTTR / MTTM |
| `/agents` | Agent 目录与详情 |
| `/hygiene` · `/ops` | 工作健康度、运维（同步、队列、webhook、溯源） |
| `/settings` | 工作区、团队、Agent、GitHub、自治策略、字段 |

服务端端点：`/graphql`、`/mcp`、`/mcp/readonly`、`/health`（存活）、`/ready`（就绪）、`/llms.txt`。

## 🔁 Agent 工作循环

```text
work_list_ready / work_search → work_get_context → work_claim
（本地做计划 —— 不要上传）
work_update 或 work_propose 处理新确认的工作
run_report(completed, followups) + evidence(action: 'attach') → In Review（人验收 → Done）
```

四条状态机，刻意不合并：

| 状态机 | 含义 |
|---|---|
| `commitmentStatus` | candidate / committed / rejected |
| Issue 工作流状态 | Backlog → Ready → In Progress → In Review → Done / Canceled |
| Claim + Run | 这一次尝试由谁执行、是否完成 |
| 本地 `task_plan.md` | Agent 的工作记忆；不存入 Involute |

在 shadow 模式下，GitHub 合并与 CLEAR 观察不会改变工作流状态。决策规则见[核验配置](docs/evidence-verification.md)和[自治策略](docs/autonomy-policy.md)。

## 🗺️ 当前状态

- 最新发布：[`npm-v0.3.0`](docs/releases/npm-v0.3.0.md)（2026-11-24），距 `npm-v0.2.0` 约 330 个 PR。
- `M0` 单团队迁移与 `M2` 认证 / RBAC 已完成；`M1` VPS 自托管已上线 —— 生产按不可变 `sha-<12>` 镜像运行 `main`，每次部署前备份，并有每日校验备份（[docs/ops.md](docs/ops.md)）。
- `M5` 工作图内核：K0–K6，加上自治策略 L0–L3、缺陷与事故流程、Needs you、搜索、交付包与外部执行器。
- 待办：每日备份的异地副本。

当前产品状态与 API 面见 [docs/current-status.md](docs/current-status.md)、[docs/milestones.md](docs/milestones.md)、[docs/vision.md](docs/vision.md)、[docs/api.md](docs/api.md)。

## 仓库结构

- `packages/server` —— GraphQL API、MCP 端点、Prisma 数据模型、导入管线、校验助手
- `packages/web` —— React + Vite 看板 UI
- `packages/cli` —— `involute` CLI：config、导入/导出、teams、issues、labels、comments
- `packages/shared` —— 共享 TypeScript 工具
- `packages/extension` —— Involute Capture，可从任意页面提交缺陷的 Chrome 扩展
- `ops/` —— Ansible playbook 与私有化 Kubernetes 部署（`ops/k8s/involute-private`）
- `skills/` —— Agent skill 包（搜索、propose、claim、汇报、证据、接入）
- `docs/api.md` —— HTTP 与 GraphQL API 参考
- `docs/ops.md` —— 生产部署、回滚、日志、备份、恢复、冒烟
- `docs/vision.md` —— 当前产品愿景
- `docs/milestones.md` —— 活跃里程碑与排期
- `docs/manual/` —— 按任务组织的用户手册

## 环境变量

在仓库根目录按 `.env.example` 创建 `.env`：

```env
DATABASE_URL=postgresql://involute:involute@127.0.0.1:5434/involute?schema=public
AUTH_TOKEN=changeme-set-your-token
VIEWER_ASSERTION_SECRET=compose-viewer-secret
APP_ORIGIN=http://localhost:4201
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4200/auth/google/callback
ADMIN_EMAIL_ALLOWLIST=you@example.com
PORT=4200
```

服务端必填变量：

- `DATABASE_URL` —— PostgreSQL 连接串
- `APP_ORIGIN` —— 浏览器来源，用于 cookie/CORS 处理与登录后跳转
- `PORT` —— API 端口（默认 `4200`）

可选但推荐的服务端变量：

- `AUTH_TOKEN` —— CLI 与本地/开发引导流程使用的可信 Bearer token
- `VIEWER_ASSERTION_SECRET` —— HMAC 密钥，用于校验可信身份模拟的签名 viewer assertion
- `GOOGLE_OAUTH_CLIENT_ID` —— 浏览器 Google 登录的 OAuth client id
- `GOOGLE_OAUTH_CLIENT_SECRET` —— Google OAuth client secret
- `GOOGLE_OAUTH_REDIRECT_URI` —— API 服务处理的 Google 回调地址
- `ADMIN_EMAIL_ALLOWLIST` —— 逗号分隔的邮箱白名单，命中的用户成为 `ADMIN`
- `SESSION_TTL_SECONDS` —— 浏览器会话存活秒数
- `SEED_DEFAULT_ADMIN` —— 仅限开发/测试的开关，播种 `admin@involute.local`；本地验收流程之外保持 `false`
- `PRISMA_BASELINE_EXISTING_SCHEMA` —— 一次性升级开关：已有 schema 但没有 `_prisma_migrations` 历史的存量库使用
- `INVOLUTE_WEB_DIST` —— 由 API 进程直接伺服构建好的 Web 应用（AIO 镜像用；单容器单端口）
- `NOTIFICATION_EMAIL_ENABLED` —— 开启内核通知的按用户邮件摘要（`decision.requested`、评审结果、webhook 停用）；需要 `NOTIFICATION_EMAIL_SMTP_HOST` 与 `NOTIFICATION_EMAIL_FROM`，可选 `NOTIFICATION_EMAIL_SMTP_PORT`/`_USER`/`_PASSWORD`

兼容性说明：

- `GOOGLE_OAUTH_ADMIN_EMAILS` 仍作为旧别名被接受，但新部署应使用 `ADMIN_EMAIL_ALLOWLIST`

Web 运行时可选变量：

- `VITE_INVOLUTE_GRAPHQL_URL` —— 覆盖 Web 应用的 GraphQL 端点（默认 `http://localhost:4200/graphql`）
- `VITE_INVOLUTE_AUTH_TOKEN` —— 可信的本地/开发 Bearer token，绕过浏览器登录
- `VITE_INVOLUTE_VIEWER_ASSERTION` —— 签名 viewer assertion，以特定用户身份操作且不暴露服务端密钥

## 本地栈快速开始

想在本地跑 API、Web 应用和 Postgres 时走这条路。

```bash
pnpm install
cp .env.example .env
pnpm compose:up
```

冒烟检查：

```bash
curl http://localhost:4200/health
curl http://localhost:4201
```

然后浏览器打开 `http://localhost:4201`。

如果配置了 Google OAuth，Web 导航会出现 `Sign in with Google` 并使用会话 cookie。未配置时，浏览器仍可通过 `VITE_INVOLUTE_AUTH_TOKEN` 以可信方式直连 API（本地开发用）。

Compose 默认值：

- API：`http://localhost:4200`
- Web：`http://localhost:4201`
- Postgres：`127.0.0.1:5434`
- CLI 导出挂载：宿主机跟踪的 `.tmp/` 在 `cli` 容器内是 `/exports`
- Compose 用 `web-dev` Docker target 跑 Vite 实时 UI；发布的 `involute-web` 镜像用生产 `web` target
- `server-init` 在播种前先用 `prisma migrate deploy` 执行迁移

停止栈：

```bash
pnpm compose:down
```

想直接用 Docker Hub 发布镜像而不是从源码构建：

```bash
INVOLUTE_IMAGE_NAMESPACE=fakechris INVOLUTE_IMAGE_TAG=latest pnpm compose:pull
INVOLUTE_IMAGE_NAMESPACE=fakechris INVOLUTE_IMAGE_TAG=latest pnpm compose:pull:up
```

## VPS 部署（全新安装）

推荐的首条生产路径：一台 VPS、Docker Compose、Postgres、Node API，Web 用 Docker Hub 发布的静态镜像。HTTPS 由宿主机反代或可选的 compose Caddy profile 终结，但只保留一个环境文件：`.env.production`。

状态：

- 部署文件与自动化已就位
- 生产应走 `.env.production` 与 `docker-compose.prod.images.yml`
- 密钥应走 Ansible Vault，不要手改环境文件
- 每次部署都会对 `/health`、`/auth/session`、`/auth/google/start` 跑冒烟检查

涉及文件：

- [`docker-compose.prod.images.yml`](./docker-compose.prod.images.yml)
- [`Caddyfile`](./Caddyfile)
- [`.env.production.example`](./.env.production.example)
- [`scripts/prod-smoke.sh`](./scripts/prod-smoke.sh)
- [`scripts/postgres-backup.sh`](./scripts/postgres-backup.sh)

前提：

- 一台装好 Docker 与 Docker Compose 的全新主机
- `APP_DOMAIN` 的 DNS 记录已指向 VPS
- 全新的 Postgres 卷；不需要存量 schema 升级路径

1. 把仓库拷到 VPS 并创建生产环境文件：

```bash
cp .env.production.example .env.production
```

2. 在 `.env.production` 里至少填好：

```env
APP_DOMAIN=involute.example.com
APP_ORIGIN=https://involute.example.com
POSTGRES_PASSWORD=...
DATABASE_URL=postgresql://involute:<与上面一致的url-safe密码>@db:5432/involute?schema=public
AUTH_TOKEN=...
VIEWER_ASSERTION_SECRET=...
REQUIRE_GOOGLE_OAUTH=true
ADMIN_EMAIL_ALLOWLIST=you@example.com
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://involute.example.com/auth/google/callback
```

3. 拉起栈：

```bash
pnpm compose:prod:up
```

4. 冒烟检查：

```bash
docker compose --env-file .env.production -f docker-compose.prod.images.yml ps
pnpm smoke:prod https://involute.example.com
```

5. 如需显式重申第一个管理员：

```bash
docker compose --env-file .env.production -f docker-compose.prod.images.yml run --rm \
  --entrypoint /bin/sh server -lc \
  'pnpm --filter @turnkeyai/involute-server run admin:bootstrap you@example.com'
```

运维要点：

- 生产 compose 把 `DATABASE_URL` 直接传给 API 与迁移容器；不要依赖临时的 URL 拼接
- 使用 URL-safe 的 Postgres 密码，保证 `DATABASE_URL` 与 `POSTGRES_PASSWORD` 一致
- 默认 `docker-compose.prod.images.yml` 把 API/Web 绑定在 `SERVER_BIND_ADDRESS:4200` 与 `WEB_BIND_ADDRESS:4201`，交给宿主机反代
- 要让 compose Caddy 接管 `80/443`，加 `caddy` profile 启动，并确保宿主机的 nginx/apache 没占这两个端口
- `server-init` 在 API 启动前执行 `prisma migrate deploy`
- `SEED_DATABASE` 生产默认 `false`；只在全新演示种子时打开
- Web 容器是静态生产构建，不是 Vite dev server

备份与恢复：

```bash
sh scripts/postgres-backup.sh
RESTORE_TARGET=throwaway sh scripts/postgres-restore.sh .backups/involute-<timestamp>.sql.gz
```

备份写入 `.backups/` 下的 gzip SQL dump。生产恢复与冒烟清单见 [docs/ops.md](docs/ops.md)。

## Ansible 自动化部署

手动 SSH 部署已不是预期路径。仓库在 [`ops/ansible`](./ops/ansible) 下带有 Ansible 工作流。

可用 playbook：

- [`ops/ansible/playbooks/bootstrap-host.yml`](./ops/ansible/playbooks/bootstrap-host.yml) —— 安装 Docker/Compose 并准备主机
- [`ops/ansible/playbooks/deploy.yml`](./ops/ansible/playbooks/deploy.yml) —— 同步仓库、渲染环境、跑 compose、验证健康

Tailscale 专用部署复用 [`docker-compose.yml`](./docker-compose.yml)，通过渲染的环境文件驱动绑定地址。只有 `4200` 和 `4201` 绑定 Tailscale IP；Postgres 留在 `127.0.0.1`。

典型流程：

1. 拷贝 inventory 示例：

```bash
cp ops/ansible/inventory/hosts.yml.example ops/ansible/inventory/hosts.yml
```

2. 填目标主机、绑定地址和密钥。

3. 准备主机：

```bash
pnpm deploy:bootstrap
```

4. 部署 Tailscale 栈：

```bash
pnpm deploy:tailscale
```

当前 Tailscale 测试阶段使用：

- `involute_stack_profile: tailscale`
- `involute_bind_address: <tailscale-ip>`
- `involute_app_origin: http://<tailscale-ip>:4201`

公网域名与 OAuth 就绪后，把 inventory 切到 `production` 并使用 [`docker-compose.prod.images.yml`](./docker-compose.prod.images.yml)。

本地 Ansible 部署时，密钥放在加密的 vault 文件里：

```bash
cp ops/ansible/group_vars/all/vault.yml.example ops/ansible/group_vars/all/vault.yml
ansible-vault encrypt ops/ansible/group_vars/all/vault.yml
ANSIBLE_VAULT_PASSWORD_FILE=ops/ansible/vault-password.txt pnpm deploy:prod
```

`ops/ansible/group_vars/all/vault.yml` 与 `ops/ansible/vault-password.txt` 不入 git。

GitHub Actions 可以从 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 走同一条部署路径。启用前配置这些仓库 secrets：

- `DEPLOY_HOST`
- `DEPLOY_KNOWN_HOSTS`
- `DEPLOY_USER`
- `DEPLOY_SSH_PRIVATE_KEY`
- `INVOLUTE_APP_ORIGIN`
- `INVOLUTE_AUTH_TOKEN`
- `INVOLUTE_VIEWER_ASSERTION_SECRET`
- `INVOLUTE_BIND_ADDRESS`（tailscale 用）
- `INVOLUTE_APP_DOMAIN` 与 `INVOLUTE_POSTGRES_PASSWORD`（production 用）
- `INVOLUTE_GOOGLE_OAUTH_CLIENT_ID`、`INVOLUTE_GOOGLE_OAUTH_CLIENT_SECRET`、`INVOLUTE_GOOGLE_OAUTH_REDIRECT_URI`（`REQUIRE_GOOGLE_OAUTH=true` 时）
- 可选：`INVOLUTE_ADMIN_EMAIL_ALLOWLIST`、`INVOLUTE_IMAGE_TAG`

推荐的仓库变量：

- `INVOLUTE_DEPLOY_ON_MAIN=false` 保持默认手动部署
- `INVOLUTE_DEPLOY_PROFILE=tailscale`（当前私有测试阶段）

## 手动单团队导入

在 shell 里设置源系统 API token：

```bash
export SOURCE_API_TOKEN='src_api_xxx'
```

已安装发布版 CLI 的话：

```bash
involute import team --token "$SOURCE_API_TOKEN" --team SON --keep-export --output ./son-export
```

使用本地 compose 栈的话，也可以在 compose CLI 容器里跑导入：

```bash
docker compose run --rm cli import team --token "$SOURCE_API_TOKEN" --team SON --keep-export --output /exports/son-export
```

这一步做的事：

- 把一个团队快照导出到 `.tmp/son-export`
- 把导出数据导入 Involute
- 跑 `import verify`
- 写出 `.tmp/son-export/involute-import-summary.json`

完成后打开 `http://localhost:4201`，在看板上目视检查导入的团队。

建议的验收检查：

- 目标团队出现在看板上
- 该团队的 issue 数量看起来完整
- 少量 issue 的状态、标签、负责人、评论符合预期
- 最新导入的 issue 在看板上可见，而不是藏在第一页之后

## 不用 Docker 的本地开发

启动 API：

```bash
DATABASE_URL="postgresql://involute:involute@127.0.0.1:5434/involute?schema=public" AUTH_TOKEN="changeme-set-your-token" VIEWER_ASSERTION_SECRET="compose-viewer-secret" APP_ORIGIN="http://127.0.0.1:4201" GOOGLE_OAUTH_REDIRECT_URI="http://127.0.0.1:4200/auth/google/callback" pnpm --filter @turnkeyai/involute-server exec tsx src/index.ts
```

启动 Web 应用：

```bash
VITE_INVOLUTE_AUTH_TOKEN="changeme-set-your-token" VITE_INVOLUTE_GRAPHQL_URL="http://127.0.0.1:4200/graphql" pnpm --filter @turnkeyai/involute-web exec vite --host 127.0.0.1 --port 4201
```

对本地 API 跑 CLI：

```bash
pnpm --filter @turnkeyai/involute exec node dist/index.js import team --token "$SOURCE_API_TOKEN" --team SON --keep-export --output .tmp/son-export
```

需要 CLI 或 Web UI 以特定用户身份操作时，用可信密钥签发短时效 viewer assertion 并持久化：

```bash
export INVOLUTE_VIEWER_ASSERTION_SECRET=compose-viewer-secret
pnpm --filter @turnkeyai/involute exec node dist/index.js auth viewer-assertion create user@example.com --ttl 3600
pnpm --filter @turnkeyai/involute exec node dist/index.js config set viewer-assertion SIGNED_ASSERTION_HERE
```

Web UI 可通过 `VITE_INVOLUTE_VIEWER_ASSERTION` 或 localStorage 键 `involute.viewerAssertion` 使用同一签名 assertion。

## 认证与权限

- 浏览器认证支持 Google OAuth + 会话 cookie；登录仅限受邀者与批准域名，工作区角色为 Admin / Member / Guest（[docs/permissions.md](docs/permissions.md)）。
- `AUTH_TOKEN` 与 viewer assertion 仍可用于可信的 CLI/开发流程。
- 系统管理员可通过 `ADMIN_EMAIL_ALLOWLIST` 或 `pnpm --filter @turnkeyai/involute-server admin:bootstrap user@example.com` 引导。
- 团队有 `PUBLIC` / `PRIVATE` 可见性。
- 团队编辑按成员角色门控：Editor（`EDITOR`）或 Owner。
- 团队访问可在团队的 Members 和 Settings 页面（`/teams/<KEY>/members`、`/teams/<KEY>/settings`）管理，也可通过 GraphQL mutations：`teamUpdateAccess`、`teamMembershipUpsert`、`teamMembershipRemove`。

## 数据库迁移

默认 schema 工作流用 Prisma migrations：

```bash
pnpm --filter @turnkeyai/involute-server prisma:migrate:dev -- --name your_change
pnpm --filter @turnkeyai/involute-server prisma:migrate:deploy
```

逃生口 / 管理命令：

```bash
pnpm --filter @turnkeyai/involute-server admin:bootstrap you@example.com
pnpm --filter @turnkeyai/involute-server prisma:migrate:baseline
pnpm --filter @turnkeyai/involute-server prisma:migrate:reset
pnpm --filter @turnkeyai/involute-server prisma:db:push
```

守则：

- 本地改 schema 时用 `prisma:migrate:dev`
- compose、CI、生产一律用 `prisma:migrate:deploy`
- `prisma:db:push` 只作为显式的开发期逃生口，不作默认部署路径
- 升级早于 `prisma/migrations` 的存量库时，先跑一次 `prisma:migrate:baseline` 再执行第一次 `prisma:migrate:deploy`，或设置 `PRISMA_BASELINE_EXISTING_SCHEMA=true` 做一次性 compose 引导

## 质量闸门

单元与集成检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

浏览器 E2E：

```bash
pnpm e2e
```

Playwright 套件覆盖看板生命周期、Getting started 旅程和 MCP / UI 一致性检查；[docs/acceptance-scenarios.md](docs/acceptance-scenarios.md) 把每项常规验收对应到守护它的测试。

## API 参考

当前 HTTP 与 GraphQL 面见 [docs/api.md](docs/api.md)。

## npm 发布流程

Tag 驱动的 npm 发布接在 [`.github/workflows/npm-publish.yml`](.github/workflows/npm-publish.yml)。

发布说明在 [docs/releases/](docs/releases/)，最新为 [npm-v0.3.0](docs/releases/npm-v0.3.0.md)。

一次发布 = 同一个 `main` 提交上的两个 tag，加上对应的说明文件：

```bash
git tag npm-v0.3.0 && git tag docker-v0.3.0
git push origin npm-v0.3.0 docker-v0.3.0
gh release create npm-v0.3.0 --notes-file docs/releases/npm-v0.3.0.md
```

`npm-v*` 发布下列 npm 包；`docker-v*` 给 Docker 镜像加版本 tag。生产不从 tag 部署，而是按 `sha-<12>` 镜像推进（[docs/ops.md](docs/ops.md)）。

发布 tag 格式：

```bash
git tag npm-v<version>
git push origin npm-v<version>
```

该 workflow 以版本 lockstep 发布当前包集合：

- `@turnkeyai/involute-shared`
- `@turnkeyai/involute-server`
- `@turnkeyai/involute`

仓库内 package manifest 故意停在 `0.0.0`；workflow 从发布 tag 推导发布版本，并在隔离的发布 checkout 里重写 workspace 依赖。

启用前需要的仓库设置：

- 添加 `NPM_TOKEN` GitHub Actions secret
- 确保 token 背后的 npm 账号能发布当前 `@turnkeyai/*` scope
- 首次发布后，在 org 设置里把包授权给 npm developers team

当前 npm org 配置的团队管理页：

- <https://www.npmjs.com/settings/turnkeyai/teams/team/developers/access>

## Docker 镜像

仓库带一个多 target 的 `Dockerfile`：`server`、`web-dev`、`web`、`cli`。

发布镜像：

```bash
docker pull fakechris/involute-server:latest
docker pull fakechris/involute-web:latest
docker pull fakechris/involute-cli:latest
```

用发布镜像跑 compose 栈：

```bash
INVOLUTE_IMAGE_NAMESPACE=fakechris INVOLUTE_IMAGE_TAG=latest \
  docker compose -f docker-compose.images.yml up -d db server web
```

生产 compose 同样可用发布镜像：

```bash
INVOLUTE_IMAGE_NAMESPACE=fakechris INVOLUTE_IMAGE_TAG=latest \
  docker compose --env-file .env.production \
  -f docker-compose.prod.images.yml up -d
```

镜像 tag：

- `latest` —— `main` 分支最近一次成功 push
- `sha-<短sha>` —— 不可变的 commit 镜像
- `<version>` —— 由 `docker-v<version>` tag 或 `workflow_dispatch` 输入触发

Docker Hub 发布 workflow 需要这些 secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
- `DOCKERHUB_NAMESPACE` —— 可选；默认 `DOCKERHUB_USERNAME`

设置好后，`.github/workflows/docker-publish.yml` 会推送：

- `${DOCKERHUB_NAMESPACE}/involute-server`
- `${DOCKERHUB_NAMESPACE}/involute-web`
- `${DOCKERHUB_NAMESPACE}/involute-cli`

发布的 `involute-web` 镜像是静态生产构建，构建时烘焙 `VITE_INVOLUTE_GRAPHQL_URL`，但不会把 auth token 烘进镜像。本地开发与验收时，compose 栈仍是参考运行路径，发布前应保持绿色。

## 常用 CLI 命令

```bash
pnpm --filter @turnkeyai/involute exec node dist/index.js teams list
pnpm --filter @turnkeyai/involute exec node dist/index.js issues list --team SON
pnpm --filter @turnkeyai/involute exec node dist/index.js issues create --team SON --title "My issue"
pnpm --filter @turnkeyai/involute exec node dist/index.js comments add SON-1 --body "Hello from Involute"
pnpm --filter @turnkeyai/involute exec node dist/index.js export --token "$SOURCE_API_TOKEN" --team SON --output .tmp/son-export
pnpm --filter @turnkeyai/involute exec node dist/index.js import --file .tmp/son-export
pnpm --filter @turnkeyai/involute exec node dist/index.js import verify --file .tmp/son-export
pnpm --filter @turnkeyai/involute exec node dist/index.js import team --token "$SOURCE_API_TOKEN" --team SON
```

## 当前重点

- 保持生产可信：每日校验备份、异地副本、每次发布做一次恢复演练
- 人的决定集中在一处（Needs you），每条要人做的规则都有对应页面
- Agent 自治只通过有审计的策略等级增长，不绕过它
- 保持界面用词与 UI 组件一致（[docs/design-system.md](docs/design-system.md)）

Railway 仍是后续可能的托管路径，但不是当前的阻塞里程碑。方向见 [docs/current-status.md](docs/current-status.md)、[docs/vision.md](docs/vision.md)、[docs/milestones.md](docs/milestones.md)。

## License

[Apache-2.0](./LICENSE)
