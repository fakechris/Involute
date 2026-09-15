# Involute 快捷键规范与帮助系统设计规范（对齐 Linear 工业级体系）

> **目标**：规范 Involute 全局与局部键盘快捷键体系，消除单键动作与二级导航的语义冲突，对齐 Linear 工业级快捷键规范，提供统一的全局帮助速查菜单（`?` / `⌘/`）。

---

## 一、 问题根因复盘：为何“按 C 同时触发 Candidates 与 Create Issue”

在修复前的实现中，存在以下关键问题：

1. **视觉暗示与真实按键绑定割裂**：
   - 侧边栏一级导航菜单中的候选工单项（Candidates），其 `<kbd className="app-shell__link-kbd">` 视觉标签此前仅显示 `C`（同理看板项显示 `B`、工作图显示 `R` 等）。
   - 用户在侧边栏看到 `Candidates [C]`，直觉按 `c` 期望跳转候选页。
2. **全局单键抢占（Global Single-Key Conflict）**：
   - 全局按键监听器将单键 `c` 绑定为全局高频操作 `openCreateIssueSurface`（创建工单抽屉/弹窗）。
   - 真正的候选页跳转实际需要先按 `g`（Go to 前缀）再按 `c`（即 `G C` 和弦）。
   - 这种视觉呈现的缺失和混淆，使用户误以为按 `c` 会同时或随机触发 Candidates 导航和 Create Issue。
3. **状态残留与 IME 组合输入干扰**：
   - 前缀键 `g` 未设置平滑的取消反馈与状态指示器；
   - 未拦截中文拼音输入法组合态（`event.isComposing`），导致在中文输入时可能误触发快捷键。

---

## 二、 Linear 快捷键工业级基准调研 (Linear Benchmark)

通过深入调研 Linear 的键盘交互设计哲学：

| 维度 | Linear 规范 | Involute 对齐实现 |
|---|---|---|
| **导航逻辑** | **双键 G-Chord 独占**（`G I` 进 Inbox，`G M` 进 My Issues，`G B` 进 Board，`G C` 进 Cycles，`G P` 进 Projects） | **双键 G-Chord 独占**（`G B` 看板、`G C` 候选、`G N` 审查、`G U` 缺陷、`G R` 关系图等） |
| **单键动作** | **全局动作独占**（`C` 专用于 Create Issue，`X` 用于选择，`J`/`K` 用于上下移动） | **全局动作独占**（`C` 专用于创建工单，单键绝不用于菜单导航） |
| **菜单视觉** | 菜单与浮层上**严禁**标注孤立单字母导航徽标，必须完整展示 `G B`、`G I` | 侧边栏与浮层统一完整标注 `G B`、`G C`、`G N` 等，杜绝暗示冲突 |
| **和弦指示** | 按下 `G` 后屏幕底部显示悬浮指示器（`Go to…`），等待第二键或 1.5s 超时 | 按下 `G` 后屏幕底部展示 `.goto-chord-indicator`（`Go to… (B, L, C, N...)`） |
| **帮助入口** | 随时按 `?` 或 `⌘/` 唤出全量快捷键面板，支持分类与实时模糊搜索 | 随时按 `?` 或 `⌘/` 唤出 `KeyboardShortcutsDialog`，支持分类与实时搜索 |
| **取消机制** | 按 `Esc` 立即取消当前挂起和弦或关闭快捷键弹窗 | 按 `Esc` 立即清理 `gotoPrefixTimeoutRef` 与关闭弹窗 |

---

## 三、 Involute 标准化快捷键映射表

### 3.1 页面导航（Navigation G-Chords）
需先按 `G`，在 1.5 秒内按下目标键；按 `Esc` 可随时取消。

| 快捷键 | 目标页面 | 说明 |
|---|---|---|
| <kbd>G</kbd> <kbd>B</kbd> | 看板 (Board) | 打开主看板工作台（`/`） |
| <kbd>G</kbd> <kbd>L</kbd> | 待办列表 (Backlog) | 打开已承诺待办列表（`/backlog`） |
| <kbd>G</kbd> <kbd>C</kbd> | 候选队列 (Candidates) | 打开未经审查确认的候选提议（`/candidates`） |
| <kbd>G</kbd> <kbd>N</kbd> | 待审查 (In Review) | 打开 Agent 已完成待人工验收工作（`/in-review`） |
| <kbd>G</kbd> <kbd>U</kbd> | 缺陷反馈 (Bugs) | 打开缺陷快速提报与分类列表（`/bugs`） |
| <kbd>G</kbd> <kbd>R</kbd> | 关系拓扑 (Graph) | 打开任务依赖与拓扑关系图（`/graph`） |
| <kbd>G</kbd> <kbd>I</kbd> | 收件箱 (Inbox) | 打开活动通知与溯源告警列表（`/inbox`） |
| <kbd>G</kbd> <kbd>M</kbd> | 我的工作 (My Issues) | 查看分配给当前用户的工单（`/my-issues`） |
| <kbd>G</kbd> <kbd>P</kbd> | 项目列表 (Projects) | 打开全部项目目录与根节点（`/projects`） |
| <kbd>G</kbd> <kbd>V</kbd> | 里程碑周期 (Cycles) | 打开迭代与里程碑视图（`/cycles`） |
| <kbd>G</kbd> <kbd>W</kbd> | 视图列表 (Views) | 打开自定义保存的看板/列表视图（`/views`） |
| <kbd>G</kbd> <kbd>E</kbd> | 成员团队 (Members) | 打开团队成员与权限管理（`/members`） |
| <kbd>G</kbd> <kbd>S</kbd> | 系统设置 (Settings) | 打开系统与偏好设置（`/settings`） |
| <kbd>G</kbd> <kbd>A</kbd> | 访问密钥 (Access) | 打开 Agent Token 与 API 密钥设置（`/settings/access`） |

### 3.2 全局动作（Global Actions）
无需前缀，直接触发（聚焦在文本输入框、下拉框或组合输入时不生效）。

| 快捷键 | 动作 | 说明 |
|---|---|---|
| <kbd>C</kbd> | 新建工单 (Create Issue) | 打开新建工单抽屉，单键独占 |
| <kbd>⌘</kbd> <kbd>K</kbd> 或 <kbd>Ctrl</kbd> <kbd>K</kbd> | 命令面板 (Command Palette) | 搜索工单、快速跳转、执行全局指令 |
| <kbd>?</kbd> 或 <kbd>⌘</kbd> <kbd>/</kbd> | 快捷键帮助 (Help Menu) | 打开分类快捷键速查模态框 |
| <kbd>T</kbd> | 切换明暗主题 (Theme Toggle) | 在 Dark 与 Light 主题间平滑切换 |
| <kbd>Esc</kbd> | 取消 / 关闭 | 退出和弦等待、关闭抽屉、关闭快捷键面板 |

### 3.3 列表与看板导航（Board & Backlog Navigation）

| 快捷键 | 动作 | 说明 |
|---|---|---|
| <kbd>J</kbd> / <kbd>↓</kbd> | 下一项 (Next Issue) | 在待办列表或当前看板列中选择下一项 |
| <kbd>K</kbd> / <kbd>↑</kbd> | 上一项 (Previous Issue) | 在待办列表或当前看板列中选择上一项 |
| <kbd>Enter</kbd> | 查看详情 (Open Details) | 打开当前聚焦工单的详细信息抽屉 |

---

## 四、 交互与工程落地细节

1. **防抖与和弦指示器 (`.goto-chord-indicator`)**：
   - 当用户在非输入态按下 `g` 键时，页面底部弹出提示条：
     ```html
     <div className="goto-chord-indicator" role="status" aria-live="polite">
       <kbd>G</kbd>
       <span>Go to… (B, L, C, N, U, R, I, M, P, V, W, E, S)</span>
     </div>
     ```
   - 维持 1500ms 监听窗口；一旦用户输入下一个键或按下 `Esc`，定时器立即清空，指示器平滑消失。
2. **快捷键帮助浮层 (`KeyboardShortcutsDialog.tsx`)**：
   - 具备独立无障碍对话框语义（`role="dialog"`，`aria-label="Keyboard shortcuts"`）；
   - 内置实时搜索输入框，支持拼音与关键词快速定位；
   - 分类展示：`Navigation (G Chords)`、`Global Actions`、`Board & Backlog Navigation`；
   - 在侧边栏底部常驻键盘图标按钮，同时在全局命令面板（`⌘K`）中收录 `Keyboard shortcuts` 动作。
3. **输入焦点与 IME 安全守卫**：
   - 严格拦截 `INPUT`、`TEXTAREA`、`SELECT` 以及带有 `contenteditable="true"` 的富文本编辑器；
   - 增加 `if (event.isComposing) return;` 保护，彻底杜绝中文输入法敲击选词时的意外触发。
4. **组件生命周期与重渲染稳定性**：
   - 监听器内通过 React Ref 引用最新 `isPaletteOpen`、`isShortcutsOpen`、`location.pathname` 和 `session` 状态；
   - 事件监听器无需在每次路由切换或 Session 加载时重复解绑与重新挂载，彻底根除了快速敲击 `G C` 时因 Session 异步加载导致和弦被意外中断的边界竞态。
