# AGENTS.md

## 提交信息

提交信息使用中英双语，标题格式：

```
<type>(<scope>): <中文说明> / <English description>
```

- **type**：从 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`chore`、`ci` 中选择；scope 可省略。
- **顺序**：中文说明在前，英文说明在后，用 ` / `（斜杠前后各一个空格）分隔，两部分表达同一含义。
- **中文说明**：简洁陈述做了什么，句末不加标点。
- **英文说明**：以小写的动词原形开头（如 add、fix、update、remove），句末不加句号。
- **长度**：标题只占一行。因含两种语言，不受 72 字符限制，但两部分各自应尽量精炼（中文约 30 字以内，英文约 70 字符以内）。
- **正文**：改动较复杂时，空一行后分点说明，每点同样采用「中文 / English」格式。简单改动不写正文。
- **破坏性变更**：在 type 后加 `!`，如 `feat!: …`。
示例：

```
feat: 新增 present_files 工具与交付卡，支持向用户交付成品文件 / add present_files tool and deliverables card for delivering output files
```

```
fix: 修复交付重复路径时模型反复重试的问题 / fix repeated retries when delivering duplicate paths
```

```
feat: 新增回复完成与等待输入的系统通知 / add system notifications for reply completion and pending input

- 窗口未在前台时，回复完成或需要确认后弹出系统通知 / show a system notification when a reply completes or needs input while the window is in the background
- 点击通知跳转到对应对话 / clicking the notification opens the conversation
```

## 代码组织

以下路径均相对 `apps/desktop/src/`。

- **文件大小**：源文件超过约 800 行时，新功能放进新模块，不再往里追加；i18n 词条等数据表除外。拆分已有大文件要单独提交，不和功能改动混在一起。
- **函数大小**：函数超过约 150 行或包含多个阶段时，按阶段拆成具名函数。
- **共用代码放 `shared/`**：主进程、preload、渲染层共用的类型和逻辑只写一份；对话协议类型统一放在 `shared/chat-protocol.ts`。
- **新增工具**：在 `main/services/tool-catalog.ts` 登记，在 `main/services/tools.ts` 的 `toolHandlers` 里加处理函数；需要在闸门前处理的，加进 `main/services/agent-loop.ts` 的 `loopTools` 表，不要在循环里写 if/else 特判。
- **会话状态**：多个模块共用的放在 `main/services/chat-state.ts`，只有一个模块用的留在那个模块里。
- **改写会话历史的操作**（删轮、压缩、回滚、开始回合）要先检查 `historyLocked()`。
- **配置类文件写盘**用 `writeFileAtomic()`（`main/services/atomic-write.ts`）。
- **渲染层**：外壳的新功能单独建文件放进 `renderer/src/redesign/`，`ChatFirstShell.tsx` 只负责组合；读对话状态时用范围最小的 `useChatActions` / `useChatState` / `useChatStream`。

### 能力 → 唯一实现

做这些事之前先确认用哪一处；表中未列的，先 `grep` 找现有写法，不要自己另起一套。

| 要做的事 | 唯一实现（相对 `apps/desktop/src/`） |
| --- | --- |
| 新增工具 | `main/services/tool-catalog.ts` 登记 + `main/services/tools.ts` 的 `toolHandlers` |
| 工具需在闸门前处理 | `main/services/agent-loop.ts` 的 `buildLoopTools` 返回表 |
| 改写会话历史（删轮、压缩、回滚、开始回合） | 先查 `main/services/chat-locks.ts` 的 `historyLocked()`（`chat-state.ts` 只是转导出） |
| 项目说明（`AGENTS.md`）注入 | `main/services/project-doc.ts` 的 `loadProjectDocChain` / `projectDocPromptSection`（单份场景才用 `loadProjectDoc`） |
| 记忆读写 | `main/services/memory.ts` 的 `listMemories` / `readMemories` / `writeMemory` / `replaceMemories` |
| 工作树路径归一化与比较 | `main/services/worktree/paths.ts`（主进程侧；渲染层路径比较另有 `renderer/src/redesign/shell-common.tsx` 的 `samePath`） |
| 界面文案 | `renderer/src/i18n/messages.ts` 与 `renderer/src/i18n/fork.ts`，中英必须同一键 |

- **按钮**：用 `.btn` 体系（`styles/app.css`，`btn--` 变体全仓 132 处）。`.cf-btn` 是二开自造、仅 16 处（7 个文件），新代码不要用。
- **设置项 / 表单行**：用 `.cf-set` / `.cf-set__row`（`renderer/src/redesign/redesign.css`）。`.cf-backup__card` 这类竖排卡片是二开自造，已移除，不要加回来。

### 目录约定

根 `AGENTS.md` 与下列目录的 `AGENTS.md` **同时生效**（`project-doc.ts` 每轮按宽→窄全量注入，近者优先）；
改这些目录前，先看对应那份。

| 目录 | 管什么 |
| --- | --- |
| `apps/desktop/src/main/services/` | 工具实现、会话持久化、历史锁、写盘例外 |
| `apps/desktop/src/main/providers/` | 模型供应商适配、超时、密钥三态 |
| `apps/desktop/src/renderer/src/redesign/` | 外壳层、必须复用的 CSS 类、图标对齐 |
| `apps/desktop/src/renderer/src/features/` | 功能模块、依赖方向 |
| `apps/desktop/src/shared/` | 四方共用协议与类型 |
| `.deva/qa/` | 判据写法：反向验证、剥注释、禁兜底正则 |

- **决策记录在 `notes/`**：`proposed/` 未落地、`implemented/` 已落地、`archived/` 冻结只读（不得改）。
  新增一条必须检查它是否取代了旧决策，被取代的移入 `archived/`——规则见 `notes/AGENTS.md`。
- **一次性文件用完即删**，不进仓库：排查记录、临时脚本、补丁包都不留。

## 分支与合并

- **任何合并都先开临时分支**（`merge/<来源>-into-<目标>`），在它上面解冲突、跑验证，通过后才回目标分支合并它；用完即删。不许在 `dev` / `main` 上直接 `git merge`。
- **三个方向不许弄反**：回灌 `dev` → `feat/*`（进行中，随时）；合入 `feat/*` → `dev`（做完且验收通过）；发版 `dev` → `main`（用户明确说要发版）。详见 `docs/development-branches.md`。
- **未完成的功能不进 `dev`，也不进 `main`。** 合入前逐条核对 `docs/development-branches.md` 的四项条件，缺一项就不合。CI 绿只是必要条件。
