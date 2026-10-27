# Involute Web UI 设计体系（Lumen 对齐版）

> **状态**：规范 v1，2026-10-21。来源：对 `packages/web/src` 全量 UI 审计（45 个路由、71 个组件、7326 行样式）。
> 2026-07-23 的 "Align web UI with Lumen Design System"（#36）之后三个月，样式表从 3209 行 / 61 个组件族涨到 7326 行 / 186 个组件族，共享原语只有 6 个。本文记录原始设计意图、漂移的证据、以及之后所有页面必须遵守的规则。

---

## 一、设计意图（原始 Lumen 契约）

`styles/app.css` 头部写明的 Lumen "quiet utility" 原则：

| 维度 | 规则 | Token |
|---|---|---|
| 字体 | IBM Plex Sans / Sans SC 正文，IBM Plex Mono 工单号与代码 | `--font-sans` `--font-mono` |
| 背景 | 平面、暖色纸张；无渐变、无模糊、无 emoji | `--bg` `--bg-raised` `--bg-sunken` `--bg-hover` |
| 结构 | 1px 发丝线承担全部结构；行内卡片无阴影；阴影只给外壳与浮层 | `--border` `--border-subtle` `--shadow-md/lg` |
| 圆角 | 控件 10 / 面板 12 / 卡片 16 / 外壳 20 / 胶囊 999；微元素 6–8 | `--r-1`…`--r-6` |
| 颜色 | 一个强调色（陶土 / 深蓝），四个语义色；`--accent` 是文字色，承载 `--accent-fg` 的填充用 `--accent-solid`（暗色下更深，INV-1385）；浅底用 `--*-weak`，不在徽章上写 `color-mix` 底色 | `--accent` `--accent-solid` `--danger` `--success` `--warn` `--info` `--accent-weak` `--danger-weak` `--success-weak` `--warn-weak` |
| 动效 | 120–180ms，只动颜色 / 透明度 / 宽度；hover 是着色不是位移 | `--dur-1..3` `--ease` |
| 密度 | 三档密度通过 token 切换，页面不自己定行高 | `--row-h` `--pad-x` `--pad-y` `--content-gutter` |

---

## 二、漂移的证据（2026-10-21 审计）

### 2.1 坏掉的，不只是不一致
- **引用了不存在的类名**：`.btn .btn--subtle .btn--accent .btn--md`（Projects / Cycles / Views 弹窗按钮）、`.ui-action--primary`（Settings 的 Save、Contract 的 Save、Team 设置导航）——主按钮退化为无边框文本。`.truncate` `.sr-only` `.board-project-pills` `.saved-view-card` 等 20 个类也无样式。
- **引用了不存在的 token**：`--warning` `--fg-danger` `--accent-subtle` `--surface` `--text-muted` `--bg-surface` `--border-warning` `--r-full`，永远走硬编码 fallback（蓝色 `#5b8def`、琥珀 `#b45309`），暗色主题下不可读。
- **工单号折行**：`.mono` 只设字体，没有 `white-space: nowrap`；浏览器允许在 `INV-` 的连字符后断行；flex 子项默认可收缩到最小内容宽度。Bugs「Past their SLA」、Health 列表、Issue / Work 页标题、Needs you、In Review 卡片头全部受影响。
- **MarkdownRenderer 不渲染块级语法**：无标题、列表、引用、分割线；In Review 与 Candidates 甚至不调用它，`### 1. 目标` 以裸文本出现在验收卡片上。
- **Graph 节点溢出**：`.dependency-node` 188×46，无 `overflow: hidden` / `min-width: 0`，中文标题最多 13 字，其余画进相邻列。

### 2.2 同一件事的 N 种做法
| 事物 | 现存做法数 | 明细 |
|---|---|---|
| 页面头 | 5 | `.page-header`、Board 内联 header、`.inbox-page__header`、`.page-shell__header`、`.app-shell__header`（错误态）；Settings 没有 |
| 页标题 | 2 | `h1.page-header__title` vs 内联 `<span>`（My Issues / Views / Projects / Cycles / Teams / Work） |
| 筛选区 | 5 | 项目胶囊行（3 种胶囊样式）、`WorkFilterBar`、IQL 输入、Backlog 的 Search/Sort/Direction 表单、Board 290 行内联筛选条；In Review 与 Candidates 使用同一组件但顺序相反、缩进不同 |
| 批量操作条 | 4 | In Review 顶部条 + 重复的 Select all、Candidates 悬浮毛玻璃条（违反无模糊规则）、Needs you 借用、Board 内联 |
| 工单列表行 | 9 | IssueCard、backlog-table、My Issues 内联 grid、bugs-list、search-result、hygiene-item、observation-card、inbox-item、attention-row |
| 按钮 | 6 | CSS `.ui-action*`、内联 `Btn`（primary 是黑底）、未定义 `.btn*`、delivery.css 裸按钮、各页内联、`board-load-more__button` 等专用类 |
| 表单字段 | 12 | 标签大写 / 句首大写混用（`.issue-panel__label` 被定义两次，后者大写覆盖前者）；控件高度 22/24/26/28/30；圆角 5/6/8/10 |
| 原生 `<select>` | 79 处 / 6 套样式 | 无 `appearance` reset，系统箭头直接露出 |
| 对话框容器 | 3 | 1080px 侧抽屉（Report bug 用它却无内边距，表单复用评论框 `.discussion-form`）、原生 `<dialog>` 内联样式、行内卡片 |
| 空态 / 加载态 | 5 | `.observation-empty`、`padding:40` div、`.shell-notice`、`.inbox-page__empty`、`<p style>` |
| 内容宽度 | 8 | max-width 560 / 640 / 720 / 760 / 880 / 960 / 1100 / 无；内边距 5 种 |
| 分段切换 | 5 | `.inbox-page__toggle`、`.graph-tabs`、未定义 `.btn is-active`、Board 内联、胶囊冒充 |
| 统计卡 | 2 | `.bugs-stat`（Incidents 借用）vs `.hygiene-stat` |
| 内联样式 | 651 处 | CyclesPage 95、ProjectsPage 91、BoardPage 71、IssuePage 47、AdministrationTabs 40 |

---

## 三、规则（之后的每个 PR 都适用）

1. **页面骨架只有一种**：`PageHeader`（icon? / title / count? / hint? / actions）+ 可选 `PageToolbar`（项目胶囊 → `WorkFilterBar` → 视图控件，顺序固定）+ `PageBody`（`width: narrow 640 | default 880 | wide 1100 | full`）。不再写 `<div className="page-header">` 散件，不再内联 padding。
2. **工单号永不折行**：`.mono` 带 `white-space: nowrap`；在 flex 行里工单号 `flex: 0 0 auto`，标题 `flex: 1; min-width: 0` 并省略。固定 64px 列改 `max-content`。
3. **控件一套**：`Field`（label + hint + error，标签统一句首大写 12px `--fg-dim`）、`TextInput` / `TextArea` / `Select`（共享 `.control` 基类：高 30px、`--r-3`、`appearance: none` + 自绘箭头、焦点环同全局）。`prop-select` 是 `Select variant="ghost"`。禁止新的 `inputStyle` 常量。
4. **按钮一套**：`Btn` 改为 class-based（`.ui-action` 家族），变体 `accent | subtle | ghost | danger`，尺寸 `sm | md`。删除 `.btn*`；`--primary` 等价 `accent`。
5. **对话框一套**：`DialogShell variant="side" | "modal"`，header（标题 + Close）/ body（`--content-gutter` 内边距，可滚动）/ footer（右对齐操作，sticky）。短表单用 modal（max 520），不用 1080px 抽屉。
6. **列表行一套**：`ListRow`（leading / id / title / meta / trailing 五个槽），`DataTable`（显式 `grid-template-columns`，表头行，右对齐 actions 列，窄屏折叠）。设置页的成员 / 团队 / 标签 / 状态表全部走 `DataTable`。
7. **状态显示**：`StatTile` / `EmptyState`（icon / title / body / action）/ `InlineError` / `LoadingState` / `SegmentedControl` / `BulkActionBar` / `Badge`。
8. **Markdown**：任何展示 description / acceptance / summary 的地方都走 `MarkdownRenderer`，渲染器必须支持标题、列表、引用、分割线、代码块；长文用 `clamp` + "Show more"。
9. **颜色与数字只从 token 来**：TSX 不出现 hex / rgb（`.proj-color-*` 调色板与 Google logo 例外）；状态色 / 优先级色只在 `StatusIcon` 与 `--prio-*` 一处定义；不出现 `fontSize: 13` 一类字面量。
10. **守卫测试**（`styles/design-guard.test.ts`）：TSX 里的每个 `className` 必须在样式表中有定义；样式与 TSX 中的每个 `var(--x)` 必须在 token 块定义；TSX 中 hex 颜色只允许在白名单文件。新漂移在 CI 挡下。

---

## 四、原语目录与归属

| 原语 | 文件 | 替代的旧做法 |
|---|---|---|
| `PageHeader` `PageToolbar` `PageBody` | `components/layout/Page.tsx`（`components/layout/index.ts`）+ `styles/layout.css` | 5 种 header、8 种宽度 |
| `Field` `TextInput` `TextArea` `Select` `Checkbox` | `components/controls/*.tsx` + `styles/controls.css` | 12 种字段、79 个裸 select、5 个 `inputStyle` |
| `Btn`（重写） | `components/Primitives.tsx` | `.btn*` `.ui-action--primary` 内联按钮 |
| `DialogShell` | `components/DialogShell.tsx` | `.issue-panel` 复用、`<dialog>` 内联 |
| `DataTable` | `components/DataTable.tsx` | 设置页表格、`rowStyle` |
| `ListRow` `IssueRow` | `components/list/ListRow.tsx`（`components/list/index.ts`）+ `styles/content.css` | 9 种行：My Issues grid、`bugs-list`、`search-result`、`hygiene-item`、`inbox-item`、`attention-row` 已迁移；保留 `IssueCard`（Board）、`.observation-card`（In Review / Candidates 的卡片）与 Backlog 表格 |
| `StatTile` `StatRow` `EmptyState` `InlineError` `LoadingState` `SegmentedControl` `BulkActionBar` `Badge` | `components/status/Status.tsx`（`components/status/index.ts`）+ `styles/layout.css`（`Badge`：`styles/content.css`） | 见 §2.2；`Badge` 替代 `.observation-card__status`、`.views-card__kind`、`.context-chip`、`attention-row__flag` |
| `FilterChip` `FilterMenu` `FilterSearch` `SortControl` `SavedViewControl` | `components/filters/Filters.tsx`（`components/filters/index.ts`）+ `styles/layout.css` | 5 种筛选区 |
| `MarkdownRenderer`（块级 + `clamp`） | `components/MarkdownRenderer.tsx` + `styles/content.css` | 裸文本；标题 / 列表 / 任务列表 / 引用 / 分割线 / 表格 / 代码块 |
| `.card`（样式类，不是组件） | `styles/content.css` | Projects / Cycles / Views 各自的卡片外壳 |
| 状态色 | `components/StatusIcon.tsx`（`getStatusColorVar` / `statusKindForStateType`） | `graph-colors.ts` 与时间线 CSS 里的重复 hex |

ListRow 打开规则：列表行（My Issues / Bugs / Search / Incidents / Health）用 `IssueRow open="drawer"`：单击在当前路由加 `?issue=<identifier>`，由 App 壳里的 `IssueDrawerHost` 打开抽屉（Board / Backlog 自带抽屉）；链接 href 仍是 `/issue/:identifier`，⌘/Ctrl/中键交给浏览器打开整页；关闭只去掉 `issue` 参数（INV-1387）。Needs you 与 In Review 不变；In Review 卡片的工单号仍进入 `/work/:id`（上下文页）。

迁移进度见 `IMPLEMENTATION_PLAN.md` 的「UI 一致性」章节；每个阶段对应一张 Involute 工单。
