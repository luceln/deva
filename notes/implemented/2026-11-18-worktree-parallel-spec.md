# 多需求并行开发 · 实现规格（v1 定稿）

> **取代关系（2026-11-23 归档时补记）**
> 本文件是「多需求并行开发」这一主题的**最终版**，取代以下两份：
> - `archived/2026-11-18-worktree-parallel-acceptance-v4.md`（原 `.deva/req-worktree-parallel.md`，验收清单 v4）
> - `archived/2026-11-18-worktree-parallel-scope-v3.md`（原 `.deva/req-worktree-parallel-v3.md`，口径拍板记录 v3）
>
> 取代方式是「**合并进单一规格**」：三份原本分层（验收 / 口径 / 实现），实操中没人说得清哪份有效，
> 已把验收与口径的有效内容并入本文件 §0.2 与各条断言。两份原文冻结在 `archived/` 仅作历史。
> **已实现**：`apps/desktop/src/main/services/worktree/` 15 个文件 + `preload/worktree.ts` +
> `WorktreePane.tsx` / `MergePanel.tsx`（见 `git log --oneline -- apps/desktop/src/main/services/worktree/`）。

> 状态：已拍板，可直接派工。供求实现方与验收方共同遵守。
> 上游：`archived/2026-11-18-worktree-parallel-acceptance-v4.md`（v2 的 34 条断言）+ `archived/2026-11-18-worktree-parallel-scope-v3.md`（口径）+ `.deva/design/worktree-parallel.html`（界面原型，不纳入版本管理）。
> **本文件与 v2/v3 冲突时以本文件为准**（仅限本文件显式声明的覆盖项，见 §0.2）；与原型冲突时见 §11.2（四处，均已按原型修正）。
> 阅读顺序：§0 → §1 → §3（实现主线）→ §4（合并）→ 其余按需。§10 是交付前自查清单，§11 是原型一致性核对。

---

## 0. 范围与既有口径的处置

### 0.1 一句话

新建会话时可选位置：**主目录**（默认）或**新 worktree**。选新 worktree 时，在该独立工作区上开一个**全新上下文**的会话，其 `focusRoot` 即 worktree 绝对路径；成果通过「最小合并」手动合回创建时固定的目标分支。

**不做**：会话分叉（继承历史）、链式分叉、worktree 生命周期状态机、冲突解决面板、preflight revision、文件重叠预检测、每 worktree 独立数据目录、dev server 端口分配、自动推送。

### 0.2 本文件对 v2 的覆盖项（必须执行）

| v2 条目 | 处置 | 原因 |
|---|---|---|
| **A15**（新会话带原会话上下文） | **作废** | v3 §一 明确放弃「分叉」：继承历史会让 agent 基于与新工作区实际内容脱节的历史行事。A15 要的正是 v3 判定有害的东西。 |
| **A16**（在 worktree-A 的会话里再分叉出 worktree-B） | **作废** | 链式分叉明令不做（v2 §三、v3 §五）。 |
| **A7**（「从 worktree-A 的会话点分叉」） | 改写 | 保留其**内核**：新 worktree 的 base 等于**主检出**的 HEAD，不等于 worktree-A 的 HEAD。场景改为「从 worktree-A 的会话里新建会话并选新 worktree」。 |
| **A8**（worktree-A 内 detached 后分叉） | 改写 | 同上：base 取主检出 HEAD，与 worktree-A 的 HEAD 无关。**A8 保护的正是「默认起点不依赖发起目录的分支名」这条。** |
| **A13 / A14 / A31** 中的「分叉产生的新会话」 | 改写 | 一律读作「新建会话时选了新 worktree」。 |
| 待澄清 1/2/3/4/5/6/7 | 全部已定 | 见 §1.4、§3.3、§4.3、§5.2、§2.2、§5.3、§2.6。 |

**关于 A7/A8 的确切改写**（避免验收时误读）：这两条原来写「从 worktree-A 的会话点分叉」，现在没有任何入口叫「分叉」。改写后的场景与判据：

- **A7'**：在「worktree-A 的会话」里新建会话、选「新工作区」→ 新 worktree 的 `baseSha` 必须等于**主检出**的 HEAD，**不等于** worktree-A 的 HEAD。
- **A8'**：先在 worktree-A 里 `git checkout --detach`，再在**该会话**里新建会话选「新工作区」→ 同样取主检出 HEAD，创建成功。

两条共同验证的是「默认起点不依赖发起会话所在目录的分支/HEAD」——这是 §3.1 Step 0 与 §7.6 的硬口径。

### 0.3 新增断言（v2 未覆盖，必须补）

v2 写于「不做合并 UI」的阶段，且未覆盖记忆共享与边界告知。以下断言由本文件新增，验收时必须一并执行：

| 编号 | 断言 |
|---|---|
| A35 | worktree 会话读到的项目私有记忆与主仓库完全一致；在 worktree 会话里 `memory_write(scope="project")` 写入后，主仓库会话立刻能读到同一条；`memory_read` 输出里的项目私有记忆标签应显示主仓库根路径，并注明与当前工作区共享 |
| A36 | worktree 会话的系统提示词【环境】段同时包含：①当前工作目录 = worktree 绝对路径；②「你在独立工作区里，改动需手动合回 `<targetBranch>`」；③「本工作区从 `<baseLabel>` 切出，不含主目录未提交的改动」＋未提交改动数量；④**负面约束**「不要假设你看到的就是主目录的当前状态，需要确认时读文件而不是凭记忆」；⑤「项目记忆与主仓库共享」 |
| A37 | 合并成功路径：source 与 target 检出均干净、target 分支在唯一检出中 → 合并后 target 分支多一个**两条父提交**的合并提交（`--no-ff` 生效），source 文件内容出现在 target 中，source 分支与 worktree 均不受影响 |
| A38 | **（改写）** source 有未提交改动时：C1 **不阻断**（`status: 'warn'`，`detail.dirtyCount` 为真实数字），界面显示「这 N 个改动不会被合并」；合并可继续，且**只有已提交内容被合并** |
| A39 | **（改写）** target 有脏改动但**与合并要改的路径无交集**（用三点 diff 判定）：C5 通过，合并成功，**脏改动逐字节保留** |
| A40 | 在 worktree 里 `git checkout <其它分支>` 后点合并 → 明确拒绝（source 不在自己的分支上），不执行 merge |
| A41 | target 分支已不在任何检出中（用户在主目录切走且没在别处检出）→ 明确拒绝并说明，不执行 merge |
| A42 | 合并冲突 → 返回内容含 git 原始 `CONFLICT` 文本；target 检出 `mergeInProgress === true`（复用的 `git:status` 字段），界面出现可用的「中止合并」 |
| A43 | 合并失败后不得自动 `git merge --abort`、不得 `reset --hard`、不得删除 source 分支（失败后 source 分支与 worktree 内容逐字节不变） |
| A44 | 同一 worktree 用大小写不同 / 尾部斜杠不同的路径表示时，只算一个记录、一个关联会话、一把锁 |
| A45 | 在 worktree 会话里把挂载改成别的目录后：worktree 记录仍在、`state` 仍为 `ok`、关联会话数归 0；原 worktree 目录与分支不受影响 |
| A46 | worktree 完整路径超过 180 字符 → 提交前报错并说明，不产生分支、不产生目录 |
| A47 | 分支名为中文 / 含空格 → slug 回落为 `worktree`（或用户改写后的值），路径框可编辑；用户改写为合法值后创建成功 |
| A48 | 把 worktree 切到别的分支后，列表卡片显示 `branch-mismatch` **且**合并按钮禁用（`mergeGate.mayMerge === false`）——两处同时反映同一事实，界面不自行推断 |
| A49 | 两个会话同时发起合并同一 target：第二个收到「正在等待」提示后串行完成，两者都能得到确定结果（成功或明确失败原因），`.git/index.lock` 不留残 |
| A50 | 主目录 detached 时仍能创建（`targetBranch === null`）、`precheck` 给出 `primaryDetached` + `mergeTargetWarning`；未指定目标时合并被拒（`target-not-set`，target 未被触碰） |
| A51 | 四项检查**全列**：source 脏 + source 分支被切走 + target 找不到检出 + target 脏 同时成立时，`checks` 长度为 4 且全为 `bad`（不得只报第一个） |
| A52 | 合并成功返回 `mergeCommit`（40 位）且 `gitOutput` 非空；`upToDate` 时 `mergeCommit === null` 且界面不显示 SHA |
| A53 | 删除 worktree：`ok` + 3 个未提交改动 → 拒绝并回 `dirtyCount: 3`；勾选丢失确认后可删；`deps === 'installing'` 时无条件拒绝（不给勾选项） |
| A54 | 「无关联会话」是 `sessionCount === 0`，与 `state` 正交：`ok`+0 会话 与 `dir-missing`+1 会话 两种组合都能正确表达 |
| A55 | 「复制 git 命令」含 `cd`、目标是 **targetPath**（不是 sourcePath）、Windows 带 `/d`；冲突时给 `git merge --abort` 版本 |

**A37 的补充要求**（与 A52 配套）：合并成功后必须能从返回值里拿到 `mergeCommit`，且它在 target 检出上 `git rev-parse HEAD` 与之相同、`git cat-file -p <mergeCommit>` 显示两个 `parent` 行。只在 UI 上说「已合并」不算通过。

---

## 1. 术语与数据模型

### 1.1 术语

| 术语 | 含义 |
|---|---|
| **主目录** | 仓库的 primary worktree，即 `git worktree list --porcelain` 里第一个（无 `worktree` 条目之外的标记）的那个。本仓为 `E:\deva`。 |
| **worktree / 独立工作区** | 由本功能创建、检出**独占分支**的第二个工作目录。 |
| **worktree 会话** | `focusRoot` 等于某个 worktree 绝对路径的会话。 |
| **baseSha** | 创建时冻结的 40 位提交 SHA，`git worktree add` 的第三个参数。 |
| **baseLabel** | baseSha 来源的人类可读写法（`my/dev` / `origin/feat/x` / `HEAD (detached @ abc1234)`），仅供显示。 |
| **targetBranch** | 创建那一刻**主目录**的分支名。合并目标，之后永不跟随。 |
| **repoRoot** | 主目录绝对路径（`git rev-parse --show-toplevel` 在 primary worktree 的结果）。 |
| **repoKey** | `repoRoot` 归一化后的 sha1 前 16 位，用于磁盘目录分桶。 |

### 1.2 `worktrees.json` 记录结构

**位置**：`<DEVA_HOME>/worktrees.json`（与 `config.json` 同级，**不是** config 的一个键）。工作目录在 `<DEVA_HOME>/worktrees/<repoKey>/<slug>-<shortid>/`。

**为什么不用 config.json**：config 是用户可手改、会被导入流程合并、`config:set` 走顶层浅合并（`services/config.ts:183`）。worktree 记录是机器状态、有生命周期、路径作 key，放进 config 一定会被 `config:set` 的合并语义误伤。**必须是独立文件**，由主进程独占，写盘走 `writeFileAtomic`（`atomic-write.ts:11`）。

```ts
/** 一条 worktree 记录。文件整体形状：{ schemaVersion: 1, records: WorktreeRecord[] } */
interface WorktreeRecord {
  schemaVersion: 1
  /** 绝对路径（已过 normalizeWorktreePath，保留大小写）。展示、focusRoot 值、git argv 用。 */
  path: string
  /** 归一化比较键（见 §6.2）。**记录的主键**、锁 key、关联会话反查用。 */
  compareKey: string
  repoRoot: string
  repoKey: string
  /** worktree 独占的本地分支全名（不含 refs/heads/）。创建后永不改。 */
  branch: string
  /** 40 位 SHA。创建时冻结，永不改。 */
  baseSha: string
  /** 显示用。 */
  baseLabel: string
  /** 创建时主目录的分支；主目录 detached 时为 null（§3.1）。永不跟随。null 时合并需用户先指定目标。 */
  targetBranch: string | null
  createdAt: number
  /** creating = 创建中（崩溃恢复用）；active = 可用。 */
  phase: 'creating' | 'active'
  /** 创建 Step 0 的探测结果，失败清理据此判定「本次新建」。 */
  intent: { branchExistedAtStart: boolean; pathExistedAtStart: boolean }
  deps: DepsState
  depsDetail?: string
  depsUpdatedAt?: number
}
```

| 字段 | 类型 | 来源 | 何时写 | 何时读 |
|---|---|---|---|---|
| `path` | string | 用户确认后的目标路径，过 `normalizeWorktreePath` | Step 1（意图）、Step 3（定稿） | 展示、写入会话 `focusRoot`、git argv |
| `compareKey` | string | 由 `path` 派生（§6.2） | 同 `path` | **记录主键**、锁 key、关联会话反查、去重 |
| `repoRoot` | string | `git rev-parse --show-toplevel`（主目录） | Step 1 | 合并、删除、prune、记忆共享解析 |
| `repoKey` | string | `sha1(lower(repoRoot).slice(0,16))` | Step 1 | 磁盘分桶（仅创建时用） |
| `branch` | string | 用户输入或自动生成，过 `git check-ref-format --branch` | Step 1 | 合并检查 C2、删除时删分支、UI 显示 |
| `baseSha` | string | `git rev-parse <baseRef>^{commit}` | Step 0 探测但**Step 1 才落盘** | Step 3 校验、崩溃恢复、UI 显示 |
| `baseLabel` | string | 用户选的起点写法 | Step 1 | 仅显示（A36 边界说明） |
| `targetBranch` | `string \| null` | 主目录 `git rev-parse --abbrev-ref HEAD`；字面量 `HEAD` 时记 null | Step 1；**合并时用户若指定目标则更新**（§3.1） | 合并 C4/C5、A36 边界说明 |
| `createdAt` | number | `Date.now()` | Step 1 | 列表排序 |
| `phase` | `'creating'\|'active'` | 流程推进 | Step 1 = creating；Step 3 = active | 启动清扫（§2.4） |
| `intent` | object | Step 0 探测 | Step 1 | **失败清理的唯一准入凭据**（§3.4） |
| `deps` | `DepsState` | 依赖安装流程 | Step 4 各转移 | 列表、A36、删除前置检查 |
| `depsDetail` | string? | install 的最后 20 行 / 错误码 | install 失败时 | 列表详情、会话提示 |
| `depsUpdatedAt` | number? | 同 `deps` | 每次转移 | 仅排查 |

**必须实现的读写 API**（模块 `main/services/worktree/store.ts`）：

```ts
export function listRecords(): WorktreeRecord[]
export function getRecord(path: string): WorktreeRecord | null   // 内部先 normalize
export function upsertRecord(rec: WorktreeRecord): boolean        // 返回落盘是否成功
export function removeRecord(path: string): boolean
export function findRecordByRepo(repoRoot: string): WorktreeRecord[]
```

**落盘失败必须返回布尔并被检查**（对齐仓库既有铁律：写盘失败不得静默）。`upsertRecord` 返回 false 时，创建流程按失败处理并走清理（否则内存有记录、磁盘没有，重启后 worktree 变孤儿登记）。

### 1.3 `focusRoot` 复用为工作目录：完整影响面清单

**决定**：worktree 会话的 `focusRoot` 就填 worktree 绝对路径，**不新增任何「工作目录」字段**。

**为什么不能新增字段**：`focusRoot` 现在是终端 cwd、相对路径基准、权限作用域键、项目说明根、项目记忆根、GitWidget 目录、左栏分组键。新增平行字段等于把这些全部改写一遍，改动面横跨 `tools.ts`（2000 行）、`chat-prompts.ts`、`terminal.ts`、`fs-guard.ts`、`chat-store.ts`、渲染层 12 个文件。这与「一次性功能」的定位不符，且每一处漏改都是静默错误。

下表是**全部**读取 `focusRoot`（或 `effectiveRoot`/`workspaceRoot`）的位置，逐条给出 worktree 会话下的行为与处置。

| # | 位置 | 用途 | worktree 会话下的行为 | 需要改？ |
|---|---|---|---|---|
| 1 | `chat-store.ts:35` | 注释说明 | — | 否（注释补一句 worktree 也是工作目录） |
| 2 | `chat-store.ts:79/227/289/538/571/580` | 存储与索引字段 | 存 worktree 路径 | 否 |
| 3 | `chat-store.ts:245 projectKey` | 权限模式键（按目录区分 acceptEdits） | worktree 得到**独立的权限作用域**，默认权限模式 | **否**。这是正确行为：不同工作区本就该独立设置。实现方不要「优化」成共用主目录的键。 |
| 4 | `chat-turns.ts:452 mainRoot` | 成员会话的父工作区 | worktree 路径 | 否 |
| 5 | `chat-turns.ts:460 effectiveRoot` | 本轮有效根 | worktree 路径 | 否 |
| 6 | `chat-turns.ts:588 rootLabel` | 成员提示词里的文件夹名 | worktree 路径的末级名 | 否（显示层标签见 #20） |
| 7 | `chat-turns.ts:591/598/609` | `memoryPromptSection({root})` | **会把项目记忆指到 worktree 路径 → 空记忆** | **是**（§1.4，改为传 `memoryScopeRoot`） |
| 8 | `chat-prompts.ts:43-45` | 【环境】当前工作目录 | 显示 worktree 路径 | **是**（追加边界说明，§1.5） |
| 9 | `chat-prompts.ts:105-106` | 密封（定时任务）提示词【环境】 | worktree 路径 | **是**（同上，同一段逻辑要覆盖三条路径） |
| 10 | `chat-prompts.ts:163-164` | 成员提示词【环境】 | worktree 路径 | **是**（同上） |
| 11 | `chat-prompts.ts:344-346` | 子智能体提示词 | worktree 路径 | 否（子智能体继承父会话的根，边界说明已在父提示词里） |
| 12 | `project-doc.ts:32 loadProjectDoc(root)` | AGENTS.md | 读 worktree 里 checkout 出来的那份 | **否**（见下方说明） |
| 13 | `tools.ts:1807 run_command cwd` | 命令工作目录 | worktree 路径 | 否 |
| 14 | `tools.ts:1406/1472/1502/1514/1703/1722 resolvePath/ReadDir` | 相对路径基准 | worktree 路径 | 否 |
| 15 | `tools.ts:1876 listMemories` | memory_read 读项目记忆 | **空** | **是**（§1.4） |
| 16 | `tools.ts:1880` 标签 `（${ctx.workspaceRoot}）` | memory_read 输出标题 | 显示 worktree 路径 | **是**（§1.4） |
| 17 | `tools.ts:1917 / 1941` 写/删 scope | memory_write/delete | **写到 worktree 独立的一份** | **是**（§1.4） |
| 18 | `tools.ts:1902 / 1938` 空工作区守卫 | 同上 | 非空，不受影响 | 否（判据仍是「有没有工作区」，不是「哪一份记忆」） |
| 19 | `listing.ts:163-166 memoryListingPart(history, root)`；调用点 `agent-loop.ts:504` | **每轮下发的记忆清单** | **拿不到主仓库的项目记忆** | **是**（§1.4，最容易漏） |
| 20 | `listing.ts:184` 标签 `（${root}）` | 清单标题 | 显示 worktree 路径 | **是**（§1.4） |
| 21 | `memory.ts:77 projectMemoryKey` | 记忆文件路径 hash | 按传入的 root 算 | **否**（把 `repoRoot` 传进来即可，函数本身不动） |
| 22 | `memory.ts:392 ipcScope` | 渲染层 memory IPC 的 root | 渲染层目前只编辑全局（`memory-editor.ts:50` 的 `root?` 无人传），但**必须**在这里也做映射，否则将来传 focusRoot 会静默分裂 | **是**（§1.4） |
| 23 | `terminal.ts:91 terminal:create({cwd})` | 集成终端 cwd | worktree 路径 | 否 |
| 24 | `chat.ts:632-634 trustRoot(m.focusRoot)` | 重启后恢复受信根 | worktree 路径被信任 | 否（**自动受益**，不需要额外代码） |
| 25 | `chat.ts:578-588 chat:set-focus` | 会话中途换挂载 | 可把 worktree 会话的根改到别处 → 失去关联 | **是**（加提示，§1.6） |
| 26 | `agent-loop.ts:1257-1263` 挂载闸门 | agent 请求挂载后写 `session.focusRoot` | 同 #25 | 否（同 #25 的提示覆盖） |
| 27 | `fs-guard.ts:59 trustRoot` / `:79 isInsideRoot` | 渲染层 IPC 受信根 | worktree 在根内 | 否（创建流程内部自己 `trustRoot`，见 §3.2 Step 0） |
| 28 | `Rail.tsx:185 folderKeyOf` / `:390` / `:438` / `:1091-1094` | 左栏分组、筛选候选、搜索、行副标题 | 按 worktree 路径分组，副标题显示 slug 目录名 | **是**（仅显示标签，§1.7） |
| 29 | `ProfileView.tsx:159-162` | 会话行项目名 | 同上 | **是**（同 #28） |
| 30 | `TaskPickers.tsx:190` | 任务选择器的项目名 | 同上 | **是**（同 #28） |
| 31 | `Composer.tsx:446/912/920/921` | chip、WorkspaceMenu、GitWidget | 全部按 worktree 路径工作 | **是**（chip 标签，§1.7） |
| 32 | `GitWidget.tsx:45` 注释 | 说明受信根 | 成立 | 否 |
| 33 | `store/chat.tsx:1845-1850/1908/2036` | 覆盖层 `focusRoot` | 正常 | 否 |
| 34 | `chat-members.ts:256/274/312/330/412/426` | 成员文件夹跟随主会话 | worktree 路径 | 否 |

**关于 #12（AGENTS.md）必须写清的一点**：worktree 里的 `AGENTS.md` 是 base 提交里的那份，**主目录未提交的改动带不过去**。这里**不改**读取逻辑——因为 worktree 的代码状态就是那份 AGENTS.md 描述的状态，去读主目录的那份反而是在用一份与代码不符的约定指挥 agent。这个落差由 A36 的边界说明（③「本工作区从 `<baseLabel>` 切出，不含主目录未提交的改动」）向 agent 明示，并由 §1.5 的会话提示向用户明示。

**禁止的实现方式**（防止把这件事做错）：
- 不得新增 `workspaceRoot` 平行的会话字段。
- 不得把 worktree 的 `focusRoot` 归一成主目录路径（那会毁掉隔离，A9/A10 直接失败）。
- 不得在 `chat-store.projectKey` 里把 worktree 映射到主目录（会让权限模式跨工作区串台）。
- 不得在 `loadProjectDoc` 里回落到主目录的 AGENTS.md。

### 1.4 P1：项目私有记忆跨 worktree 共享（G5）——**改哪几处、改成什么**

**被解决的问题**：`memory.ts:77-91` 的项目记忆路径是 `projects/<sha1(realpath(root))>/memory.json`。worktree 是不同路径 → 每个 worktree 一份全新空记忆。后果是静默的：用户在 `E:\deva` 记下的「`pnpm` 前要先 `install`」「MySQL 在 WSL 里」，在 worktree 会话里 agent 一条都读不到，界面无任何提示，用户只会觉得「它在独立工作区里变笨了」。

**设计**：引入两个概念，名字必须严格区分，不得混用。

- `workspaceRoot` / `effectiveRoot` = **工作目录**（工具、命令、终端、相对路径的基准）→ 永远是 worktree 路径。
- `memoryScopeRoot` = **项目记忆根** → worktree 会话下等于 `record.repoRoot`；非 worktree 会话下**恒等于** `workspaceRoot`。

**唯一的解析函数**（新模块 `main/services/worktree/scope.ts`，只依赖 `store.ts` 与 `paths.ts`，**不得** import `git.ts`，避免环）：

```ts
/** worktree 路径 → 其主仓库根；不是已登记的 worktree 则原样返回。null 透传 null。 */
export function projectMemoryRootOf(root: string | null): string | null
```

实现要求：
1. `root` 为 null → 返回 null。
2. `normalizeWorktreePath(root)` 后查 `getRecord()`。命中 → 返回 `record.repoRoot`（同样过归一化）。
3. 未命中 → 返回 `root` **原值**（不要归一化后返回，否则非 worktree 会话的记忆键会随归一动而漂）。
4. **必须同步**（提示词构建是同步的）。记录是内存态 Map，同步查表即可，不得读盘。

**改动清单（逐处，必须全部落地）**

| # | 文件:行 | 现状 | 改成 |
|---|---|---|---|
| M1 | `tools.ts:594` `ToolContext` | 只有 `workspaceRoot` | 新增 `memoryScopeRoot: string \| null`（必填，所有构造点都要给，逼编译器指出漏改） |
| M2 | `chat-turns.ts:465-469` 构造 `ctx` | `workspaceRoot: effectiveRoot` | 追加 `memoryScopeRoot: memoryScopeRootForTurn`，其中 `const memoryScopeRootForTurn = projectMemoryRootOf(effectiveRoot)`（在 :460 之后定义） |
| M3 | `tools.ts:1876` | `listMemories({ kind:'project', root: ctx.workspaceRoot })` | `root: ctx.memoryScopeRoot!`（外层已有 `if (ctx.workspaceRoot)` 守卫，需同步改成 `if (ctx.memoryScopeRoot)`） |
| M4 | `tools.ts:1880` | `【项目私有记忆】（${ctx.workspaceRoot}）` | `【项目私有记忆】（${ctx.memoryScopeRoot}）`；当 `ctx.memoryScopeRoot !== ctx.workspaceRoot` 时追加一行 `（当前工作区 ${ctx.workspaceRoot} 与主仓库共享这一份记忆）` |
| M5 | `tools.ts:1902/1938` | `!ctx.workspaceRoot` 守卫 | 改判 `!ctx.memoryScopeRoot`（两者要么同时为空，要么同时非空，改判只为语义一致） |
| M6 | `tools.ts:1917` | `root: ctx.workspaceRoot as string` | `root: ctx.memoryScopeRoot as string` |
| M7 | `tools.ts:1941` | 同上（delete） | 同上 |
| M8 | `listing.ts:163` `memoryListingPart(history, root)` | 参数名 `root` | 重命名参数为 `memoryRoot`（**纯改名，不改行为**，防止下一个人照旧传 workspaceRoot）；`:166` 用 `memoryRoot`；`:184` 标签用 `memoryRoot` |
| M9 | `agent-loop.ts:504` | `memoryListingPart(modelMessages(h), ctx.workspaceRoot)` | 改传 `ctx.memoryScopeRoot`。**这是最容易漏的一处**：改漏了的表现是「提示词里说有记忆，每轮下发的清单里没有」——两个自相矛盾的信号，agent 会认为记忆不存在 |
| M10 | `chat-turns.ts:591` | `memoryPromptSection({ writable:false, projectWritable:true, root: effectiveRoot })` | 追加 `memoryRoot: memoryScopeRootForTurn` |
| M11 | `chat-turns.ts:598` | `memoryPromptSection({ writable:false, root: effectiveRoot })` | 同上 |
| M12 | `chat-turns.ts:609` | `memoryPromptSection({ writable:true, root: effectiveRoot })` | 同上 |
| M13 | `memory.ts:315-320` `memoryPromptSection` | `opts.root` 既是判据又是文案里的路径 | 新增 `memoryRoot?: string \| null`（缺省 = `root`，保持向后兼容）；`const memoryRoot = opts.memoryRoot ?? root`；判据用 `memoryRoot`，文案里出现的路径用 `memoryRoot` |
| M14 | `memory.ts:345-360` 项目记忆段 | 文案「当前工作区 / 当前文件夹（root）」 | 当 `memoryRoot !== root` 时，把「当前工作区」改为「当前工作区（与主仓库 `<memoryRoot>` 共享项目记忆）」；规则文字不变 |
| M15 | `memory.ts:392 ipcScope` | `{ kind:'project', root: root.trim() }` | `{ kind:'project', root: projectMemoryRootOf(root.trim()) ?? root.trim() }`。**渲染层现在只编辑全局**（`memory-editor.ts:50` 的 `root?` 无调用方传值），但这里必须提前接上：将来任一入口传 `focusRoot` 时不接就是静默分裂 |
| M16 | `chat.ts:765` 附近 / `chat-turns.ts:330` 的 `runTurn(workspaceRoot)` | 只传 workspaceRoot | **不改**。`memoryScopeRoot` 在 `runTurn` 内部由 `effectiveRoot` 现算（M2），不新增传参，避免穿透 4 层签名 |

**不需要改**：`memory.ts:77 projectMemoryKey`（它按传入 root 算 hash，把 repoRoot 传进来即可）、`memory.ts:131 saveMemories`（body 里的 `root` 字段会写成 `repoRoot`，正是排查时想要的）、`memory.ts:96 listMemories`、`memory.ts:373 snapshot`。

**行为描述（改后）**：
- worktree 会话里 `memory_read` 输出 `【项目私有记忆】（E:\deva）`，且紧跟一行「（当前工作区 `<worktree 路径>` 与主仓库共享这一份记忆）」。
- 在 worktree 会话里 `memory_write(scope="project", content=...)` → 写进 `projects/<sha1(E:\deva)>/memory.json`，`entries` 里出现新条目。
- 同一时刻在主目录的会话 `memory_read` → 立刻看到同一条（`listMemories` 每次读盘，无缓存，天然一致）。
- 每轮下发的「【记忆条目】/【记忆更新】」里项目私有记忆段与主仓库一致；切换 worktree 会话与主仓库会话时**不产生 diff**（`listing.ts:172 diffListing` 按 id+digest 比较，两处内容相同 → 不重发）。
- 项目记忆的总量上限是同一份：在 worktree 里写满，主目录也满。这是共享的必然结果，符合预期。

**必须同步更新的文案**（否则模型会以为记忆按目录分家）：
- `memory.ts:348` / `:351` 的「当前工作区另有一份」「当前文件夹（root）有一份」→ 共享时改为「主仓库范围内共用一份」。
- `memory.ts:358` 的「与代码现状不符时以代码为准」保留不变。

**不做的事**：不迁移已有记忆文件（worktree 从未有过记忆文件，无历史数据）；不做 worktree→主仓库的双向同步（只有一份，不存在同步）。

### 1.5 边界告知（A36）——改哪一段

v3 拍板 4 要求 agent 知道边界。落点在 `chat-prompts.ts` 的三处【环境】（`:43-45`、`:105-106`、`:163-164`），它们各自是 `systemPrompt` / `sealedSystemPrompt` / `memberSystemPrompt`。

**做法**：三处的 `loc` 都追加同一段补充信息，由新的可选参数 `worktree?: WorktreeBrief | null` 驱动（在 `chat-turns.ts` 的 3 个调用点按 `projectMemoryRootOf(effectiveRoot) !== effectiveRoot` 判定后传入）：

```ts
interface WorktreeBrief {
  branch: string
  targetBranch: string | null     // null = 创建时主目录 detached，尚未指定（§3.1）
  baseLabel: string
  repoRoot: string
  /** 主目录未提交改动数；0 时整行省略。与 A17/A36 的「不在本区」一致。 */
  primaryDirtyCount: number
}
```

**追加的完整文本（中文样例，`<...>` 为插值；英文同构，见 §7.4 的 `boundaryPrompt`）**。原型面 2 的展开原文是这段的英文版，两者必须语义一致：

> 你在**独立工作区**（git worktree）里工作。
>
> - 工作目录：`<worktreePath>`
> - 本目录是仓库 `<repoRoot>` 的一个 worktree，检出分支 `<branch>`
> - 起点：从 `<baseLabel>` 切出，之后主目录的分支前进不影响本目录
> - 改动合回：提交在本分支后，需要**手动合回 `<targetBranch>`**（尚未指定目标时写「尚未指定，需在合并面板里选一次」）。本应用不自动合并，冲突也不会自动解决
> - 不在本区：主目录还有 `<primaryDirtyCount>` 个未提交改动，它们都不在这个工作区里（`0` 时省略此行）
> - 项目记忆：与主仓库共享同一份项目私有记忆（在本目录记下的内容，主仓库会话也看得到）
>
> 因此：**不要假设你看到的就是主目录的当前状态**。需要确认某处改动是否存在时，读文件而不是凭记忆；历史消息里出现过的其它目录一律作废。

**三条硬要求**：

1. **负面约束必须保留**（`不要假设你看到的就是主目录的当前状态…读文件而不是凭记忆`）。这是整段里唯一防止「agent 凭记忆断定某改动存在/不存在」的句子——而这正是本需求立项的根本动机。删掉它，其余四行就只是描述性的，模型仍可能按主目录的心智模型行事。
2. **「不在本区」那一行必须有数字**，且与 A17 的 `dirtyCount` 同源（同一次 `status --porcelain` 计数，不重新数）。理由：这句话要能对上用户在创建弹窗里看到的同一个数字，否则用户无法核验。
3. **「项目记忆」那一行必须写**（原型待定 ⑤ 定稿为「要提」）。理由：用户若不知道共享，在 worktree 里记了一条、切回主目录看到它，会怀疑是不是串了数据；同时 agent 被告知共享后，才知道在这里写的项目记忆是全局有效的，不会为了「不影响主仓库」而回避写。

**必须与 `chat-prompts.ts:44` 既有那句兼容**：既有「用户可随时切换工作区——历史消息里出现过的其它目录一律作废，恒以本行为准」保留在前，worktree 说明追加在后。两者不冲突（前者说「以本行为准」，后者说「本行是独立工作区」）。上面那段最后一句与 `:44` 是同一句，**不要重复写两遍**——实现时把 `:44` 那句视为已存在，追加段从「你在独立工作区里工作」开始，末尾的「历史消息里出现过的其它目录一律作废」由 `:44` 承担。

### 1.6 `chat:set-focus` 的关联保护（A45 / R14）

`chat.ts:578-588` 允许任意会话把 `focusRoot` 改成任意路径（成员会话走 `setMemberFolder`）。worktree 会话被改挂后，它与 worktree 的关联按「`focusRoot` 是否等于 worktree 路径」判定——关联自动变为 0，这本身是**正确且可推理解**的行为，不做干预。

**必须做的只有两件**：
1. 渲染层（`Composer.tsx` 的卸载 ✕ 与 `store/chat.tsx:2122 setBinding`）在**目标会话的 `focusRoot` 是已登记 worktree 路径**时，确认框文案追加一句：「该会话将不再关联到工作区 `<branch>`（工作区本身不会被删除）」。
2. worktree 列表详情里显示「关联会话 N」，让用户在改挂之前就知道有会话在用它。

**明确不做**：不阻止改挂、不改挂后自动删 worktree、不在 worktree 记录上反向记 sessionId 列表（列表会漂、要维护）。

### 1.7 显示标签（仅显示，不涉及逻辑）

worktree 的目录名形如 `deva-my-dev-a1b2c3`。直接显示会难辨。**规则**：能拿到 `worktree:list` 快照时优先用 `分支名`，拿不到回落 `basename(path)`。

**收敛到一个函数**（新文件 `renderer/src/redesign/worktree-label.ts`，纯函数 + 从 store 拿快照）：

```ts
export function worktreeLabel(path: string | null): string
// 命中快照 → `${record.branch}`；否则 basename(path)
```

调用点（4 处，全部替换 `basename(...)`）：`Rail.tsx:1094`（行副标题）、`ProfileView.tsx:162`、`TaskPickers.tsx:190`、`Composer.tsx` 的 chip 主按钮文字。**`Rail.tsx:185 folderKeyOf` / `:390` / `:438` 不改**——分组键与搜索必须用原值路径（按原值分组是已拍板口径）。

---

## 2. 状态机

### 2.1 `state` 的判定（主进程唯一计算，渲染层不做任何推断）

**输入**：`record`、`dirExists`、`git worktree list --porcelain` 的解析结果（一次调用覆盖全部记录）、每个 worktree 的 `rev-parse --abbrev-ref HEAD`。

**判定顺序（短路，先命中的生效）**：

```
1. dirExists === false && gitEntry?.prunable === true        → 'prunable'
2. dirExists === false                                       → 'dir-missing'
3. dirExists === true && gitEntry === undefined              → 'dir-missing'
4. dirExists === true && (headBranch === null || headBranch !== record.branch)
                                                             → 'branch-mismatch'
5. 其余                                                      → 'ok'
```

| state | 判据 | 用户看到什么 | 允许的操作 |
|---|---|---|---|
| `ok` | 目录在 + 登记在 + 分支吻合 | 「工作区正常」 | 合并 / 删除 / 打开终端 |
| `branch-mismatch` | 目录在 + 登记在 + HEAD 不是 `record.branch`（含 detached） | 「工作区已被切到 `<实际分支>`，不再是 `<branch>`」 | 先切回 / 删除；**合并禁用**（C2 必失败） |
| `dir-missing` | 目录不在，或目录在但 git 登记已丢 | 「工作区目录已缺失」（A32） | **重建**（`worktree add` 到原路径）/ 打开文件管理器确认 / 删除记录 |
| `prunable` | 目录不在 + git 明确标记 `prunable` | 「工作区目录已缺失，git 登记可清理」 | 同 `dir-missing`，另给「清理登记（prune）」（A33：必须用户点） |

**逐条理由**：
- 第 1 条排最前：`prunable` 是 git 给出的确定信号，比我们自己判「目录不在」更强，两者同时成立时按更强的那个展示，用户才能看到「清理登记」这个出口。
- 第 3 条归入 `dir-missing`：目录在但登记没了（被外部 prune），对用户就是「工作区不可用」，出口也一致（重新登记或删除记录）。**不为它新造第五种状态**——状态种类越多，渲染层的分支越容易漏。
- 第 4 条要求 `headBranch !== null` 也算 mismatch：detached 时 `rev-parse --abbrev-ref HEAD` 返回字面量 `HEAD`，此时**不能**把它当成「分支名叫 HEAD」而放过。

**未管理的登记项不进 `state`**：`git worktree list` 里有、`worktrees.json` 里没有的路径（用户自己 `git worktree add` 建的，或记录被删），进快照的 `unmanaged: []` 数组，只读展示，**不参与本功能的任何操作**（不自动纳管、不自动删）。这样 4 个状态的语义保持干净。

### 2.2 `deps` 的五种状态与转移

| 值 | 含义 |
|---|---|
| `pending` | 刚创建，尚未决定是否安装 |
| `installing` | 正在安装 |
| `ready` | 安装成功（退出码 0） |
| `failed` | 安装失败（非零退出 / 超时 / spawn 失败 / 被重启打断） |
| `skipped` | 不需要安装（无 lockfile，或用户勾了「不安装依赖」） |

转移（**只允许这些**）：

```
pending ──检测到 lockfile 且用户未勾跳过──▶ installing
pending ──无 lockfile 或用户勾了跳过──────▶ skipped
installing ──退出码 0──────────────────▶ ready
installing ──非零 / 超时 / spawn 错误──▶ failed（写 depsDetail）
installing ──应用退出（进程内状态丢失）──▶ failed（depsDetail = 'aborted-by-restart'，由启动清扫写入，§2.4）
failed ──用户点「重试安装」──────────▶ installing
ready ──用户点「重新安装」───────────▶ installing
skipped ──用户点「安装依赖」──────────▶ installing
```

**禁止的转移**：`ready → skipped`（安装过就不能装作没装）。任何状态下 `deps` 都不得变成 `pending`。

**为什么必须有 `skipped` 这个终态而不是留空**：A36 的边界说明要写「依赖未安装」，删除 worktree 时要判断「是否有 install 在跑」，两处都需要一个明确值而不是 `undefined`。

### 2.3 创建流程的状态序列

```
[Step 0 探测，无副作用]
  ├─ 失败 → 整体失败，无任何写入（分支/目录/记录都不存在）
  └─ 需 dirty 确认 → 返回 needs-confirm，UI 弹提示，用户取消则不产生任何副作用（A19）
[Step 1 写意图]  record{ phase:'creating', intent:{...}, deps:'pending' } 落盘
  └─ 落盘失败 → 整体失败，无其他写入
[Step 2 git worktree add]  失败 → 清理（§3.4）→ 整体失败
[Step 3 校验 + 定稿]  HEAD === baseSha && 分支 === record.branch
  └─ 失败 → 清理 → 整体失败（不得假成功，A28）
  └─ 成功 → record{ phase:'active' } 落盘；落盘失败 → 清理 → 整体失败
[Step 4 依赖安装]  异步，失败只降级（deps:'failed'），不回滚（A27）
[Step 5 会话建档]  createSession(focusRoot=path) + refreshSessions
  └─ 失败 → **不清理 worktree**（它已是可用资产），报错并允许重试建档
```

### 2.4 启动清扫（崩溃恢复）

主进程启动、注册 worktree IPC **之前**执行一次（同步，不阻塞窗口显示）：

1. 读 `worktrees.json`。解析失败 → 整份视为空（不要删文件，留待人工），记一条 `console.warn`。
2. 对所有 `phase === 'creating'` 的记录：按 §3.4 的清理算法清理（此时 `intent` 是判定「本次新建」的唯一凭据）。**清理成功或部分成功都删掉记录**；清理抛错则保留记录并记 warn，下次启动再试。
3. 对所有 `deps === 'installing'` 的记录：改 `failed`，`depsDetail = 'aborted-by-restart'`，落盘。
4. **不做**任何 `git worktree prune`（A33）。`prunable` 只标记给用户看。

### 2.5 「无关联会话」不是第五种 state（回答原型面 3）

原型把「无关联会话」画成与 `目录已缺失` 并列的一个 badge。**定稿：它是独立字段，不是 `state` 的第五个值。**

理由：`state` 描述的是「这个工作区还能不能用」（目录 × 登记 × 分支归属），而「无关联会话」描述的是「有没有会话挂在这儿」。二者正交——一个 `ok` 的工作区完全可以没有会话（用户删了会话但保留工作区，这是 §2.2 明确允许的），一个 `dir-missing` 的工作区也可能仍有会话（用户删了目录但会话还在）。塞进同一个枚举会出现「`ok` 还是 `no-session`？」这种无法表达的组合。

**落地**：
- `WorktreeView.sessionCount`（已有字段）为 0 时，界面显示 `cf.wt.noSession`（「无关联会话」）badge，与 `state` badge **并列**、互不覆盖。
- 原型那一行同时挂了 `目录已缺失` + `无关联会话` 两个 badge —— 这正是本设计支持的形态（`state` badge 来自 `state`，`无关联会话` badge 来自 `sessionCount === 0`）。
- **`sessionCount` 只统计主会话**（`!s.parentId && s.focusRoot === path`），与左栏列表口径一致（`store/chat.tsx:1078`）。成员会话不计入——成员跟随主会话的根，统计进去会让「删了主会话、成员还在」时显示成「还有 1 个会话」，误导用户。

### 2.6 删除按钮的三种语义（回答原型待定 ③）

原型指出「移除登记」与「删除工作区」是不同操作。**定稿：按 `state` 分派，措辞与后果都不同**：

| `state` | 按钮文案 | 行为 | 删掉什么 |
|---|---|---|---|
| `ok` / `branch-mismatch` | **删除工作区** | `git worktree remove` + 删目录 | 目录（含其中一切）。**分支默认保留**（§2.2）。必须二次确认，确认框列出：目录路径、关联会话数、未提交改动数、分支名（并说明分支会保留） |
| `dir-missing` / `prunable` | **移除登记** | `git worktree prune` | **不删任何文件**（目录本来就不存在），只清 git 登记与本地记录 |

**「有未提交改动时拒绝删除」（B2）的拒绝态**（原型没画，定稿补齐）：不是静默禁用按钮，而是点击后弹出明确拒绝：

```
这个工作区还有 3 个未提交改动，不能删除。
  要保留它们：在终端里打开该目录，提交或 stash 后再删。
  要放弃它们：勾选下面的确认项。
[ ] 我知道这些改动会永久丢失
                              [取消]  [删除工作区]（勾选后才可点）
```

**为什么不在按钮上直接禁用**：禁用的按钮无法解释原因，用户会以为功能坏了或者权限不够。弹出拒绝 + 给出两条出路，才是「静默错误必须显式处理」的落法。这与 §3.1 Step 0.9 的 dirty 提示不同——那里 dirty 是常态、只提示不拦截；这里删除会**真的毁掉数据**，必须拦截。

**`deps === 'installing'` 时**（R8）：直接拒绝，文案「正在安装依赖，等它结束或失败后再删」。不给二次确认选项——install 进行中删除在 Windows 上会 `EPERM` 并留下删不干净的目录，这不是用户的意愿问题，是技术上做不到。

---

## 3. 创建流程（逐步可执行）

### 3.1 Step 0 · 探测（`worktree:create-precheck`，无副作用）

在 `repoRoot` 下依次执行，任一失败即返回结构化错误，**不产生任何写入**：

| # | 命令 / 判断 | 失败返回 | 对应断言 |
|---|---|---|---|
| 0.1 | `git rev-parse --show-toplevel` | `not-a-repo`（A24：入口禁用 + tooltip） | A24 |
| 0.2 | `git rev-parse --abbrev-ref HEAD` → 结果为字面量 `HEAD` 时走 detached 分支 | **不失败**，见下方「主目录 detached」 | A8 |
| 0.3 | 非 detached：`targetBranch = 该分支名`；detached：`targetBranch = null` | — | — |
| 0.4 | `git rev-parse <baseRef>^{commit}` → 必须为 40 位 hex；`baseRef` 缺省时用 `rev-parse HEAD`（**不是**分支名，detached 下正好正确） | `bad-base` | A5 |
| 0.5 | `git check-ref-format --branch <branch>` 退出码 0 | `bad-branch` | B3 |
| 0.6 | `git rev-parse --verify --quiet refs/heads/<branch>` → **成功 = 已存在** | `branch-exists`（A23：不得静默复用）+ 可用替代（§6.3 自动后缀） | A23 |
| 0.7 | `existsSync(path)` | `path-exists`（A22：不得覆盖不得删） | A22 |
| 0.8 | `normalizeWorktreePath(path).path.length < 180`，且路径在仓库外（§6.1），且在 worktree 根内（见 `notes/implemented/2026-11-23-worktree-root-custom.md`） | `path-too-long`（A46）/ `path-inside-repo` / `path-outside-root` | A46 |
| 0.9 | `git status --porcelain` in 主目录 → 行数 `dirtyCount` | `dirtyCount > 0 && !req.confirmedDirty` → `needs-confirm`（A17/A18） | A17-A21 |
| 0.10 | `findRecordByRepo(repoRoot).length >= 5` | 返回 `softWarn: 'many-worktrees'`，**不阻断** | — |
| 0.11 | `trustRoot(repoRoot)`；`trustRoot(dirname(path))` | — | 后续 git/fs IPC 的前提 |

**主目录 detached（0.2/0.3）——定稿：允许创建，但 `targetBranch` 为 null。**

原型面 1 第③屏画了这个状态：`HEAD (detached @ 3f9a2c1)` 可选、可创建。这个处理比「直接拒绝」更好，因为两件事必须分开：

- **起点（baseSha）** 只需要一个提交。detached 的 HEAD 就是一个提交，`rev-parse HEAD` 天然给出 → 创建完全可行。
- **合并目标（targetBranch）** 需要一个分支名。detached 时确实没有。

所以规则是：**允许创建，`targetBranch = null`**，并把后果提前说清：

1. `PrecheckResult` 的 `defaultBase` 在 detached 时返回**提交 SHA**（而非分支名），`defaultBaseLabel = 'HEAD (detached @ <sha7>)'`，`primaryDetached: true`。
2. `PrecheckResult` 增加 `mergeTargetWarning`，UI 必须显示在起点字段下方：
   > 主目录当前不在任何分支上（detached HEAD），所以这个工作区**暂时没有合并目标**。你可以先创建，之后在主目录切到一个分支，再在合并面板里指定目标。
3. 记录里 `targetBranch: null`。**合并流程必须支持 `targetBranch === null`**：此时合并面板不预设目标，而是要求用户从**本地分支**里选一个作为本次合并目标（选择结果**写回记录**，成为新的 `targetBranch`，此后固定）。若用户不选 → 拒绝合并，原因 `target-not-set`。
4. 若创建之后主目录切到了某个分支，**不得自动填充 `targetBranch`**（§1.2「永不跟随」）；用户必须在合并面板里显式选一次。A36 的边界说明在 `targetBranch === null` 时改为「改动需要手动合回你指定的目标分支（尚未指定）」。

**为什么不直接拒绝**：用户很可能正在做的正是「从某个历史提交开一个试验分支」，这是 detached HEAD 的典型用法。拒绝等于把最有并行需求的那类场景挡在门外。而「没有合并目标」是可恢复的、可用文案说清的降级，不是死路。

**与 A8 的关系**：A8 验的是「detached 时仍能成功创建」。本规则让它成立；同时 0.4 用 `rev-parse HEAD` 而**不是** `rev-parse --abbrev-ref HEAD`，因此不会取到那个字面量 `HEAD`（v3 实测坑 2 在此消解）。

**0.7 的严格性**：`existsSync` 为真即拒绝，**不做「目录是空的就复用」的特例**。理由：空目录也可能是用户刚建好准备用的；静默复用会让「我在那个目录里放了东西」变成不可解释的状态。A22 明确要求不得删除既有目录。

### 3.2 Step 1 · 写意图

```ts
upsertRecord({
  schemaVersion: 1, path, repoRoot, repoKey,
  branch, baseSha, baseLabel, targetBranch,
  createdAt: Date.now(),
  phase: 'creating',
  intent: { branchExistedAtStart: false, pathExistedAtStart: false },  // Step 0 已确认，恒为 false
  deps: 'pending'
})
```

`intent` 的两个字段在 Step 0 保证为 `false`（0.6/0.7 拒绝已存在的情形）。**仍然记录**它们，因为它让清理算法不必依赖「Step 0 跑过了」这个隐含前提——崩溃恢复时 Step 0 早已不在内存里。

落盘失败 → 返回 `record-write-failed`，整体失败（此时还没建分支、没建目录，无副作用）。

### 3.3 Step 2 · `git worktree add`

```bash
git -C <repoRoot> worktree add -b <branch> <path> <baseSha>
```

- `cwd = repoRoot`（不是主目录以外的任何目录）。
- 参数顺序固定，**`--` 不适用于此命令**（git 不接受），路径作为独立 argv 传入（与 `git.ts:19-20` 的既有安全约定一致：无 shell、无字符串拼接）。
- **不加 `--force`**（加了会覆盖已存在路径，直接违反 A22）。
- 超时 60 秒（新建工作区只写工作区文件，不复制对象库；60 秒是宽裕上限）。
- **不设 `GIT_OPTIONAL_LOCKS=0`**：`add` 要写 `.git/worktrees/`，关掉可选锁没有必要，且既有 `runGitRaw` 统一设了它（`git.ts:194`）——这里必须确认该设置不会影响 `add` 的写入。**实现方必须实测一次**：若发现 `git.ts` 的 env 影响了 `worktree add`，为该调用单独传 env 覆盖。

失败（非零退出）→ 进入 §3.4 清理 → 返回 `add-failed` + 原始 stderr。

### 3.4 失败清理算法（**重点，必须逐字实现**）

**目标**：不留孤儿分支（A25）、不误删用户已有目录（A22/R9）、不动主检出（A4）。

**准入凭据：`record.intent`。** 只有 `branchExistedAtStart === false` 才允许删分支；只有 `pathExistedAtStart === false` 才允许删目录。这是「本次新建」的唯一判定依据，**不得**用「现在目录里有什么」来替代。

**执行顺序（严格按序，每步失败不阻断下一步，但要记录）**：

1. **解登记**：若 `git worktree list --porcelain` 中存在 `worktree <path>` 条目
   ```
   git -C <repoRoot> worktree remove --force <path>
   ```
   失败（目录已不在会报 `validation failed`）→ 继续下一步。
   *注：`--force` 在这里是必需的，因为第 2 步失败可能留下残破的检出；`remove --force` 只影响这一个 worktree，不触碰其它检出与主目录。*

2. **清残留登记**：第 1 步失败且我们**确认该登记指向本次路径**时
   ```
   git -C <repoRoot> worktree prune
   ```
   **这条 prune 是允许的**，理由必须写进代码注释：A33 禁止的是「用户目录被外部删除后静默 prune 掉登记」——那是**用户资产的登记**；这里 prune 的是**我们刚创建、且已确认属于本次尝试**的登记，且 prune 只会清除「目录已不存在」的登记，不会影响任何活着的 worktree（git 的 prune 语义就是如此）。审查时按这个理由核对，不得扩大到常规路径。

3. **删目录**：仅当 `intent.pathExistedAtStart === false` **且**满足下列任一：
   - 目录已不存在（第 1 步已删掉），或
   - 目录存在且（目录为空 **或** 目录内有 `.git` 文件且首行为 `gitdir: <repoRoot>/.git/worktrees/<name>`）

   满足 → `fs.rmSync(path, { recursive: true, force: true })`（**同步**，清理路径不用异步，避免进程在清理中途退出）。
   **不满足 → 绝对不删**，记 `console.warn` 并保留给用户。这条是防止「并发进程在此路径上刚建了东西」被我们删掉。

4. **删分支**：仅当 `intent.branchExistedAtStart === false` **且** `git rev-parse --verify --quiet refs/heads/<branch>` 成功
   ```
   git -C <repoRoot> branch -D <branch>
   ```
   **必须 `-D`**：`-d` 在「分支未合并」时会拒绝，而失败路径上这个分支正是未合并的。此处删的分支确定由本次创建（准入凭据），`-D` 不造成任何用户资产损失。

5. **删记录**：`removeRecord(path)`。失败只记 warn（记录残留会被下次启动的 `phase:'creating'` 清扫再处理一次）。

6. **返回值**：`{ ok:false, reason, message, cleanup: { worktreeRemoved, dirRemoved, branchRemoved, recordRemoved, warnings: string[] } }`。**清理失败绝对不能掩盖原始的创建失败原因**——`reason`/`message` 描述创建为什么失败，`cleanup.warnings` 描述清理没做干净的部分。

**为什么顺序是「先解登记、再删目录、再删分支」**：git 的分支删除会检查「该分支是否被某个 worktree 检出」，若登记还在会报 `cannot delete branch used by worktree`。所以必须先解登记再删分支。目录删除夹在中间是因为 git 的 `remove` 可能只删了登记、留着目录。

### 3.5 Step 3 · 校验与定稿

```
git -C <path> rev-parse HEAD                  → 必须 === record.baseSha
git -C <path> rev-parse --abbrev-ref HEAD     → 必须 === record.branch
```

任一不符 → **清理 → 整体失败**。这里**不允许**「先成功再修正」（例如强行 reset 到 baseSha）——那是拿用户的钱包赌我们的实现正确。失败即失败，让用户重试。

两条都过 → `record.phase = 'active'`，`upsertRecord`。落盘失败 → 清理 → 整体失败（理由同 §1.2：内存有、磁盘没有的记录会在重启后变成 `unmanaged` 孤儿）。

随后立刻 `publishWorktreeChanged()`（新事件，§7.3）让 worktree 列表刷新。

### 3.6 Step 4 · 依赖安装（异步、可降级）

**检测规则（按顺序，先命中先生效）**：

| 探测到的文件（在 worktree 根） | 命令 | deps 终态 |
|---|---|---|
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | ready / failed |
| `package-lock.json` | `npm ci` | ready / failed |
| `yarn.lock` | `yarn install --immutable`（失败重试一次 `--frozen-lockfile`） | ready / failed |
| `Cargo.toml` / `pom.xml` / `build.gradle*` | **不执行** | `skipped`（`depsDetail: 'unsupported-language'`） |
| 以上都无 | **不执行** | `skipped`（`depsDetail: 'no-lockfile'`） |

**必须有**：`req.skipDeps === true` 时一律 `skipped`，不探测命令是否存在。

**约束**：
- 异步执行，**不阻塞**会话可用（A27）。
- 进度走 `worktree:progress`（§7.3），节流 100ms、换步骤立即发（复用 `importer-ipc.ts:28-71` 的 `throttledSend`，**照抄不改**）。
- 超时 5 分钟；超时杀进程树（对齐 `run_command` 的做法），`depsDetail = 'timeout'`。
- 失败时 `depsDetail` 记**最后 20 行输出**（不是全部：pnpm 的报错能刷几十屏）。
- **失败不回滚 worktree**（A27）。用户可点「重试安装」。
- `installing` 期间禁止删除该 worktree（R8：pnpm 持有大量文件句柄，Windows 上删除会 `EPERM`/`ENOTEMPTY` 并留下删不干净的目录）。

### 3.7 Step 5 · 会话建档

顺序**必须是「先 worktree、后会话」**：会话的 `focusRoot` 必须指向已存在的目录，否则 `trustRoot`（`chat.ts:632-634`）与 `GitWidget` 的 `git:status`（首行 `assertInside`）会立刻报错。

**渲染层必改一处**：`store/chat.tsx:1367-1393 startFresh` 的落盘条件是 `personaId !== undefined`（`:1379`）。选了新 worktree 但没有 personaId 时，会话会保持惰性（不落盘、不进左侧列表），而 worktree 已经建好了 —— 用户看到「建完了，列表里没有」。

**改法**：`startFresh` 新增可选参数 `opts?: { persist?: boolean }`，落盘条件改为：

```ts
if (personaId !== undefined || opts?.persist === true) { /* 现有的 createSession + refreshSessions */ }
```

worktree 流程调用 `startFresh(personaId, worktreePath, model, { persist: true })`。

**会话建档失败**（`createSession` 抛错）→ **不清理 worktree**，返回 `{ ok:false, worktreeCreated:true, reason:'session-create-failed', path }`，UI 提示「工作区已创建，但会话没能建立，可重试」，并给一个「在该工作区新建会话」的重试按钮。理由：worktree 是独立于会话的资产（§1.2），删它等于把已经成功的工作毁掉。

**A29/A30 硬约束**：本流程任何位置**只允许** `publishSessionsChanged()`，**严禁**调用 `invalidateIndex()`（`chat-store.ts:359`）。`invalidateIndex()` 会清 `sessionCache`，导致在跑的那一轮之后所有 `save()` 静默 return（`chat-store.ts:374-376` 的 P0-1 原文）。导入那次就是这么丢数据的。代码审查按 `grep -n 'invalidateIndex\b' main/` 核一次。

---

## 4. 合并流程（`worktree:merge`）

### 4.1 前置：合并的读写位置

**合并是把 source 分支合进 `targetBranch`，而 `targetBranch` 不一定检出在创建时的那个目录里。**（G1）

用户完全可能：在主目录（检出 `my/dev`）建了 worktree A；之后在主目录 `git checkout other`；再在别处检出 `my/dev`。此时合并必须在「当前检出 `my/dev` 的那个目录」执行。

**实现要求**：合并开始前用 `git worktree list --porcelain`（`cwd = repoRoot`）反查，取 `branch refs/heads/<targetBranch>` 对应的 `worktree <path>` 作为 `targetPath`。**不得**硬编码主目录、**不得**使用「创建时记录的源目录」（记录里根本没有这个字段，也不允许加——加了就会跟随变化）。

### 4.2 四项检查的**判据与收集方式**

**先在 C1-C6 之前做一次 C-1「目标分支是否已知」**：`record.targetBranch === null` 时（创建时主目录 detached，且用户还没指定），合并**不做任何检查、不执行 merge**，直接返回

```ts
{ ok: false, mergeAttempted: false, checks: [], reason: 'target-not-set',
  targetBranch: null, sourceBranch: record.branch,
  message: '' /* 由渲染层按 i18n 拼 */ }
```

渲染层的处理是：合并面板顶部出现**目标分支选择器**（候选 = 本地分支，不含远端——远端分支没被检出，无法作为 merge 的 cwd），用户选一个 → `worktree:set-target`（§7.1）写回记录 → 重新走合并。**不得**自动挑一个（如 `main`）当目标。

**四项必须全部执行并全部回报，不得短路。** 这是与界面原型的硬契约（`design/worktree-parallel.html` 面 4 失败态）：用户一次就要看到「要清几处」，只报第一个会导致「清完一处、再点、又冒一处」。

因此 `worktree:merge` 的检查阶段**没有「立即返回」**，只有「收集结论」。唯一的例外是 **C0**：source 目录不存在时，C1/C2/C3 都无法执行（cwd 不存在），此时 C1-C3 记 `skipped`（原因 `source-missing`），C4-C6 照常执行（它们只需要 `repoRoot`）。这样即使 source 没了，用户仍能看到 target 侧的状态。

| 序 | 检查 | 具体命令（cwd 见右） | 通过条件 | 失败 reason | 依赖 |
|---|---|---|---|---|---|
| **C0** | source 目录与登记有效 | `existsSync(record.path)`；`git worktree list --porcelain` 里有该条目的 `worktree <path>` | 两者都成立 | `source-missing` | — |
| **C1** | source 的**未提交改动被明确告知**（不阻断） | `git -C <sourcePath> status --porcelain -z` → 计数 | **恒为通过**（`status: 'ok'`），但 `detail` 必须带 `dirtyCount` 与 `dirtyPaths` | 永不失败；`dirtyCount > 0` 时 UI 显示警告徽标（**§4.9**） | C0 |
| **C2** | source 仍在自己的分支 | `git -C <sourcePath> rev-parse --abbrev-ref HEAD` | 等于 `record.branch`，且**不是**字面量 `HEAD` | `source-branch-changed` + `actualBranch`（**A40**，G2） | C0 |
| **C3** | source 无进行中的 git 操作 | 见下方「进行中操作的判据」，cwd = `sourcePath` | 全部不存在 | `source-busy` + `busyOp` | C0 |
| **C4** | target 分支能找到**唯一**检出 | `git -C <repoRoot> worktree list --porcelain` → 筛 `branch refs/heads/<targetBranch>` | 恰好 1 条 | `target-not-checked-out` + `primaryBranch`（**A41**，G1） | 仅需 repoRoot |
| **C5** | target 脏改动**不会**被本次合并覆盖 | 见 §4.9 的**路径交集算法** | 交集为空（`overlapPaths.length === 0`） | `target-overlap` + 交集路径清单（**A90**）；非空但用户已选「先存起来再合并」→ 通过 | C4 |
| **C6** | target 无进行中的 git 操作 | 同 C3，cwd = `targetPath` | 全部不存在 | `target-busy` + `busyOp` | C4 |

**「进行中操作」的判据（C3/C6 共用同一函数）**：

```
git -C <dir> rev-parse -q --verify MERGE_HEAD          → merge
git -C <dir> rev-parse -q --verify CHERRY_PICK_HEAD    → cherry-pick
git -C <dir> rev-parse -q --verify REVERT_HEAD         → revert
existsSync(git -C <dir> rev-parse --git-path rebase-merge)  → rebase
existsSync(git -C <dir> rev-parse --git-path rebase-apply)  → am / rebase
```

- `-q` 必须有：不带它时失败会往 stderr 写 `fatal: Needed a single revision`，污染面向用户的 `message`。
- **不查 `refs/stash`**：stash 不影响 merge。
- `--git-path` 返回的是**相对 cwd** 的路径，必须 `resolve(dir, 结果)` 再 `existsSync`。worktree 里 `.git` 是文件不是目录，所以不能直接拼 `<dir>/.git/rebase-merge`。

**C1/C5 的计数**：`status --porcelain -z` 按 `\0` 分割计数，**未跟踪文件也算脏**（`??`）。理由：merge 遇到被跟踪但未提交的改动、或未跟踪的冲突文件，都会中止（§4.9 实测）。数字必须回给 UI（A17/A90 都要真实数字，不允许「约 20」）。

**C1 为什么不再阻断（本次改动的核心）**：`git merge` **只合并已提交的内容**，source 的未提交改动本来就不会进入合并。所以「source 脏」的真问题不是「会合错东西」，而是「**用户以为改了但没合过去**」。

- 早先的规格把 C1 写成硬拦，等于对用户说「你必须先提交」——而 `E:\deva` 这类长期带改动开发的仓库里，这一步会让合并变成「先提交一堆无关 WIP」的折磨，用户于是绕过工具、直接去终端（那就更没保护了）。
- 定稿：**C1 恒通过，但必须把 `dirtyCount` / `dirtyPaths` 摆在用户眼前**（A38 改写为告警断言）。这是「明确告知」而非「静默放行」——两者区别就在是否真的显示了。

**C5 为什么改成「路径交集」而不是「输出为空」（本次改动的核心之二）**：见 §4.9。

**C6 必须查 `MERGE_HEAD`**：上一次合并冲突没中止时 target 处于合并中，再 merge 会得到 `fatal: You have not concluded your merge`。但那是事后报错，用户看不出「上一次还挂着」。先查出来直接说「上次合并还没收尾，请先中止或继续」。

**C4 找不到检出时给出的 `primaryBranch`**：用于界面写「主目录已切到 `my/hotfix`」。取主检出的 `rev-parse --abbrev-ref HEAD`，detached 时为 `HEAD`，UI 显示成 `HEAD (detached @ <sha>)`（与 §7.6 的起点显示同一规则）。

### 4.3 冻结 SHA 与窗口处理（P2）

**在 C2 通过之后立刻**取冻结 SHA：

```
frozenSha = (git -C <sourcePath> rev-parse HEAD).trim()   // 必须 40 位 hex
```

（C1 不再要求 source 干净，所以 `frozenSha` 仍取 HEAD——**它只包含已提交内容**，source 的未提交改动不会进入合并。这一点必须在 UI 上明说，见 §4.9.4。）

**执行 merge 用 `frozenSha`，不用分支名。** 这样「检查完 → 执行 merge」之间的窗口被消除：agent 在这几十毫秒里若又提交，合的仍是用户刚才看到的那一刻。

**窗口的另一半必须显式报告**：merge 成功后立刻

```
afterSha = (git -C <sourcePath> rev-parse HEAD).trim()
```

若 `afterSha !== frozenSha` → 成功结果里追加 `pendingSha: afterSha` 与 `pendingCount`（`git -C <targetPath> rev-list --count <frozenSha>..<targetBranch>` 之后的 `afterSha` 与 target 之间的提交数，用 `git -C <sourcePath> rev-list --count <frozenSha>..<afterSha>`），UI 提示「合并成功；但期间该工作区又有 N 个新提交尚未合并，可再次合并」。**不自动重试**（用户可能正想先改点东西）。

### 4.4 执行 merge

```
git -C <targetPath> merge --no-ff --no-edit <frozenSha>
```

- `--no-ff` 是硬要求（v3 拍板 3）：即使可以快进也造一个合并提交，让「这次合并」在历史里可见、可 revert。
- **必须加 `--no-edit`**：与既有 `git:merge`（`git.ts:821` 用了 `--no-edit`）一致，并彻底杜绝编辑器挂起（挂起会吃掉 60 秒超时才报错，用户看到「合并超时」而实际什么都没发生）。
- 超时 60 秒。超时意味着几乎可以确定撞上了 git 的交互式提示，杀掉比等更好。
- 环境沿用 `git.ts:194` 的 `GIT_TERMINAL_PROMPT=0`，保证不会在 stdin 挂起。
- **参数用 `frozenSha` 而不是分支名**（§4.3）。但**提示文案里必须写分支名**（`deva/req-worktree-ui`），SHA 只在详情里给——用户认分支名，不认 SHA。

**「已经是最新」必须单独识别**：若 `frozenSha` 已是 target 的祖先（`git -C <targetPath> merge-base --is-ancestor <frozenSha> HEAD` 退出码 0），则不会产生合并提交。这种情况**不要执行 merge**（执行了也只是打印 `Already up to date.`，但会让我们少一次写入），直接返回

```ts
{ ok: true, upToDate: true, targetPath, targetBranch, sourceSha: frozenSha, mergeCommit: null, gitOutput: '' }
```

**不能让 UI 显示「已合并」却查不到合并提交**（A37 会因此误判）。`upToDate` 为真时 UI 文案是「目标分支已包含该工作区的全部提交，无需合并」，且**不显示合并 SHA**。

### 4.5 成功返回（含原型要求的 git 原文）

原型「设计裁定」④ 记了「合并成功后要不要显示结果」为待定。**定稿：给，且给原文。** 理由：A37 要验「多了一个两条父提交的合并提交」，界面上必须能看到那个提交 SHA；否则用户只能「相信」合并成功了。这与 §4.6「冲突给原文」是同一条原则——结果的可核验性。

```ts
{
  ok: true
  upToDate: boolean
  targetPath: string
  targetBranch: string
  sourceBranch: string       // 展示用（界面写「deva/req-worktree-ui → my/dev」）
  sourceSha: string          // frozenSha
  mergeCommit: string | null // merge 后 git -C <targetPath> rev-parse HEAD；upToDate 时为 null
  /** git merge 的 stdout + stderr 原样（如 `Merge made by the 'ort' strategy.` 与文件统计） */
  gitOutput: string
  behindNote?: { pendingSha: string; pendingCount: number }  // §4.3 窗口
}
```

**成功面板必须显示**：`已合并到 <targetBranch>` + `mergeCommit` 短 SHA（7 位）+ 可展开的 `gitOutput` 原文。`upToDate` 时改为「无需合并」，不显示 SHA 与原文。

### 4.6 失败返回（**原始输出必须原样带上，且四项检查全部列出**）

```ts
{
  ok: false
  /** 合并是否被执行过。false = 卡在检查阶段，target 未被触碰。 */
  mergeAttempted: boolean
  /** 检查阶段的结果：**零或四项，顺序固定 C1, C2, C4, C5**（见 §4.2 / §7.2）。执行了 merge 时也要给。 */
  checks: MergeCheck[]
  /** 汇总用的主因：取 checks 里第一个 not-ok 的 id；checks 全过而仍失败时是 conflict / merge-failed */
  reason:
    | 'target-not-set'
    | 'source-missing' | 'source-branch-changed' | 'source-busy'
    | 'target-not-checked-out' | 'target-overlap' | 'target-busy'
    | 'conflict' | 'merge-failed'
  message: string            // 见下
  /** conflict / merge-failed 时必给：git 的 stdout+stderr 原样 */
  gitOutput?: string
  /** C4 之后才有；UI 用它做「在中止合并 / 打开终端 / 打开目录」的目标 */
  targetPath?: string
  targetBranch: string | null
  sourceBranch: string
  /** 已冻结时给出，供「复制 git 命令」与手工执行 */
  sourceSha?: string
}

/** 单项检查结果 MergeCheck：**唯一定义在 §7.2**，此处不重复。 */
```

**`checks` 必须是四项**（对应原型四个圆点）：`C1`（source 的未提交改动，**恒通过、脏时 `status:'warn'`**）、`C2`（source 在本分支）、`C4`（target 分支仍在原处）、`C5`（脏改动与合并路径无交集）。`C3`/`C6`（进行中操作）不占独立圆点，它们的失败并入 `C1`/`C5` 项的 `reason: 'busy'`（`busy` 优先于 `dirty` 展示，因为「上次合并没收尾」比「有 3 个改动」更根本）。

> **给实现方的硬约束**：`checks` 的顺序固定为 `C1, C2, C4, C5`、项数固定为 4。界面按数组顺序渲染四个圆点，不按 `status` 过滤。**不得**在第一个 `bad` 处 `return`。

**`message` 的规则**：
- 检查阶段失败（C-1/C0~C6）→ **不拼中文**，返回空串。由渲染层按 `checks[].reason` + `detail` 从 i18n 取（§7.4）。主进程只提供结构化事实，文案统一在渲染层，才不会有中英各拼一套、漏翻一半的问题。
- `conflict` / `merge-failed` → **`${stdout}\n${stderr}` 原样拼接**（对齐 `git.ts:824` 的既有做法），同时放 `gitOutput`。用户要的是 `CONFLICT (content): Merge conflict in src/xxx.ts` 这一行，不是「合并失败」——**这是本需求里唯一不能本地化的字符串**。
- `reason` 用 `classifyRemoteError`（`git.ts:474-487`）分类后落 `conflict` / `dirty` / `error`，我们再把 `error` 细分成 `merge-failed`。**直接复用该函数，不另写一套正则**（两套判定必然漂移）。

### 4.7 失败后的出口（**必须全部提供**，A42/A43）

四个出口**平权**（原型设计裁定 ⑥）：都不是 primary，尺寸一致（`--sm`）。把「中止合并」做成 primary 会诱导用户放弃已经做的工作。

| 出口 | 实现 | 说明 |
|---|---|---|
| **中止合并** | 复用 `git:merge-abort`（`git.ts:829`） | 现有通道只收 `dir`，**直接传 `targetPath` 即可，主进程无需改动**——它内部就是 `git merge --abort`。渲染层**必须传 `targetPath`，不能传当前会话的 focusRoot**：合并发生在 target 检出目录，不是用户此刻正在看的那个工作区。传错的表现是「点了中止没反应，冲突还在」，静默无报错。 |
| **在终端打开** | `terminal:create({ cwd: targetPath, ... })`（`terminal.ts:91`） | 用户在终端里解冲突、`git add` + `git merge --continue` |
| **在文件管理器打开** | `fs:reveal-folder(targetPath)`（`workspace.ts:55-61`） | 需 `targetPath` 在受信根内 → C4 之后**必须 `trustRoot(targetPath)`**。创建流程已 `trustRoot(repoRoot)`，但 targetPath 可能是另一个 worktree，不 trustRoot 会返回 `{ ok: false }`（不抛错，静默失败）。 |
| **复制命令** | 纯前端拼串 | 见下 |

**「复制命令」的确切内容**（原型专门画了剪贴板内容，必须一致）：

```
cd /d "<targetPath>" && git merge --no-ff <branch>
```

三条硬要求：
1. **必须带 `cd`**。不带目录的裸命令，用户还得自己找在哪个目录执行——而合并发生在 **target 检出目录**，这恰恰是最容易搞混的一点（用户会以为在自己会话的 worktree 里）。
2. **Windows 用 `cd /d`**（跨盘符必需），其它平台用 `cd`。按 `window.deva.platform` 分支。
3. **用分支名而不是 SHA**。这里与执行路径相反，是刻意的：用户手工执行时，分支名可读、可复制、可在 shell 里补全；而 SHA 是给程序用的。副作用是手工执行可能合到比界面所示更新的提交——**这是用户自己动手时的合理预期**，不需要替他冻结。

**冲突时的备选命令**（同一按钮的第二行，或冲突面板里换成）：
```
cd /d "<targetPath>" && git merge --abort
```

**明确禁止**（违反即验收不通过）：
- 自动 `git merge --abort`
- 任何形式的 `git reset --hard` / `git checkout -- .`
- 自动删除 source 分支或 worktree
- 自动改 target 检出的任何文件
- 自动 `git stash`（无论 source 还是 target）

**成功路径同样不得清理 source**：合并成功后 source 分支与 worktree 必须保持原样（A37/A43）。是否回收由用户显式操作（§2.6 的删除流程）。

### 4.8 合并成功后显示什么（回答原型待定 ④）

**定稿：显示，且给 git 原文。** 只有一句「已合并」不够——用户会想确认「真的合进去了吗」，而 A37 要验的正是「多了一个两条父提交的合并提交」，界面上必须能看到那个提交 SHA 才能核验。

面板内容（顺序固定）：

```
✓ 已合并到 my/dev
  合并提交 3f9a2c1
  [可展开] git 的输出（原样）
```

- `upToDate: true` 时不显示合并提交与原文，改为「目标分支已包含该工作区的全部提交，无需合并」。
- `behindNote` 存在时追加一行：「期间该工作区又有 3 个新提交尚未合并，可再次合并」+ 一个「再次合并」按钮。
- **不自动关闭面板**：用户可能要读原文或点「再次合并」。

---

### 4.9 脏工作区合并策略（C5 的依据）

#### 4.9.0 一句话

**git 按「文件路径」粒度拦合并，不按 hunk。** 所以问题不是「改动会不会和合并内容撞语义」，而是「**哪些文件同时出现在『工作区脏』和『这次合并要改』两个集合里**」。C5 就是算这个交集：为空则放行，非空则让用户显式选「先存起来再合并」，全程不做任何静默动作。

#### 4.9.1 六条硬事实（全部在本机 git 2.55.0.windows.5 实测）

| # | 事实 | 实测证据 |
|---|---|---|
| **F1** | **git 按路径粒度拦，不按 hunk。** 同一文件、不同行也会被拦 | `f.txt` 3 行，工作区改第 1 行、feat 改第 3 行 → `error: Your local changes to the following files would be overwritten by merge: f.txt`。源码依据：`merge-ort.c` 的检出走 `unpack_trees()`，粒度是路径 |
| **F2** | **只有完全不同文件才放行** | 工作区改 `shared.txt`、feat 改 `both.txt` → 合并成功，`shared.txt` 的脏改动原样保留 |
| **F3** | **untracked 撞路径也会被拦**，且是**另一条**报错 | `error: The following untracked working tree files would be overwritten by merge:` + `Please move or remove them before you merge.` |
| **F4** | **staged 改动也会被拦**（不只 unstaged） | `git merge` 的 `PRE-MERGE CHECKS` 要求 index 与 HEAD 一致；实测 staged 一个与合并无关的文件仍被拦 |
| **F5** | **退出码不唯一**：ff 场景退 **1**、non-ff 场景退 **2**；两者 stderr 都含 `would be overwritten` | ff: `exit=1`（stdout 有 `Updating a..b`）；non-ff: `exit=2` + 尾部 `Merge with strategy ort failed.` |
| **F6** | **报错缩进格式不统一**：unstaged 用 `\t`、staged 用两个空格；`advice.commitBeforeMerge=false` 时提示行变空行 | `od -c` 实测：`:` `\n` `\t` `f.txt`（unstaged）vs `:` `\n` ` ` ` ` `other.txt`（staged） |

**F5/F6 的直接后果**：**解析 git 的 stderr 不能写死格式**，也不能只看退出码。

#### 4.9.2 为什么不用 `git merge --autostash`（**明确禁止**）

**定稿：禁止使用 `git merge --autostash`，任何情况下都不用。**

实测（本机 git 2.55.0）最致命的一格：

```
$ git merge --autostash --no-ff --no-edit feat
Created autostash: ab88057
Merge made by the 'ort' strategy.
Your local changes are stashed, however applying them
resulted in conflicts.  You can either resolve the conflicts
and then discard the stash with "git stash drop", or ...
$ echo $?
0                       ← 退出码 0
$ git status --porcelain
UU a.txt                ← 工作区是冲突态
$ git rev-parse -q --verify MERGE_HEAD
(空)                    ← 合并头不存在
$ git stash list
stash@{0}: autostash
```

**退出码 0 + 工作区冲突 + `MERGE_HEAD` 不存在 + 改动躺在 stash 里。** 只看退出码必然误判成「合并成功、工作区干净」——这正是本项目一直在修的那类静默错误（`ok === true` 但状态是坏的）。

另外三条实测/文档确认的问题，各自都足以否决它：

| 问题 | 实测/出处 |
|---|---|
| **合并本身冲突时，git 提示 `git stash pop` 但 pop 拿不到东西** | 实测：`When finished, apply stashed changes with 'git stash pop'`，但此时 `refs/stash` 不存在（autostash 钉在 `MERGE_AUTOSTASH` 上），`git stash pop` → `No stash entries found.`；`git stash apply <MERGE_AUTOSTASH>` → `error: could not write index`（因为 index 有 unmerged）。**唯一出路是 `merge --abort`** |
| **不管 untracked** | `git stash create` 不带 `-u`。实测：untracked 撞路径时 autostash 仍被创建又立刻 pop 回来，退出码 1，untracked 问题原样留着 |
| **丢 staged 状态** | pop 不带 `--index`。上游 `git stash apply --index` 在冲突时会 `error: conflicts in index. Try without --index.` **什么都不恢复** |
| **版本红线** | `merge --autostash` 是 **2.27** 才有；**2.33 的 RelNotes 明文修过「autostash 失败时丢改动」的 bug**。即便要用也得 ≥2.33 |

**而且它解决的不是我们的问题**：autostash 是「无脑 stash 然后试」，覆盖了用户根本不知道发生的几十次操作；我们要的是「**先算清哪几个文件会被拦 → 告诉用户 → 用户选**」。前者是黑箱，后者是可解释。

#### 4.9.3 C5 的路径交集算法（确定性，不依赖 git 内部行为）

**核心：不用 `git merge-tree` 预测，直接算两个路径集的交集。**

理由是实测出来的——调研推荐的「三树预测」在**ff 场景失效**：

```
# ff 场景（master 无新提交、feat 领先 1 个）
$ git merge-tree --write-tree --name-only master feat
6e4fac94e439e3cb44c76bde2139baccd7c557d5       ← 只有树 OID，没有路径名！
$ git diff --name-only master feat
f.txt                                            ← 真实要改的路径
# 而真实 git merge 会被拦（exit 1）
```

`merge-tree --name-only` 在 ff 场景算出的树就是 feat 的树，**没有「变更差异」可报**，于是不输出路径；而真实 `git merge` 走 `unpack_trees()` 按路径检查工作区，照样拦。另外调研给的公式在本机 git 2.55 上直接报错（`expected commit type, but the object dereferences to tree type`）——**树 OID 不能当 commit 传给 merge-tree**。这条路彻底放弃。

**定稿算法（三步，全部是确定性命令）**：

```
① 脏路径集 D（target 检出）
   git -C <targetPath> status --porcelain -z
   解析：XY 码 + 路径。XX/?? 全算（覆盖 F3/F4 的 staged 与 untracked）
   若 -z 输出含 rename（R），取「新路径」

② 本次合并要改的路径集 M
   git -C <targetPath> diff --name-only -z <mergeBase>..<frozenSha>
   其中 mergeBase = git -C <targetPath> merge-base <targetBranch> <frozenSha>
   ⚠️ 必须是**三点语义**（merge-base..frozenSha），不能用两点 <targetBranch> <frozenSha>
      ——见下方「两点 vs 三点的实测差异」
   同时取 untracked 侧：
   git -C <targetPath> diff --name-only -z --diff-filter=A <mergeBase>..<frozenSha>
   （新增文件要单独拿出来，因为 untracked 冲突只由「合并要新增这个路径」触发，F3）

③ 交集 overlapPaths = D ∩ M
   overlapPaths 为空 → C5 通过
   非空              → C5 报 target-overlap + overlapPaths（完整清单，不只第一个）
```

**「两点 vs 三点」为什么是关键（实测）**：

| 场景 | `diff --name-only master feat`（两点） | `diff --name-only master...feat`（三点） | 真实 merge 拦的 |
|---|---|---|---|
| master 提交改了 `masteronly.txt`，feat 没碰；工作区脏了它 | **`masteronly.txt`（误报！）** | 不列出 | **不拦**（合并成功，脏改动保留） |
| master 改 `shared.txt`、feat 改 `both.txt`，两者都脏 | `shared.txt`、`both.txt`（多报 `shared.txt`） | 只 `both.txt` | 只拦 `both.txt` |

**两点 diff 会把「master 自己改过、feat 没改」的文件也算进「合并要改的路径」**，导致我们去拦一个 git 根本不会拦的合并——用户白被拦一次，还找不到原因（去终端一跑就成功）。所以**必须用 `merge-base..frozenSha` 的三点语义**。

**实测确认三点语义在 ff 与非 ff 都正确**：

| 场景 | 三点 diff 输出 | 真实 merge |
|---|---|---|
| ff（master 落后 feat 一个提交） | `f.txt` | 拦（脏了 f.txt）✅ 一致 |
| non-ff 双改 | `both.txt` | 拦 `both.txt` ✅ 一致 |
| master 独改（feat 没碰） | 不列出 | 不拦 ✅ 一致 |
| 混合（master 改 A、feat 改 B，两者都脏） | 只 `B` | 只拦 `B` ✅ 一致 |

**为什么交集法优于「跑一次 merge 看报错」**：

1. **确定性**：`status`/`diff`/`merge-base` 的输出格式稳定，不受 `advice.*` 配置、git 版本、ff/non-ff 影响。而 stderr 解析要处理 F6 的三种格式 + F5 的两种退出码。
2. **能提前告知**：用户点「合并」之前就知道要清哪几个文件，不用先失败一次。
3. **untracked 覆盖完整**：`status --porcelain -z` 天然包含 `??`。而 stderr 里 untracked 是**另一条**报错（F3），要写两套正则。
4. **不误拦**：三点 diff 精确到「目标分支缺的提交改了哪些路径」，与 `unpack_trees` 的判据一致（实测四格全对）。

**它不做什么（边界要说清）**：交集法**不预测语义冲突**（两边都提交了同一文件的冲突）。那是 `merge` 执行后才知道的事，由 `conflict` 分支处理（§13）。**交集法只回答「脏改动会不会挡住这次合并」**，这正是 C5 要回答的。

#### 4.9.4 用户看到什么（界面契约）

**C5 通过（交集为空）时**：

- 若 `D` 非空（有脏改动但与合并无关）：面板显示一行中性提示：
  > 目标目录有 `<n>` 个未提交改动，本次合并不涉及这些文件，它们会原样保留。
- 用户可直接点「合并」。

**C5 不通过（交集非空）时**：**不直接拦死，而是一个二选一**：

```
以下 3 个文件在目标目录有未提交改动，合并会覆盖它们：
  src/a.ts
  src/b.ts
  docs/c.md

  [ 先存起来再合并 ]   [ 我去终端自己处理 ]   [ 取消 ]
```

- **「先存起来再合并」** → 走 §4.9.5 的显式 stash 流程。
- **「我去终端自己处理」** → 给 `cd "<targetPath>"` 与说明（`git status` / `git commit` / `git stash`），不开终端也行（用户可能已有终端）。
- **「取消」** → 什么都不做。

**C1（source 脏）的界面提示**（恒通过但要显示）：

```
⚠ 该工作区有 2 个未提交改动，它们不会被合并（merge 只合并已提交的内容）。
  [ 在终端查看 ]
```

**这句话是本节存在的理由**：source 脏的真正风险是「用户以为改了但没合过去」。不提示，用户会以为合并完成了全部工作。

#### 4.9.5 「先存起来再合并」：显式 stash 流程（**唯一允许的 stash 用法**）

**不用 `--autostash`，用手工三步，每一步的结果都可核验。**

```
① git -C <targetPath> stash push --include-untracked -m "deva-merge-wip:<mergeId>"
     --include-untracked 必须有：untracked 是常态（F3），不带它就会在 merge 时被拦
   → 记下 stashSha = git -C <targetPath> rev-parse refs/stash
   → 校验：status --porcelain 应为空；非空则中止并恢复（不该发生，但要查）

② git -C <targetPath> merge --no-ff --no-edit <frozenSha>
   → 记 exit code 与 stdout/stderr

③ git -C <targetPath> stash pop <stashSha 或 stash@{0}>
```

**为什么手工三步比 `--autostash` 好（全部实测）**：

| 场景 | `--autostash` | 手工三步（实测） |
|---|---|---|
| 合并成功、pop 无冲突 | `Applied autostash.`，改动回来 | `pop exit=0`，改动回来，**stash 条目自动消失** ✅ |
| 合并成功、pop **有冲突** | **`exit=0`**，改动进 stash，工作区 `UU`，**用户看不出失败** | **`pop exit=1`**，stash **条目保留**，工作区 `UU`，用户明确知道要处理 ✅ 见下方实测定性 |
| 合并本身**冲突**（提交层面） | git 提示 `git stash pop`，但 **refs/stash 不存在，pop 拿不到** | stash **完好保留**（`stash@{0}` 在），用户可 `merge --abort` 后 pop，实测 abort 后 stash 仍在、pop 后改动完整回来 ✅ |
| 合并**失败**（非冲突） | 视版本，行为不一 | stash 仍在（未 pop），用户可自行恢复 ✅ |
| untracked | **不管**（`stash create` 无 `-u`） | `--include-untracked` 覆盖 ✅ |
| staged 状态 | 丢失 | `stash push` / `pop` 默认不带 `--index`，**同样丢 staged 状态**（见下方「已知残余缺陷」） |

**pop 冲突时的实测细节（决定界面怎么写）**：

```
$ git stash pop            → exit 1
stderr: Recorded preimage for 'f.txt'
stdout: Auto-merging f.txt
        CONFLICT (content): Merge conflict in f.txt
        ...
        The stash entry is kept in case you need it again.
$ git status --porcelain
UU f.txt          ← 工作区是 conflicted
?? scratch.txt    ← untracked 也回来了
$ git stash list
stash@{0}: On master: deva-wip     ← 条目保留（这是与 autostash 的关键差别）
```
且实测确认：**此时的用户改动 100% 在文件里**（`grep MY-DIRTY f.txt` 命中），`stash` 里也有完整原版，`scratch.txt` 也在。**没有任何改动丢失**。

**残留的已知缺陷（必须告诉用户，不是隐藏起来）**：

| 缺陷 | 原因 | 处理 |
|---|---|---|
| **staged 状态不恢复**（原本 `git add` 过的会变回 unstaged） | `stash pop` 默认不带 `--index` | **不用 `--index`**：实测上游 `stash apply --index` 在冲突时会 `error: conflicts in index. Try without --index.` 且**什么都不恢复**（比丢 staged 状态更糟）。改为：pop 成功后，比较 stash 里记录的 staged 集合与本文件状态，**在结果面板明确告知**「以下 3 个文件原本处于暂存状态，合并后已取消暂存：…」，让用户自己决定是否重新 `git add` |
| pop 冲突后 stash 条目要用户手工 `stash drop` | git 的既定行为（官方文档明说） | 面板给「冲突解决后点这里丢弃 stash」按钮；**不自动 drop**（万一用户想重来） |

#### 4.9.6 兜底：如果 merge 还是被拦了（防预判漏算）

**预判可能因我们未知的 git 行为而漏（比如未来的新保护机制），所以必须有事后兜底。**

```
git merge 的 exit ≠ 0 时：
1. 若在「显式 stash 流程」中 → stash 必在，直接告知「改动已安全保存，可恢复」
2. 否则按 §4.9.7 的稳健解析取路径清单（**不写死格式**），
   匹配不上则退化为「原始 stderr 原样显示 + 三个出口」
3. 任何情况下都不得报 success
```

#### 4.9.7 解析 git 报错的稳健做法（F5/F6 的直接应对）

**不用「整段文本前缀匹配」，用「锚点 + 宽松提取」**：

```
① 只要 stderr 含 would be overwritten by merge 或
   would be overwritten by merge（untracked 版是 move or remove them）
   就判定为「脏工作区拦合并」

② 提取路径：从匹配到锚点行之后，逐行取「首字符是 \t 或空格 且 trim 后非空
   且不是已知提示句（Please commit / Please move / Aborting / Merge with strategy）」
   → trim 后即为路径
   ⚠️ 不假设缩进是 \t 还是两个空格（F6）
   ⚠️ 不假设路径行在固定行号

③ 若提取结果为空（例如 advice 配置让提示行变空行）→
   不做路径级展示，退回「原始 stderr + 出口」。
   **绝不把「提取为空」当成「没有路径」而放行 merge**
```

**必须遵守的三条**：不写死缩进、不写死行号、不用退出码单独判性质（F5：1 和 2 都可能是脏拦）。

#### 4.9.8 与 §4.2 其他检查的关系

| 检查 | 变化 |
|---|---|
| **C1** | 从「硬拦」改为「恒通过 + 必显警告」 |
| **C5** | 从「`status` 输出为空」改为「路径交集为空（或用户已选 stash 流程）」 |
| **C4 / C6 / C2 / C3** | **不变** |
| **四项圆点的含义** | C1 圆点改为**告警色**（不是红）——它不阻止合并，但要让用户看见 |

**`MergeCheck` 的 `status` 需要一个新值**：现在是 `'ok' | 'bad' | 'skipped'`，**新增 `'warn'`**。C1 在有脏改动时返回 `'warn'`（圆点黄色），无脏改动时 `'ok'`。

#### 4.9.9 与 `--autostash` 的对比（一句话总结，供审查引用）

`--autostash` 把「stash → merge → pop」压成一条命令，代价是**中间态全部不可见、失败信号被吞**（exit 0 但工作区冲突）。手工三步的每一步都有独立退出码与可直接核验的状态（`stash list`、`status`、`MERGE_HEAD`），**代价只是多两次 git 调用**。在「用户的主目录里有 28 个未提交文件」的场景下，可见性比省事重要得多。

---

## 5. Git 锁

### 5.1 接口约定

新模块 `main/services/worktree/lock.ts`：

```ts
/**
 * 按工作目录粒度串行化 git 写操作。
 * paths 会被 normalize + 去重 + 排序；按序获取，全部拿到后才执行 fn；无论成功失败都释放。
 * 禁止嵌套调用（内层会永远拿不到同一把锁 → 死锁）：需要多把锁时一次传全部路径。
 */
export function withGitLock<T>(
  paths: string[],
  label: string,                       // 'create' | 'remove' | 'merge' | 'rebuild' | 'prune' | 'install'
  fn: () => Promise<T>
): Promise<T>

/** 当前某路径上的占用者（供 UI 提示「另一个会话正在提交」）。 */
export function gitLockHolder(path: string): { label: string; since: number } | null
```

**获取算法（必须逐字实现）**：

1. 对每个 path 调 `normalizeWorktreePath`（§6.2），得到 `compareKey`。
2. `Set` 去重。
3. **按码点升序排序**（`a < b ? -1 : 1`，不用 `localeCompare`——locale 会影响比较结果，导致两个进程/两次调用的顺序可能不同）。
4. 依次 `await acquire(key)`：把 `fn` 挂到 `tail.get(key)` 之后（`Map<string, Promise<void>>`），新 tail 是「前一个 Promise resolve 后 resolve 我」。
5. 全部拿到后注册 `holder.set(key, { label, since: Date.now() })`，执行 `fn()`。
6. `finally` 中按**逆序**清除 `holder`。
7. **任何一把锁的等待超过 5 秒，立刻通过 `worktree:progress` 发一条 `{ phase:'waiting-lock', holder }`**，让用户看到「正在等另一个会话的 git 操作完成」而不是界面冻结（B6 的显式提示就靠这个）。

**必须遵守**：
- 不得在持有锁期间 `await` 用户交互（不弹对话框、不等 IPC 回包）。锁内只做 git 调用。
- 不得在 `fn` 内部再调 `withGitLock`。代码审查按 `grep -n 'withGitLock' main/` 核调用点是否嵌套。
- 锁是**进程内**的（`Map` 闭包变量），不落盘、不跨进程。见 §5.4。

### 5.2 哪些操作加锁、加哪几把

| 操作 | 锁路径 | 理由 |
|---|---|---|
| 创建（`worktree:create`） | `[repoRoot, 目标 path]` | 写 `.git/worktrees/<name>`、`refs/heads/<branch>`、目标目录 |
| 删除（`worktree:remove`） | `[repoRoot, record.path]` | 写 `.git/worktrees`、删分支、删目录 |
| 合并（`worktree:merge`） | `[repoRoot, targetPath]` | 写 target 的 index/worktree 与 `refs/heads/<targetBranch>` |
| 重建（`worktree:rebuild`） | `[repoRoot, record.path]` | 解登记 + 重新 add |
| 清理登记（`worktree:prune`） | `[repoRoot, record.path]` | 写 `.git/worktrees` |
| 依赖安装（`install-deps`） | **不加锁** | 不是 git 操作；加锁会让 30 秒的 install 挡住所有 git 操作（创建/合并全排队），性能代价远大于收益 |
| 只读（`worktree:list` / `git:status` / `git:branches` / `git:log`） | **一律不加锁** | 加锁会让列表刷新排在合并后面，界面看起来卡住。只读操作与 git 自身的一致性由 git 的 ref 原子更新保证。 |

**为什么合并锁 `repoRoot` 而不只是 `targetPath`**：合并会更新 `refs/heads/<targetBranch>`，这个 ref 属于仓库共享区。两个不同 source 同时往同一个 target 合并（同一 targetPath）已被 targetPath 锁挡住；但「合并 A→target」与「删除 worktree B（会删 B 的分支、动 .git/worktrees）」并发时都写 `.git/` 共享区。锁 repoRoot 让这类写操作串行，代价是合并与创建/删除不能同时进行——这在真实使用中几乎不会碰到（都是用户手点的低频操作）。

### 5.3 边界（必须写进代码注释，且验收认可）

**本锁只约束 Deva 自己发起的 git IPC。用户在终端里手跑的 git 完全不受约束。**

- Deva 侧：`git.ts` 全部写操作 + 本功能的全部写入 → 同一进程内被这把锁串行化，不会互相踩。
- 用户侧：终端里 `git commit` 与 Deva 的合并并发 → 由 **git 自己的 `.git/index.lock`** 兜底，一方会拿到 `fatal: Unable to create '.../index.lock': File exists`。这条错误会原样透出给用户（见 §4.6 message 规则），**不做重试、不做自动清理**——静默删别人的 `index.lock` 是数据损坏级操作。
- B6 的「能明确提示另一个会话正在提交」**只承诺 Deva 会话之间的**。跨到用户终端时，只能给 git 的原始报错 + §4.7 的终端出口。
- **不跨进程**：若将来开多窗口/多实例，本锁失效，需要跨进程锁（`--git-common-dir` 下的租约文件）。**本次不做**，但模块注释必须写明这个前提，避免后来人误以为它是全局的。

---

## 6. 路径与命名

### 6.1 目录布局

```
<DEVA_HOME>/worktrees.json                                ← 记录文件
<DEVA_HOME>/worktrees/<repoKey>/<slug>-<shortid>/          ← 工作区（就是那个 worktree 目录）
```

> **根可自定义**：上面的 `<DEVA_HOME>/worktrees` 只是**默认根**。用户可在设置里指定 `worktreeRoot`
> （`config.json` 顶层键，缺键即用默认，`DEVA_HOME` 迁移时自动跟随）。创建必须落在根内、删除不删根外目录，
> 以及存量记录的处理，见 **`notes/implemented/2026-11-23-worktree-root-custom.md`**。本节其余内容（repoKey 分桶、
> 仓库外硬约束）不受影响，仍然有效。

- `<DEVA_HOME>` 由 `getDevaHome()`（`config.ts:27`）给出，支持 `DEVA_HOME` 环境变量覆盖 → 用户可整体挪盘，与数据一起备份/迁移。
- `<repoKey>` = `sha1(lower(repoRoot).replace(/\\/g,'/')).slice(0,16)`。**不得复用 `chat-store.ts:245 projectKey`**：那个函数的注释明写它是「权限系统按目录区分权限模式」用的；让两个语义共享一个标识，将来改任一个都会误伤另一个。同算法、另起函数（`worktree/paths.ts: repoKeyOf`）。
- **仓库外**（B5 硬要求）：`.gitignore:20` 已忽略 `.deva/`，若把工作区放在仓库内，B5 的 `git status` 断言会**恒真**、验不出任何东西。`DEVA_HOME` 默认是 `~/.deva-plus`，落在用户主目录，天然在仓库外。**额外的机械校验**（不得只靠「默认值在仓库外」这个约定）：
  ```ts
  const rel = relative(repoRoot, worktreePath)
  if (!rel.startsWith('..') && !isAbsolute(rel)) → 拒绝（path-inside-repo）
  ```
  这条校验放在 Step 0.8 之前的同一处。

### 6.2 归一化与比较（A44 的根据）

**两个不同的概念，不得混用**：

| 概念 | 字段 | 用途 |
|---|---|---|
| `path` | `WorktreeRecord.path` | 展示、`focusRoot` 值、传给 git 的 argv。**保留大小写与原始形式**。 |
| `compareKey` | `WorktreeRecord.compareKey` | 记录的**主键**、锁 key、关联会话反查、去重。 |

`normalizeWorktreePath(p) → { path, compareKey }`（`worktree/paths.ts`）：

1. `path = resolve(expandHome(p))` —— 剥掉 `.` / `..`、补绝对路径、统一分隔符。
   **实测确认（本机 Windows + NTFS，Node 24）**：`realpathSync.native` 对已存在路径会把 `C:/a/b`、`C:\\a\\b`、`C:\a\.\b`、`C:\a\b\..\b`、`C:\a\b\` 全部归一成同一个 `C:\a\b`。所以第 1、2 步对**已存在**的路径天然覆盖斜杠与冗余段。
2. 求真实路径：若存在用 `realpathSync.native`；否则**沿祖先逐级 realpath 后把尾段接回**——复用 `fs-guard.ts:20-37 realResolve` 的既有算法（把它 `export` 出来，零行为变化）。
3. `path` 用于展示，保持 realpath 结果（符号链接解析成真身——这是对的）。
4. `compareKey` 见下方「**完整归一化规则**」。

#### 6.2.1 `compareKey` 的完整归一化规则（逐条，实测支撑）

```
输入：第 2 步得到的 realPath（可能已存在，也可能不存在只剩「祖先 realpath + 尾段原始串」）

R1  分隔符统一：所有 \ 与 / → /                     （斜杠形式不同即同一目录）
R2  折叠冗余：连续 / 折叠为一个                      （// 在 Windows 上是 UNC 前缀，见 R1 注）
R3  去尾部全部 /                                    （最后一段之后的分隔符无语义）
R4  逐段剥离「段尾空格与段尾点」                     ★本次新增，见下
R5  盘符与大小写：win32 / darwin → 全小写             （Linux 保留大小写）
R6  盘符形式统一：win32 → 去掉 `\\?\` 前缀、统一为 `c:/...`
```

**R4 为什么必须加（这是设计成员发现的真实缺口）**：

`realpathSync.native` 只在路径**已存在**时才会给出系统规范化形态。而创建流程里 `compareKey` 最常被用来比较的是**尚不存在**的路径（Step 0 的 0.7/0.8 判重），此时第 2 步走的是「祖先 realpath + 尾段原始串」，尾段的空格和点**原样保留**。若不剥，`"fix "` 与 `"fix"` 得到两个不同 `compareKey`，判定「不冲突」，随后 `git worktree add` 失败。

**实测确认了这条链路（本机 Windows + NTFS + git）**：

| 实测 | 结果 |
|---|---|
| `fs.mkdirSync('<base>/trailspace ')` | **成功**，`readdirSync` 读出 `"trailspace "`（尾部空格被真实保留，并非常识认为的「NTFS 静默剥掉」） |
| `fs.existsSync('<base>/fix ')`（`fix` 目录已存在） | **false** —— 说明 Node 侧不会把 `fix ` 折叠成 `fix` |
| `fs.existsSync('<base>/FIX')` | **true** —— 同一 inode，大小写不敏感成立 |
| `git worktree add -b t1 "../wt-space " HEAD` | **exit 128**：`fatal: could not create leading directories ... Invalid argument` |
| `git worktree add -b t2 "../wt-dot." HEAD` | **exit 128**：`fatal: could not create directory of '.git/worktrees/wt-dot.': Invalid argument` |
| **上述两次失败后** | 分支 `t1`、`t2` **都留在了 `git branch --list` 里**（孤儿分支，见 §3.4 的清理算法） |

结论：**必须同时做两件事**——

1. **`compareKey` 的 R4 剥掉段尾空格与点**，让「带尾部空格的输入」与「干净路径」撞成同一个 key → 判重命中 → 走 `path-exists`（A22）**拒绝并提示**，而不是放进清理流程。
   - **剥规则的精确形态**：对每一段（以 `/` 分隔）反复 `段.replace(/[ .]+$/, '')`，**直到稳定**（`"a . ."` → `"a"`）。空段（中间或末尾）直接丢弃。
   - **这不是「猜测用户想输入什么」**，而是「对齐 Windows 的真实存储语义 + 对齐 git 的拒绝行为」。**`path` 本身不做剥离**（保留用户原文，便于报错时说清「你输入的是哪个」）。
2. **`git worktree add` 的失败清理必须真的执行**（§3.4）。本次实测证明「先建分支再失败」是**必然而非偶然**：两个失败场景都留下了孤儿分支。若清理写成 `branch -d`（未合并会拒绝），孤儿会永留。

**R5 的实测确认**：`git worktree add -b b1 ../WT-Case` 成功创建；随后 `git worktree add -b b2 ../wt-case` 报 `fatal: '../wt-case' already exists` —— **git 侧与文件系统侧都大小写不敏感**，而 `readdirSync` 只回 `"WT-Case"`。所以 `toLowerCase` 是必需的，且 `path` 要保留创建时的大小写形式（重要性：删除/重建时按 `path` 传 argv，用错大小写在 Linux 上会失败，在 Windows 上恰好没事——所以**不能在 `path` 上小写化**）。

**未归一化的后果**（每条都是静默错误）：

| 情形 | 若未处理 |
|---|---|
| `E:\DW` vs `E:\dw` | 同一工作区两个卡片、两把锁、关联会话数各算一半 |
| `E:/deva/wt` vs `E:\deva\wt\` | 删除时删掉一个、另一个还在，`git worktree list` 里留孤儿登记 |
| `"fix "` vs `"fix"` | 判重放行 → `add` 失败 → 若清理误判「本次新建」则**可能删掉用户已有目录**（R9 的真正触发路径） |

`WorktreeRecord` 同时存 `path` 与 `compareKey`；`getRecord/removeRecord/upsertRecord` **一律用 `compareKey`** 作 key；返回给 UI 的 `path` 永远是记录里的 `path` 原值。

#### 6.2.2 `capLabel`（显示标签 40 上限）与路径校验（180）的关系

**两者互不干涉，必须在文档里分开声明，否则会被误当成同一个约束。**

| 维度 | 显示标签 `capLabel` | 路径校验 |
|---|---|---|
| 上限 | **40 字符**（视觉需要） | **180 字符**（`normalizeWorktreePath().path.length`，Windows MAX_PATH 前的安全余量） |
| 作用对象 | 只作用在**界面文案**（胶囊、行副标题、卡片标题） | 作用在**真实路径**（Step 0.8 校验，超限直接拒绝创建） |
| 失败行为 | 截断 + 末尾 `…` | 报错 `path-too-long`，**不创建任何东西** |
| 是否影响数据 | **完全不**。`path` / `compareKey` / 记录均不受影响 | 决定能否创建 |
| 与 slug 的关系 | **不是同一套**：`slug` 是目录名规范化（`[a-z0-9._-]`、≤40、无 `/`），`capLabel` 是任意显示串的截断（可含中文、可含 `/`） | — |

**硬要求：截断后必须能看全。** 每一处用到 `capLabel` 的位置，都必须在同一交互里提供完整形式：

- 胶囊（收起态）：显示 `capLabel`；**展开面板第一行是完整路径**（已有，§12.6）。
- worktree 卡片标题：显示 `capLabel`；`title` 属性 + 详情区显示完整 `path` 与 `branch`。
- 行副标题：显示 `capLabel`；`title` 属性给完整值（对齐既有做法 `Rail.tsx:1092`）。
- **不得**只在 tooltip 里给完整值而无详情区（tooltip 不可复制、触屏不可达）。

**`capLabel` 的实现要求**：按**码点**截断（不能用 `String.length`，中文与 emoji 会切坏），且截断后若末字符是 `-`、`/`、`.`、空格则一并去掉再补 `…`。

### 6.3 slug 规范化（B3 / A47）

`slugifyBranch(name) → string`，**严格按序执行**：

```
1. name.normalize('NFC')
2. 小写化                                        // Windows/macOS 路径大小写不敏感：两个 slug 只差大小写会撞同一目录
3. 非 [a-z0-9._-] 的连续片段 → '-'                 // 含中文、空格、`~^:?*[\`、`@{` 等
4. 连续 '-' 折叠为一个；去首尾 '-' 与 '.'           // git 分支名不得以 '.' 结尾、不得以 '-' 开头
5. '..' → '.'；去掉 '\\'                           // 兜底 git 的其余 ref 规则
6. 若为空（例如纯中文） → 'worktree'
7. 截断到 40 个字符，再重新执行第 4 步（截断可能留下尾部 '-'）
```

**注意原型与规格的一处差异（已定）**：原型面 1 的名称示例是 `deva/req-worktree-ui`，路径显示为 `...\worktrees\deva\req-worktree-ui`——**保留了 `/` 作为一层目录**。规格定为扁平化（`deva-req-worktree-ui-<shortid>`），原因见下。实现按规格，原型的路径串是示意、不作为契约。

**为什么用 `-` 而不是保留 `/`**：目录名里的 `/` 会造成额外层级，破坏 `<repoKey>/<slug>-<shortid>` 的两层结构，也会让「worktree 根下一层」的判断失效（删除/重建时按 `<repoKey>/<一层>` 枚举）。分支名本身可以是 `feat/x`（分支保留用户原样），只有**目录 slug** 被扁平化。

`shortid = Math.random().toString(36).slice(2, 8)`（6 位）。生成后 `existsSync(join(root, slug + '-' + shortid))` 复查，碰撞重试，**最多 5 次**，5 次都撞则报 `slug-collision`（概率 1/2^31，等于实现有 bug）。

**分支名的合法化走 git 自己**：`git check-ref-format --branch <name>` 退出码 0 才算合法（Step 0.5）。不自写则规则——git 的规则很长（`..`、`@{`、`~^:?*[\`、结尾 `.`、`/` 开头结尾、连续 `//`…），自己实现必然漏。

### 6.4 长度预算（A46）

- **阈值 180 字符**（`normalizeWorktreePath().path.length`）。
- **校验时机：Step 0.8**，即 `worktree add` **之前**、写任何记录之前 → 失败无副作用。
- **为什么 180 而不是 260（MAX_PATH）**：`node_modules` 里最深的路径（`.pnpm/<pkg>@<ver>/node_modules/<pkg>/dist/...`）常有 80~120 字符，加上 180 会逼近甚至超 260。**并且**用户可能自定义更深的 `DEVA_HOME`。180 是「还能容下典型 node_modules 层级」的经验上限；真要更长的路径用户还能选主目录模式。
- 超长时**必须给出改写建议**：报错里带上「当前 N 字符，上限 180；建议把目录名缩短到 X 字符」——不能只说「路径太长」。
- **不做自动截断**：自动截断会静默改变用户输入的路径（他复制的正是那个路径），必须报错让用户改。
- **与显示标签 `capLabel`（40）互不干涉**：180 是「能不能创建」，40 是「界面怎么显示」，两者作用对象不同，见 §6.2.2。

### 6.5 判据自指自查（设计阶段的三处「用被验证对象自己证明自己」）

设计成员发现「同一个问题在原型上犯了 4 次」的模式，其中一条对本规格直接适用：**判据的空集合恒真、判据自指**。下面是我把自己规格里所有验证步骤过一遍的结果。

| # | 位置 | 原判据 | 为什么会自证 / 空集合恒真 | 定稿判据 |
|---|---|---|---|---|
| **S1** | `worktree:list` 的「工作区是否还在 git 里登记」 | 原写法会拿 `worktrees.json` 的记录去和「记录的 path」比 | **自指**：本地记录和它自己比永远一致，`git worktree prune` 掉之后永远发现不了 | **必须用 `git worktree list --porcelain` 的输出**（`worktree <path>` 行）作为唯一事实源；`worktrees.json` 只提供 git 里没有的字段（`targetBranch`、`baseSha`、`deps`）。两边差集双向计算：`inGitNotLocal` → `unmanaged`；`inLocalNotGit` → `dir-missing`。**不允许用记录的 path 反查记录** |
| **S2** | Step 3 的「HEAD 校验」 | `git -C <path> rev-parse HEAD` 与 `record.baseSha` 比 | 若 `baseSha` 也是从同一个 `rev-parse` 现算的（而不是 Step 0 冻结后落盘的那个），就是自证 | 必须比**Step 1 已落盘的 `record.baseSha`**（§3.2），且该值来自 **Step 0** 的 `rev-parse`。**创建流程内不得重新计算 `baseSha`**，只能读记录 |
| **S3** | 合并的 C4「target 分支能找到唯一检出」 | 用 `record.targetBranch` 去 `worktree list` 里筛 `branch refs/heads/<targetBranch>` | 若筛不到时「回落到主目录」，就是从「找不到」静默退化成「就在主目录」——空集合被当成默认值 | **筛不到即失败**（`target-not-checked-out`）。**不得有任何回落**。筛到多条也失败（歧义） |

**自查方法（给实现方与审查方）**：对每一条「检查通过/失败」的判断，问两个问题——
1. **判据的证据来自哪里？如果它来自被检查对象自身，这条判据无效。**
2. **当它「什么都没找到」时，代码走的是成功分支还是失败分支？** 空集合必须落到失败（或明确的 `unknown`），不得落到成功。

**本规格里另外三条已按此原则写、不需改的**：

| 判据 | 为什么不是自证 |
|---|---|
| 冲突残留检测（§13.6.2 的 4a/4b） | 判据是 `git ls-files -u` 与 `git grep` 的**输出**，不读我们自己的记录。且实测证明两者互补（见 §13.6.2 的实测表），任一为空都不够 |
| `mergeInProgress` 的三状态 | 每次从 `MERGE_HEAD` / `ls-files -u` **现算**，不落盘（§13.3）。所以「用户在终端 abort 了」能被发现 |
| 读回断言（§7 的 providers 存在性） | 读的是 `getConfig()` 的实际内容，不是导入报告里的 `copied` 清单（后者只用来算「期望集合」） |

---

## 7. IPC 契约

### 7.1 通道一览

全部 `ipcMain.handle`（invoke），注册在 `main/services/worktree/ipc.ts`，由 `main/index.ts` 在 `registerGitIpc()` **之后**调用（依赖 `trustRoot` 与 git 定位）。

| 通道 | 方向 | 入参 | 返回 | 加锁 |
|---|---|---|---|---|
| `worktree:precheck` | invoke | `PrecheckRequest` | `PrecheckResult` | 否（只读） |
| `worktree:create` | invoke | `CreateRequest` | `CreateResult` | `[repoRoot, path]` |
| `worktree:list` | invoke | `{ repoRoot: string }` | `WorktreeSnapshot` | 否 |
| `worktree:remove` | invoke | `RemoveRequest` | `RemoveResult` | `[repoRoot, path]` |
| `worktree:rebuild` | invoke | `{ path: string }` | `RebuildResult` | `[repoRoot, path]` |
| `worktree:prune` | invoke | `{ path: string }` | `{ ok: boolean; message?: string }` | `[repoRoot, path]` |
| `worktree:install-deps` | invoke | `{ path: string; force?: boolean }` | `{ ok: boolean; queued: boolean }` | 否 |
| `worktree:merge` | invoke | `{ path: string }` | `MergeResult` | `[repoRoot, targetPath]` |
| `worktree:merge-dryrun` | invoke | `{ path: string }` | `MergeResult`（只跑 C-1~C6，`mergeAttempted` 恒 false） | 否（只读） |
| `worktree:set-target` | invoke | `{ path: string; targetBranch: string }` | `{ ok: boolean; record?: WorktreeView; message?: string }` | 否 |
| `worktree:progress` | send（主→渲） | `WorktreeProgress` | — | — |
| `worktree:changed` | send（主→渲） | `{ repoRoot: string }` | — | — |

### 7.2 TypeScript 签名

```ts
// ── 共享类型（shared/worktree-protocol.ts，主进程与渲染层共用，preload 复述一份） ──

export interface PrecheckRequest {
  repoRoot: string          // 当前会话的 focusRoot 或 fs:open-folder 选中的目录
  baseRef?: string          // 省略 = 主检出的 HEAD（分支或提交均可，§3.1 的 0.4）
  branch?: string           // 省略 = 由日期/序号自动生成 deva/wt-<n>
  path?: string             // 省略 = 自动生成（§6.1）
  confirmedDirty?: boolean  // 用户在 dirty 提示上点了继续
  skipDeps?: boolean
}

export type PrecheckResult =
  | {
      ok: true
      repoRoot: string
      /** 默认起点：主检出的当前分支名；detached 时为 HEAD 的 40 位 SHA（§3.1） */
      defaultBase: string
      /** 展示用：分支名，或 `HEAD (detached @ <sha7>)` */
      defaultBaseLabel: string
      baseSha: string        // 已 rev-parse 冻结
      baseLabel: string
      /** 合并目标：主检出的分支名；主检出 detached 时为 null（§3.1） */
      targetBranch: string | null
      /** 主检出是否 detached。为真时 UI 必须显示 mergeTargetWarning。 */
      primaryDetached: boolean
      /** targetBranch 为 null 时的必显提示（i18n 键，不在主进程拼中文） */
      mergeTargetWarning?: string
      path: string           // 自动生成或回显用户输入
      branch: string
      slug: string
      /** 候选分支：本地在前（当前分支置顶），远端在后；上限 256（§7.6） */
      branches: { name: string; current: boolean; remote: string | null }[]
      dirtyCount: number
      needsConfirm: boolean  // dirtyCount > 0 && !confirmedDirty
      softWarn?: 'many-worktrees'
      existingCount: number
    }
  | { ok: false; reason: PrecheckFailReason; message: string; suggestion?: string }

export type PrecheckFailReason =
  | 'not-a-repo' | 'bad-base' | 'bad-branch'
  | 'branch-exists' | 'path-exists' | 'path-too-long' | 'path-inside-repo'
  | 'slug-collision' | 'no-git' | 'error'
// 注：不再有 'primary-detached' —— 主检出 detached 现在是可创建状态（§3.1），
// 只让 targetBranch 变 null，不阻断。

export interface CreateRequest extends PrecheckRequest {
  baseRef: string           // 必填：precheck 已给出 defaultBase（detached 时为 SHA）
  branch: string
  path: string
  baseSha: string           // precheck 返回的那个；create 会再核一次是否仍可 resolve
  confirmedDirty: boolean
  skipDeps?: boolean
}

export type CreateResult =
  | {
      ok: true
      path: string
      branch: string
      baseSha: string
      /** null = 主检出 detached，尚未有合并目标（§3.1） */
      targetBranch: string | null
      deps: DepsState
      /** 依赖安装异步进行；为真时 UI 显示进度条 */
      depsPending: boolean
    }
  | {
      ok: false
      reason: PrecheckFailReason | 'add-failed' | 'head-mismatch' | 'record-write-failed' | 'session-create-failed'
      message: string
      /** 失败已清理完毕（worktree/分支/目录都不存在）。session-create-failed 时为 false —— 那时 worktree 应当保留。 */
      cleaned: boolean
      /** 清理没做干净的部分，原样展示给用户 */
      cleanupWarnings?: string[]
      /** session-create-failed 时给出，UI 用它做「在该工作区新建会话」的重试 */
      worktreeCreated?: boolean
    }

export type WorktreeState = 'ok' | 'dir-missing' | 'prunable' | 'branch-mismatch'
export type DepsState = 'pending' | 'installing' | 'ready' | 'failed' | 'skipped'

export interface WorktreeView {
  path: string
  compareKey: string
  repoRoot: string
  branch: string
  baseSha: string
  baseLabel: string
  targetBranch: string
  createdAt: number
  /** 目录/登记/分支归属的健康度。**与「有没有会话」正交**，见 §2.5。 */
  state: WorktreeState
  /** state 不为 ok 时的补充事实，供 UI 直接显示，不做推断 */
  detail: {
    dirExists: boolean
    gitRegistered: boolean
    /** 实际 HEAD 分支；detached 时为 null */
    headBranch: string | null
    prunable: boolean
  }
  deps: DepsState
  depsDetail?: string
  /** 关联会话数（focusRoot === path 的主会话数） */
  sessionCount: number
  /** 该工作区未提交改动数；目录不存在时为 null（无法统计）。列表显示「3 个未提交改动」用。 */
  dirtyCount: number | null
  /** 磁盘占用字节数；目录不存在或尚未统计时为 null。展示为「1.2 GB」/「占用未知」。 */
  sizeBytes: number | null
  /** 当前是否有 Deva 发起的 git 操作占用该路径 */
  lockHolder: { label: string; since: number } | null
  /**
   * target 检出里是否有未收尾的合并（§13.10）。**每次从 git 现算，不落盘**。
   * 非空时卡片显示「合并进行中」，并可打开冲突处理窗口。
   */
  mergeInProgress: { targetPath: string; unmergedCount: number } | null
  /** 合并可用性：主进程算好的可用性门（不看 dirty，只做轻量判定）。见 §4.2 与 §7.5。 */
  mergeGate: { mayMerge: boolean; blocker?: MergeCheck['reason'] }
}

export interface WorktreeSnapshot {
  repoRoot: string
  primaryBranch: string | null   // 主检出分支；detached 时 null
  worktrees: WorktreeView[]
  /** git 里登记了但不在 worktrees.json 里的路径：只读展示，不参与任何操作 */
  unmanaged: { path: string; branch: string | null; prunable: boolean }[]
  /** 主仓库的项目记忆根（= repoRoot），渲染层用于文案「与主仓库共享记忆」 */
  memoryRoot: string
  gitAvailable: boolean
}

export interface WorktreeProgress {
  path: string
  phase:
    | 'precheck' | 'creating-worktree' | 'verifying'
    | 'installing-deps' | 'waiting-lock'
    | 'merging' | 'done'
  /** 安装依赖时的进度（无法精确时 total=0） */
  done?: number
  total?: number
  /** phase==='waiting-lock' 时给出 */
  holder?: { label: string; since: number }
  /** 安装时最近一行输出（已截断到 200 字符），让用户看到「在动」 */
  line?: string
}

export type RemoveResult =
  | { ok: true; branchDeleted: boolean; branchKept: string }
  | { ok: false; reason: 'dirty' | 'busy' | 'installing' | 'not-found' | 'error'; message: string; dirtyCount?: number }

export type RebuildResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; reason: 'branch-missing' | 'branch-in-use' | 'path-exists' | 'error'; message: string }

export type MergeResult =
  | {
      ok: true
      upToDate: boolean
      targetPath: string
      targetBranch: string
      sourceBranch: string
      sourceSha: string
      mergeCommit: string | null
      /** git merge 的 stdout+stderr 原样（`Merge made by the 'ort' strategy.` 与文件统计）；upToDate 时为空串 */
      gitOutput: string
      behindNote?: { pendingSha: string; pendingCount: number }
    }
  | {
      ok: false
      /** 合并是否执行过。false = 卡在检查阶段（含 target-not-set），target 未被触碰。 */
      mergeAttempted: boolean
      /** **零或四项**：target-not-set 时为 []，进入检查阶段后恒为 4 项。不得短路、不得按 status 过滤。 */
      checks: MergeCheck[]
      reason:
        | 'target-not-set'
        | 'source-missing' | 'source-branch-changed' | 'source-busy'
        | 'target-not-checked-out' | 'target-overlap' | 'target-busy'
        | 'conflict' | 'merge-failed'
      /** conflict/merge-failed 时为 git 原文；检查阶段失败时为空串（文案由渲染层按 checks 拼） */
      message: string
      gitOutput?: string
      targetBranch: string | null
      sourceBranch: string
      /** C4 之后才有；UI 用它做「中止合并 / 打开终端 / 打开目录」的目标 */
      targetPath?: string
      /** 已冻结时给出，供「复制 git 命令」与手工执行 */
      sourceSha?: string
    }

/**
 * 单项检查。**四项固定，与原型面 4 的四个圆点一一对应**：
 *   C1 ↔「工作区的未提交改动」（恒通过；脏时黄点 + 清单，见 §4.9）
 *   C2 ↔「工作区还在自己的分支上」
 *   C4 ↔「目标分支仍在原处」（detail.targetPath = 检出它的目录）
 *   C5 ↔「脏改动与本次合并要改的路径无交集」（§4.9.3 的三点 diff 交集）
 * C4 与 C5 必须是两个独立的项 —— 合并成一项会让原型的两行塌成一行，
 * 用户就看不到「找不到检出目录」与「检出目录脏」的区别（两者出路完全不同）。
 */
export interface MergeCheck {
  id: 'C1' | 'C2' | 'C4' | 'C5'
  /**
   * 'warn' 是本次新增：C1（source 有未提交改动）用它——不阻断合并，但必须在界面上可见。
   * 圆点颜色：ok=绿、warn=黄、bad=红、skipped=灰。
   */
  status: 'ok' | 'bad' | 'warn' | 'skipped'
  /** 稳定键，渲染层据此取 i18n（§7.4）。取值：'dirty' | 'branch-changed' | 'busy'
   *  | 'source-missing' | 'not-checked-out' | 'overlap' | 'unknown'。C3/C6 的「进行中操作」并入 'busy'。 */
  reason?: string
  /** 判据用到的数字/名称：dirtyCount / dirtyPaths / overlapPaths / actualBranch / busyOp / targetPath / primaryBranch */
  detail?: Record<string, string | number | string[]>
}
```

**两处容易做错的映射**（审查按这两条核）：

1. **C3 / C6（进行中操作）不占独立圆点**，其失败并入 `C5` 的 `reason: 'busy'`（target 侧）或 `C2` 的 `reason: 'busy'`（source 侧；source 处于 merge 中必然也「不在自己分支上」或「脏」，所以并到 C2 不会漏信息）。`busy` **优先于** `dirty` 展示：上次合并没收尾比有 3 个改动更根本，先说根因用户才知道从哪下手。
2. **C0（source 目录不存在）**：`C1`/`C2` 记 `skipped` + `reason: 'source-missing'`，`C4`/`C5` 照常算。这样 source 没了，用户仍能看到 target 侧状态，一次就知道要修几处。

### 7.3 事件

- **`worktree:progress`**：安装依赖、等待锁、合并期间推送。**必须照抄 `importer-ipc.ts:28-71` 的 `throttledSend`**（100ms 节流 + 换 `phase` 立即发 + 收尾 `phase==='done'` 必发 + `timer.unref()`）。理由同导入：不节流会把渲染层淹没，丢最后一次会让进度条永远差一截。
- **`worktree:changed`**：创建/删除/重建/依赖状态转移/合并成功后发。渲染层收到后重拉 `worktree:list`。**不要带 payload 快照**——一次 invoke 拉全量更简单，也不会有「事件里的快照比 list 旧」的问题（worktree 数量是个位数）。
- 与既有的 `publishSessionsChanged()` 是**两个独立事件**：worktree 变了要发 `worktree:changed`；会话列表变了发 `publishSessionsChanged()`。创建流程两个都发。

### 7.4 文案与 i18n

新增键（`renderer/src/i18n/messages.ts` 的 `cf.wt` 段，中英各一份）：

| 键 | 中文 |
|---|---|
| `cf.wt.position` | 位置 |
| `cf.wt.positionMain` | 主目录（{path}） |
| `cf.wt.positionNew` | 新工作区 |
| `cf.wt.base` | 起点 |
| `cf.wt.baseDetached` | HEAD（游离于 {sha}） |
| `cf.wt.branch` | 分支 |
| `cf.wt.path` | 路径 |
| `cf.wt.dirtyTitle` | 主目录有 {n} 个未提交改动 |
| `cf.wt.dirtyBody` | 新工作区不会包含这些改动（它们只留在主目录）。不影响、也不暂存你的改动。 |
| `cf.wt.tooLong` | 路径 {n} 字符，超过上限 180。请把目录名缩短到 {x} 字符。 |
| `cf.wt.branchExists` | 分支 {branch} 已存在。可选：{suggestion} |
| `cf.wt.pathExists` | 目录 {path} 已存在，不会覆盖或删除它。请换一个路径。 |
| `cf.wt.manyWorktrees` | 已有 {n} 个独立工作区，每个含一份依赖（约 15-25MB）。 |
| `cf.wt.depsFailed` | 依赖未装好（{detail}），新工作区仍可使用；pnpm / npm 类命令会失败。 |
| `cf.wt.state.dirMissing` | 工作区目录已缺失 |
| `cf.wt.state.prunable` | 工作区目录已缺失（git 登记可清理） |
| `cf.wt.state.branchMismatch` | 工作区已被切到 {actual}，不再是 {branch} |
| `cf.wt.merge.notCheckedOut` | 分支 {branch} 当前没有被任何工作区检出，无法合并。请先在一个目录里检出它。 |
| `cf.wt.merge.sourceDirty` | 工作区有 {n} 个未提交改动，请先提交或撤销。 |
| `cf.wt.merge.targetDirty` | 目标目录（{path}）有 {n} 个未提交改动，请先处理后再合并。 |
| `cf.wt.merge.sourceBranchChanged` | 该工作区已不在分支 {branch} 上（现在是 {actual}），无法合并。 |
| `cf.wt.merge.busy` | 目标目录还有未收尾的 git 操作（{op}），请先完成或中止。 |
| `cf.wt.merge.upToDate` | 目标分支已包含该工作区的全部提交，无需合并。 |
| `cf.wt.merge.behind` | 合并成功；期间该工作区又有 {n} 个新提交尚未合并，可再次合并。 |
| `cf.wt.abortMerge` | 中止合并 |
| `cf.wt.openTerminal` | 在终端打开目标目录 |
| `cf.wt.reveal` | 在文件管理器打开 |
| `cf.wt.copyCommand` | 复制 git 命令 |
| `cf.wt.memoryShared` | 与主仓库 {repoRoot} 共享项目私有记忆 |
| `cf.wt.noSession` | 无关联会话 |
| `cf.wt.sizeUnknown` | 占用未知 |
| `cf.wt.sessionCount` | {n} 个会话 |
| `cf.wt.dirtyMeta` | {n} 个未提交改动 |
| `cf.wt.deps.pending` | 待安装依赖 |
| `cf.wt.deps.installing` | 安装中 {done}/{total} |
| `cf.wt.deps.ready` | 依赖就绪 |
| `cf.wt.deps.failed` | 依赖安装失败 |
| `cf.wt.deps.skipped` | 无需安装依赖 |
| `cf.wt.deps.retry` | 重试安装 |
| `cf.wt.deps.noopHint` | 等待期间可以先发消息，agent 会等装完再开始读代码。 |
| `cf.wt.merge.title` | 合并回 {target} |
| `cf.wt.merge.merge` | 合并 |
| `cf.wt.merge.success` | 已合并到 {target} |
| `cf.wt.merge.successSha` | 合并提交 {sha} |
| `cf.wt.merge.targetNotSet` | 还没有合并目标。选一个本地分支作为目标。 |
| `cf.wt.merge.pickTarget` | 合并目标 |
| `cf.wt.baseDetachedHint` | 主目录当前不在任何分支上（detached HEAD），起点取它所在的提交。可以改成任意分支。 |
| `cf.wt.mergeTargetWarning` | 主目录不在任何分支上，所以这个工作区暂时没有合并目标。可以先创建，之后在主目录切到一个分支，再在合并面板里指定目标。 |
| `cf.wt.remove.title` | 删除工作区 |
| `cf.wt.remove.dirtyTitle` | 这个工作区还有 {n} 个未提交改动，不能删除。 |
| `cf.wt.remove.dirtyKeep` | 要保留它们：在终端里打开该目录，提交或 stash 后再删。 |
| `cf.wt.remove.dirtyDrop` | 要放弃它们：勾选下面的确认项。 |
| `cf.wt.remove.dropConfirm` | 我知道这些改动会永久丢失 |
| `cf.wt.remove.installing` | 正在安装依赖，等它结束或失败后再删。 |
| `cf.wt.remove.prune` | 移除登记 |
| `cf.wt.remove.pruneHint` | 不删除任何文件（目录本来就不存在），只清理 git 登记。 |
| `cf.wt.remove.branchKept` | 分支 {branch} 会保留。 |
| `cf.wt.boundary.title` | 这个会话在独立工作区里 |
| `cf.wt.boundary.workspace` | 工作区 |
| `cf.wt.boundary.base` | 切出自 |
| `cf.wt.boundary.target` | 改动合回 |
| `cf.wt.boundary.notIncluded` | 不在本区 |
| `cf.wt.boundary.showRaw` | 看注入给 agent 的原文 |
| `cf.wt.boundary.hideRaw` | 收起原文 |
| `cf.wt.boundary.manualMerge` | （需手动合并，不会自动同步） |

**系统提示词的 worktree 边界说明**（§1.5）走主进程的 `isEn()`（对齐 `chat-prompts.ts:563` 的既有双语模式），不放 i18n——它是给模型看的，不是界面文案。**但「给人看的四行摘要」（`cf.wt.boundary.*`）必须放 i18n**：它是界面文案，与注入原文是两层（原型面 2 明确分成两层）。

### 7.5 合并预检（`worktree:merge-dryrun`）与 `mayMerge`

**必须有一个只读的预检通道**，理由：原型面 3 的「合并回 my/dev」按钮在 `branch-mismatch` / `installing` 时是禁用的，而按第 8 条原则「状态只由主进程算」，渲染层不能自己看 `state` 推断禁用。所以：

- `WorktreeView.mergeGate` 由 `worktree:list` 一并返回（轻量版：只看 `state`、`deps`、`targetBranch` 是否为空，**不跑** `status --porcelain`，否则列表就要对每个工作区跑 git，5 个就是 5 次）。
- `mergeGate` 为 `{ mayMerge: false, blocker }` 时按钮禁用，`title` 用 `blocker` 取 i18n。
- 用户点开合并面板时调 `worktree:merge-dryrun` 拿到真实四项结果，再画四个圆点。**这时才跑 C1~C6**。
- 点「合并」时调 `worktree:merge`，它内部**重新跑一遍** C1~C6（dryrun 的结果不缓存、不复用）。理由：dryrun 到点合并之间用户可能去清了改动、也可能 agent 又提交了，复用旧结论等于跳过检查。重新跑的成本是 6 次 git 调用，几十毫秒，值得。

**`mergeGate.blocker` 的取值**：`'target-not-set'` | `'source-missing'` | `'source-branch-changed'` | `'installing'`。注意 `'installing'` 不是 §4.2 的检查项，它是 UI 层面的「依赖没装完不能合并」（安装期间文件系统不稳定，git 会看到半装的文件）。这一条由主进程在 `mergeGate` 里给，不走 C1~C6。

### 7.6 分支候选的上限 256

- 数据源：复用 `git:branches`（`git.ts:761-785`）已返回的 `{ name, current, remote, upstream }[]`，**不新写枚举逻辑**。
- 排序：`current` 优先 → 本地分支 → 远端分支 → 按名升序。**不按 commit 时间**（要多跑一次 `for-each-ref --sort=-committerdate`，对 1000 个分支的仓明显变慢，而选择器里用户是按名字找的）。
- 截断到 256 后，**必须返回 `truncated: boolean`** 并在 UI 顶部加一行输入框允许直接输入分支名（否则用户想选的远端分支被截掉了，他会以为分支不存在——这是静默错误）。
- 默认值 `defaultBase`：非 detached 时 = 主检出 `rev-parse --abbrev-ref HEAD`（`defaultBaseLabel` 与之相同）；**detached 时 = 主检出 HEAD 的 40 位 SHA**，`defaultBaseLabel = 'HEAD (detached @ <sha7>)'`，`primaryDetached = true`（§3.1）。
- **远端分支也可以作起点**：因为执行时用冻结的 SHA（§4.3 同一条机制），`worktree add -b x <path> <sha>` 对远端分支与本地分支完全一样，**不需要 `--track` 特例**。这是「先冻结 SHA」这条决定最容易被忽略的收益。
- **`branches[].current` 的判据**：`name === defaultBase`（非 detached 时）；detached 时没有任何分支的 `current` 为真，列表首项单独插入一条 `HEAD (detached @ <sha7>)` 作为当前项（原型面 1 第③屏即此形态）。

### 7.7 新建会话 UI 的契约（对齐原型面 1 五屏）

这一节不是视觉规范（那是设计文档的职责），只写**状态与字段的对应关系**，供实现方核对「每一屏的数据从哪来」。

| 原型屏 | 触发条件 | 数据来源 | 规格章节 |
|---|---|---|---|
| ① 默认主目录 | 弹窗打开，用户未切换 | 位置单选默认「主目录」；描述行 `主目录（<focusRoot>）· 当前分支 <primaryBranch>` | §3.1 |
| ② 展开三项 + dirty 提示 | 选「新工作区」 | `precheck` 的 `baseLabel`/`branch`/`path`/`dirtyCount`；`dirtyCount > 0` 才显示警示框，**不阻断主按钮** | §3.1 的 0.9 |
| ③ 起点下拉（含 detached） | 点起点选择器 | `branches[]`（上限 256）+ `primaryDetached`/`defaultBaseLabel`；detached 时首项为 `HEAD (detached @ <sha7>)` | §7.6 |
| ④ 依赖安装中 | 创建成功、`deps === 'installing'` | `worktree:progress` 的 `done/total/line` | §3.6 |
| ⑤ 依赖安装失败 | `deps === 'failed'` | `depsDetail`（最后 20 行）；**必须同时显示「会话仍可使用」** | §3.6 / A27 |

**三条硬要求**（原型已画，规格必须承接）：

1. **dirty 提示只警示不拦截**：主按钮文案保持「创建工作区并开始」，可点。`needsConfirm` 为真时**不弹二次确认框**，警示框本身就是告知；用户点主按钮即视为确认（把 `confirmedDirty: true` 带上）。理由：dirty 是常态（本仓当前 24 个），弹确认框会让每次创建都多一步。
   - ⚠️ 但 §3.1 表格里的 `needs-confirm` 返回值仍要保留：它是**给「服务端判定」用的接口**，渲染层拿到 `needsConfirm: true` 后**直接显示警示框、不禁用按钮**，用户点主按钮时 `create` 带 `confirmedDirty: true`。不要把 `needsConfirm` 实现成「必须再往返一次才能创建」。
2. **名称与路径双向联动**：改名称自动推路径；用户手改过路径后，`locationTouched = true`，此后改名称**不再覆盖路径**。这是原型明确的 vibes 做法，必须在渲染层维护一个 `locationTouched` 状态（不进主进程）。
3. **路径框可编辑 + 「浏览…」按钮**：`fs:open-folder`（`workspace.ts:43`）返回的是用户选的目录，但它会 `trustRoot` 那个目录——注意它是**选目录对话框**，不是「保存到」。用户选完之后的路径 = 所选目录 + 自动 slug（或直接作为 worktree 路径，由 UI 决定）。P3 拍板要求「路径可编辑」，所以「浏览…」是必需的。

---

## 8. 实施顺序（可派工粒度）

每个任务写明：**改哪些文件 / 依赖 / 完成的判据**。判据要么是可跑的断言编号，要么是可 grep 的事实。

### P0 · 地基与数据安全（不完成则不可交付）

| # | 任务 | 改哪些文件 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **T0.1** | 把 `fs-guard.ts` 的 `realResolve` 导出 | `main/services/fs-guard.ts:20`（`function` → `export function`） | — | `pnpm typecheck` 通过；全仓 `grep -rn 'realResolve' main/` 只有 import 与定义 |
| **T0.2** | `worktree/paths.ts`：路径归一化、`repoKeyOf`、`slugifyBranch`、长度与仓库内校验 | 新增 `main/services/worktree/paths.ts` | T0.1 | 单测覆盖 A44/A46/A47 的输入（大小写、尾斜杠、纯中文、超长、仓库内路径） |
| **T0.3** | `worktree/store.ts`：`worktrees.json` 读写，主键 `compareKey`，写盘走 `writeFileAtomic` 且返回布尔 | 新增 `main/services/worktree/store.ts` | T0.2 | 写失败返回 false（构造只读目录验证）；损坏文件不抛、视为空 |
| **T0.4** | `worktree/lock.ts`：`withGitLock` + `gitLockHolder` | 新增 `main/services/worktree/lock.ts` | T0.2 | 并发两次同路径调用严格串行；不同路径可并行；等待超 5 秒发 `waiting-lock` |
| **T0.5** | `worktree/git-worktree.ts`：`add` / `remove` / `list --porcelain` 解析 / HEAD 校验 / **失败清理算法**（§3.4 六步） | 新增该文件 | T0.2/T0.3/T0.4 | **A1-A4 / A22 / A25 / A28** 全绿；清理后 `git branch --list` 无本次分支、目录不存在、主目录 `status --porcelain` 逐字符不变 |
| **T0.6** | `worktree/scope.ts`：`projectMemoryRootOf` + `WorktreeBrief` 解析 | 新增 `main/services/worktree/scope.ts` | T0.3 | 已登记 worktree 返回 `repoRoot`；未登记原样返回；null 透传 null |
| **T0.7** | 启动清扫（§2.4） | `main/index.ts`（注册 IPC 前调用）+ `worktree/recover.ts` | T0.5 | 造 `phase:'creating'` 记录 + 半边分支 → 启动后分支与目录被清、记录被删 |
| **T0.8** | `worktree:create` + `precheck` IPC，`deps` 先固定为 `skipped` | 新增 `worktree/ipc.ts`、`worktree/create.ts`；`preload/index.ts`；`shared/worktree-protocol.ts` | T0.5/T0.6 | **A5/A6/A7/A8/A17-A21/A22-A26/A28/A46/A47** 绿（A27 见 T1.3） |
| **T0.9** | 会话绑定 + `startFresh` 的 `persist` 参数 | `renderer/src/store/chat.tsx:1367-1393`；`main/services/chat.ts:515-522` | T0.8 | **A13/A14/A31/A45** 绿 |
| **T0.10** | A29/A30 回归守卫 | 只审查，不改代码 | T0.9 | `grep -rn 'invalidateIndex\b' main/` 无调用点；长对话进行中执行创建，重启后消息仍在 |

**P0 的验收门槛**：T0.1~T0.10 全绿才允许进入 P1。理由：这一批全是「主目录逐字符不变」「不留孤儿分支」「不静默成功/失败」——数据安全面。任何一条松了，后面所有功能都建在流沙上。

### P1 · 可用

| # | 任务 | 改哪些文件 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **T1.1** | 新建会话 UI：位置单选（默认主目录）、起点选择器（含 detached 显示）、名称/路径可编辑 + `locationTouched` 联动、dirty 只警示不拦截、软提示 | `renderer/src/redesign/QuickStart.tsx`（或新建 `NewSessionDialog.tsx`）、`redesign.css` | T0.8 | B7（禁用态 + tooltip）、A18、**A47**、**A50** 绿；§7.7 三条硬要求逐条对原型五屏核过；合并面板的「指定目标分支」入口可用 |
| **T1.2** | worktree 快照 store + `state` 计算 | `worktree/list.ts`（新增）、`renderer/src/store/worktree.tsx`（新增） | T0.8 | 四种 `state` 各构造一次验证（删目录、prune、切分支、正常） |
| **T1.3** | 依赖安装：lockfile 检测 + 异步 + 进度 + `deps` 状态机 | `worktree/deps.ts`（新增）、`ipc.ts` 增 `install-deps` | T1.2 | **A27** 绿；B4（进度可见）绿；`deps` 六条转移全部覆盖 |
| **T1.4** | worktree 列表（设置 › 工作区）：分支、路径、`sessionCount`+无会话 badge、`state`、`deps`、`sizeBytes`、`lockHolder`、删除/重建/prune | `renderer/src/redesign/WorktreePane.tsx`（新增）、设置页入口 | T1.2 | B1、A32-A34、**A54** 绿；**A33**（不自动 prune）绿；`mergeGate` 禁用态不自行推断（**A48**） |
| **T1.4b** | `sizeBytes` 异步统计（缓存 + 后台刷新，不阻塞 `worktree:list`） | `worktree/list.ts` | T1.4 | 列表首次返回 `sizeBytes: null`（显示「统计中…」），算完发 `worktree:changed` 再刷新 |
| **T1.5** | 边界告知（A36）：含负面约束与记忆共享行 | `chat-prompts.ts:43-45/105-106/163-164`；`chat-turns.ts` 三个 `memoryPromptSection` 调用点附近 | T0.6 | A36 绿：五段齐全（工作目录/合回目标/切出自+未提交数/负面约束/记忆共享） |
| **T1.6** | **P1 记忆共享（G5）** — §1.4 的 M1~M15 | `tools.ts:594/1876/1880/1902/1917/1938/1941`；`listing.ts:163/166/184`；`agent-loop.ts:504`；`memory.ts:315-360/392` | T0.6 | **A35** 绿（worktree 写入 → 主仓库立即可读）；`grep -rn 'ctx.workspaceRoot' tools.ts` 中记忆相关只剩 memoryScopeRoot |
| **T1.7** | 显示标签（§1.7） | `redesign/worktree-label.ts`（新增）；`Rail.tsx:1094`、`ProfileView.tsx:162`、`TaskPickers.tsx:190`、`Composer.tsx` chip | T1.2 | 副标题显示分支名而非 `deva-my-dev-a1b2c3`；`Rail.tsx:185/390/438` **未被改动**（`git diff` 核） |

### P2 · 合回去

| # | 任务 | 改哪些文件 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **T2.1** | `worktree:merge` + `merge-dryrun` + `set-target`：C-1/C0~C6（**四项全列**）+ **§4.9 的路径交集（三点 diff 语义）** + SHA 冻结 + `--no-ff --no-edit`；**禁用 `--autostash`** | `worktree/merge.ts`（新增）、`ipc.ts` | T0.4/T0.5 | **A37/A38/A39/A40/A41/A50/A51/A52/A90/A91/A92/A93/A96** 绿 |
| **T2.1b** | 显式 stash 流程（`stash push --include-untracked` → merge → `stash pop`）+ 三种失败分支的告知 + staged 状态丢失告知（§4.9.5） | T2.1 | **A94/A95** 绿 |
| **T2.1c** | stderr 稳健解析（不写死缩进/行号、退出码不作性质判据）（§4.9.7） | T2.1 | **A97/A98** 绿 |
| **T2.2** | 失败出口四件套（§4.7）+ 成功面板（§4.8） | `renderer/src/redesign/WorktreePane.tsx`；`worktree/merge.ts` 返回 `targetPath` | T2.1 | **A42/A43/A52/A55** 绿：冲突后 `mergeInProgress === true`、四个按钮可用、source 逐字节不变；复制命令含 `cd` 且指向 targetPath |
| **T2.3** | `upToDate` 与窗口报告（§4.3/§4.4） | `worktree/merge.ts` | T2.1 | 构造「已包含」→ `upToDate:true` 且无合并提交；构造「合并后 source 又提交」→ `behindNote` 正确 |

### P3 · 收尾

| # | 任务 | 改哪些文件 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **T3.1** | 删除 worktree（§2.6）：dirty 拒绝+勾选确认、`installing` 无条件拒绝、分支默认保留、「无关联会话」badge | `worktree/remove.ts`；`WorktreePane.tsx` | T1.4 | B2 + **A53/A54** 绿 |
| **T3.2** | 单独删分支（带未合并提交数提示） | `remove.ts` + UI | T3.1 | 未合并时给出提交数并要求二次确认 |
| **T3.3** | `worktree:rebuild`（A34） | `worktree/rebuild.ts` | T1.4 | A34 绿：重建成功或明确报错，不得「提示成功但目录不存在」 |

**派工建议**：T0.1~T0.4 可并行（互不依赖）；T0.5 是唯一的串行瓶颈（依赖前四个），应当单独派给最熟悉 git 的那个人；T1.5 与 T1.6 必须同一人做（它们改的是同一条 `memoryScopeRoot` 链路的两端，拆开必然一端漏改）。

---

## 9. 风险与断言映射

### 9.1 R1-R15 → 断言

| 风险 | 描述 | 对应断言 | 覆盖任务 |
|---|---|---|---|
| R1 | 项目私有记忆在 worktree 里是空的（G5） | **A35**（新增） | T1.6 |
| R2 | worktree 里 `AGENTS.md` 是 base 版本，不含主目录未提交改动 | **A36**（新增）的 ③ | T1.5 |
| R3 | `targetBranch` 检出位置找错 → merge 打到别处 | **A41**（新增） | T2.1 |
| R4 | source 分支被切走 → 合到错的内容 | **A40**（新增） | T2.1（C2） |
| R5 | target 脏改动与合并路径有交集 → merge 硬报错中止 | **A39/A90/A91/A93** | T2.1（C5） |
| R6 | 路径大小写/尾斜杠未归一 → 同一 worktree 两条记录 | **A44**（新增） | T0.2/T0.3 |
| R7 | 归一化时目录已不存在 → 退化成字面比较 | **A44** 的附加场景：删掉目录后仍只有一条记录 | T0.1/T0.2 |
| R8 | `install` 中途删 worktree → `EPERM` | **B2** 扩展：`deps==='installing'` 时删除被拒绝 | T3.1 |
| R9 | 失败清理误删用户已有目录 | **A22**（目录原有文件仍在） | T0.5 |
| R10 | `add` 成功但 HEAD 校验失败 → 表面成功 | **A28** + **A5** | T0.5/T0.8 |
| R11 | 为刷新列表调了 `invalidateIndex()` → 在跑对话静默丢盘 | **A29/A30** | T0.10 |
| R12 | worktree 路径太长撞 MAX_PATH | **A46**（新增） | T0.2/T0.8 |
| R13 | 渲染层自己推断「可合并」 → 两处不一致 | **A48** | T1.2/T2.2 |
| R14 | 会话改挂后失去关联 | **A45** | T0.9 |
| R15 | Git 锁只覆盖 Deva 发起的操作 | **A49** | T0.4/T2.1 |

### 9.2 G1-G5 → 任务

| 缺口 | 内容 | 覆盖任务 | 断言 |
|---|---|---|---|
| **G1** | `target_branch` 不等于「合并在哪个目录执行」 | T2.1（C4）、T0.3（记录 `repoRoot`） | A41 |
| **G2** | 「worktree 永久固定自己的分支」是约定不是机制 | T2.1（C2） | A40 |
| **G3** | target 检出脏时合并会炸 | T2.1（C5/C6） | A39/A90 |
| **G4** | A15/A16 与 v3 冲突、应作废 | 本文件 §0.2（文档层） | A15/A16 不执行；A7/A8/A13/A14/A31 按 §0.2 改写后执行 |
| **G5** | 项目私有记忆每个 worktree 各一份 | T1.6（M1~M15） | A35 |

### 9.3 v2 原有断言的落位（便于验收对照）

| 断言组 | 覆盖任务 | 备注 |
|---|---|---|
| A1-A4 | T0.5 | 主目录不动。A4 需在 add 失败路径上验 |
| A5/A6/A7/A8 | T0.8 | A7/A8 按 §0.2 改写场景 |
| A9-A12 | T0.8/T0.9 | A11（两 agent 并行）依赖 T0.4 的锁粒度正确；A12 依赖 T0.9 |
| A13/A14 | T0.9 | A15/A16 作废 |
| A17-A21 | T0.8/T1.1 | A18 走 precheck 的 `needsConfirm` |
| A22-A26 | T0.5/T0.8 | A24 需 T1.1 的入口禁用 |
| A27 | T1.3 | |
| A28 | T0.5/T0.8 | |
| A29/A30/A31 | T0.9/T0.10 | |
| A32/A33/A34 | T1.4/T3.3 | A33 的关键是启动清扫里**没有** prune（§2.4 第 4 条） |
| B1-B8 | T1.1-T1.4/T3.x | B5 的「不在仓库目录树内」用 `relative()` 判，**不要**用 `git status` 判（`.deva/` 已被 ignore，恒真） |

### 9.4 需要补的断言（本文件新增，v2 没有）

A35~A55 —— 共 21 条，正文见 §0.3 与 §9.1/§9.4/§9.5。**这 21 条必须追加进 `notes/archived/2026-11-18-worktree-parallel-acceptance-v4.md`**（验收方按那一份执行）。

### 9.5 原型校对后新增的断言（A50-A55）

原型暴露了 6 处本文件初版没覆盖的状态，各配一条断言：

| 编号 | 断言 | 规格依据 |
|---|---|---|
| **A50** | 主目录 detached 时仍能创建成功（`targetBranch === null`），且 `precheck` 返回 `primaryDetached: true` + `mergeTargetWarning`；合并前必须先 `worktree:set-target` 指定目标，否则合并被拒（`reason: 'target-not-set'`，`checks: []`，target 未被触碰） | §3.1、§4.2、§7.1 |
| **A51** | 四项检查**全列**：构造 source 脏 + source 分支被切走 + target 找不到检出 + target 脏 同时成立 → `checks` 长度为 4，且 4 项全为 `bad`（**不得只报第一个**） | §4.2、§7.2 |
| **A52** | 合并成功返回 `mergeCommit`（40 位）且 `gitOutput` 非空；`upToDate: true` 时 `mergeCommit === null` 且界面不显示 SHA | §4.5、§4.8 |
| **A53** | 删除 worktree：`state:'ok'` + 3 个未提交改动 → 拒绝并返回 `dirtyCount: 3`；勾选「我知道这些改动会永久丢失」后可删；`deps==='installing'` 时无条件拒绝（不给勾选项） | §2.6 |
| **A54** | 「无关联会话」是 `sessionCount === 0`，与 `state` 正交：构造一个 `state:'ok'` + 0 会话的工作区，和 `state:'dir-missing'` + 1 会话的工作区，两者都能正确表达 | §2.5 |
| **A55** | 「复制 git 命令」的内容含 `cd`、目标目录是 **targetPath**（不是 sourcePath）、Windows 带 `/d`；冲突时给出的是 `git merge --abort` 版本 | §4.7 |

---

## 10. 实现方最容易做错的点（自查清单）

按「错了会不会静默」排序，交付前逐条自查：

1. **记忆共享只改了 `memory.ts`，漏了 `listing.ts:163` 与 `agent-loop.ts:504`。** 表现：系统提示词里说「有项目记忆」，而每轮下发的「【记忆条目】」里没有——两个自相矛盾的信号，agent 会当作记忆不存在，且**不报任何错**。这两处必须与 `tools.ts` 那一组同批改（T1.6 同一个任务）。
2. **四项检查写成「命中即返回」。** 表现：用户清掉 source 的改动再点合并，又冒出「target 脏」——一次只能修一处，而 B/A51 要求一次列出全部。实现时**先把 4 项全算完存进数组，再决定 `ok`**，不要在循环里 `return`。
3. **`checks` 里少了 C4 或把 C4/C5 合并成一项。** 原型画的是 4 个圆点（source 干净 / source 在本分支 / target 分支仍在原处 / target 目录干净），合并成 3 项会让「找不到检出目录」和「检出目录脏」共用一个圆点，两者的出路完全不同（前者要切回分支，后者要清改动）。
4. **失败清理用了 `git branch -d` 而不是 `-D`。** 表现：孤儿分支没删掉，A25 失败；而且 `-d` 的报错会被当成「清理成功」（因为实现通常只判 `code === 0` 之后继续）。
5. **`state` 判断把 detached 当成「分支名叫 HEAD」。** 表现：用户在 worktree 里 `checkout --detach` 后，卡片仍显示 `ok`、合并按钮可点，点下去才在 C2 报错——状态机的意义就没了。
6. **主检出 detached 时直接拒绝创建。** 初版规格就是这么写的，已改（§3.1）。现在必须**允许创建、`targetBranch` 记 null**，否则 detached HEAD 这个最典型的试验场景被挡在门外（A50）。
7. 归一化用 `resolve()` 而没走 `realResolve`：符号链接与「目录刚被删」两种情形各出一次双记录。
8. `merge` 忘了 `--no-edit`：撞上 git 的编辑器时 60 秒超时，用户看到「合并超时」而实际上什么也没发生。
9. 合并成功但 `upToDate` 没识别：UI 说「已合并」，A37/A52 去查合并提交查不到。
10. 合并锁传了 `[sourcePath, targetPath]` 而没传 `repoRoot`：与并发的「删除另一个 worktree」互踩 `.git/`。
11. `withGitLock` 内部又调了一次 `withGitLock`：死锁，表现为「创建按钮点了没反应」。
12. 启动清扫里顺手加了 `git worktree prune`：A33 直接失败（它明令禁止未确认的 prune）。
13. Step 5 忘了改 `startFresh` 的 `persist` 条件：worktree 建好了，会话不落盘、不进列表，用户以为没成功（A31 失败）。
14. 把 `worktree:changed` 的 payload 当成快照用：事件顺序与 `worktree:list` 的响应顺序无保证，界面会闪一下旧状态。
15. 「中止合并」传了当前会话的 `focusRoot` 而不是 `targetPath`：点了没反应、冲突还在，且**无任何报错**（`git merge --abort` 在无冲突的目录里也可能退出 0）。
16. 边界提示漏了负面约束那句（「不要假设你看到的就是主目录的当前状态…读文件而不是凭记忆」）：这是整段里唯一防止 agent 凭记忆行事的话，删掉后本需求立项的动机就没被覆盖（A36）。
17. 把 `needsConfirm` 实现成「必须再往返一次才能创建」：原型要求 dirty 只警示不拦截，警示框本身就是告知（§7.7）。
18. 用 `state` 表达「无关联会话」：`state` 与 `sessionCount` 正交，`ok` 的工作区完全可以是 0 会话。合成一个枚举就出现「`ok` 还是 `no-session`」的无法表达组合（§2.5 / A54）。

---

## 11. 原型（`.deva/design/worktree-parallel.html`，不纳入版本管理）与规格的一致性

### 11.1 已对齐（规格覆盖原型画出的全部状态）

| 原型元素 | 规格落点 |
|---|---|
| 面 1 五屏（默认/展开+dirty/detached 起点/安装中/安装失败） | §7.7 表格逐屏对应；§3.1（dirty）、§7.6（detached）、§3.6（安装两态） |
| 面 2 四行摘要 + 可展开原文 + 负面约束 | §1.5（含负面约束与记忆共享行）、§7.4（`cf.wt.boundary.*` 摘要文案） |
| 面 3 五种状态位 + `branch-mismatch` + 全部主进程来源 | §2.1（四态 + 判据）、§2.2（`deps` 五态）、§2.5（`sessionCount`）、§7.5（`mergeGate`）、`WorktreeView.sizeBytes/dirtyCount` |
| 面 4 四项全过 / 四项各自失败全列 / 冲突原文 / 四出口 | §4.2（全列、C4 独立）、§4.6（`checks` 协议）、§4.7（四出口，`cd` 是 targetPath） |
| 「复制 git 命令」含 `cd` | §4.7 三条硬要求 |
| 状态标记不推断 | §2.1 由主进程算、`mergeGate` 由主进程给（§7.5） |

### 11.2 规格已修正的四处（原型与初版规格冲突，现以原型为准）

| # | 冲突 | 初版规格 | 现定稿 | 影响 |
|---|---|---|---|---|
| 1 | **四项检查短路 vs 全列** | 命中即返回，只报第一个 | **四项全算完再返回，`checks` 恒 4 项** | 协议变更（`MergeResult.checks` 新增），A51 新断言 |
| 2 | **主目录 detached 时能否创建** | 直接拒绝（`primary-detached`） | **允许创建，`targetBranch: null`**，合并前须 `set-target` | 新通道 `worktree:set-target`、`PrecheckFailResult` 去掉一个 reason、A50 |
| 3 | **合并成功后是否显示结果** | 未定义 | **必须显示 + git 原文 + 合并提交短 SHA** | `MergeResult.gitOutput` 新增，§4.8，A52 |
| 4 | **`deps` 五态与「无关联会话」的关系** | `state` 四态，未提虚拟 badge | `deps` 五态**独立于** `state`；「无关联会话」= `sessionCount === 0`，**不进 `state`** | §2.5、§2.2，A54 |

### 11.3 原型未画、规格已补齐的（实现方按规格做，不需要新设计）

- **合并成功面板**（原型待定 ④）：§4.8 给出确切内容与顺序。
- **删除的 dirty 拒绝态**（原型待定 ③）：§2.6 给出文案结构与两条出路 + 勾选确认。
- **`targetBranch === null` 时的合并面板**：§4.2 的 C-1 与 §7.1 的 `set-target`。
- **`mergeGate.blocker: 'installing'`**：依赖安装中禁止合并（§7.5），原型的 installing 卡片上合并按钮是 `disabled`，正是这条。
- **主干线之外的一处取舍**：原型面 1 的路径示例保留了 `/`（`worktrees\deva\req-worktree-ui`），规格定为扁平化（`...-<shortid>`）。**按规格**，原型的路径串是示意。理由见 §6.3。

### 11.4 需要设计方跟进的（不影响实现开工）

- 原型面 3 的 `1.2 GB / 86 MB / 占用未知` 需要 `sizeBytes`，规格已加字段；但**统计磁盘占用是 IO 密集操作**（遍历目录），`worktree:list` 不能每次都算。实现时：`sizeBytes` 走**缓存 + 异步刷新**（列表先返回 `null` 显示「统计中…」，后台算完发 `worktree:changed` 再刷一次）。**这条不在 P0，属 P1**。
- 原型面 1 第②屏的「浏览…」按钮依赖 `fs:open-folder`，它会 `trustRoot` 用户选的目录——若用户只是「看一眼」也会被信任。这符合既有行为（`workspace.ts:43-51`），但值得设计方知道：**浏览 = 登记受信根**。

---

## 12. 边界胶囊（常驻输入框上方）

### 12.0 本次范围变化（先说清）

原设计（§1.5）把边界提示做成**对话流里的一条系统消息**。**该设计作废**，原因：系统消息会被后续对话冲走，用户滚到 50 条之后完全不知道自己操作的是哪个目录——而这正是本需求立项要解决的问题（「不然我不清楚这个会话的内容是否会执行在主目录」）。

新设计：**常驻胶囊 + 可展开悬浮面板**。§1.5 的系统提示词**仍然保留**（那是给模型看的），胶囊是给用户看的，两者是不同受众，不是替代关系。

### 12.1 胶囊要回答的问题，决定它必须有哪些字段

用户的诉求是一个**安全问句**：「这个会话的改动会不会落到主目录？」。所以胶囊的字段不是「worktree 信息有什么」，而是「回答这个问题需要什么」。由此得出胶囊必须有 **4 类状态**，而不是原来想的 2 类：

| 类型 | 判据 | 胶囊显示 | 为什么必须单列 |
|---|---|---|---|
| `primary` | `focusRoot` 归一化后 **等于** 该会话所在 git 仓库的 `repoRoot` | 「主目录」+ 中性点 | 改动直接落在主目录 —— 用户最该警惕的状态 |
| `worktree` | `focusRoot` 命中 `worktrees.json` 记录 | 「独立工作区」+ 强调点 + **分支名** | 改动隔离，需手动合回 |
| `subdir` | `focusRoot` 在某个 git 仓库**内**，但既不是 `repoRoot` 也不是登记的 worktree（如 `E:\deva\docs`） | 「主目录子目录 `docs`」+ **中性点** | **改动同样落在主目录里！** 这是最容易被漏掉、也最容易造成误判的一类：用户以为「我在 docs 里」，实际 `git commit` 提交的是整个主仓库 |
| `plain` | 不是任何 git 仓库（或 git 不可用） | 「普通目录」+ 灰色点，无更多信息 | 谈不上「合并回主目录」，避免显示误导性的合并入口 |

**`subdir` 是本次设计最重要的补充**。用户真实数据里就有 `E:\deva\docs`、`E:\deva\apps\desktop\src\main` 这类挂载（见 v2 的统计）。如果胶囊只区分「主目录 / worktree」，这些会话会显示成「普通目录」或「主目录」，前者丢失了「改动落在主目录」这个警告，后者显示的路径又不对。两种都是静默误导。

**判定顺序（主进程唯一计算，渲染层不做推断）**：

```
1. root = focusRoot 归一化（§6.2）；null → capsule: null（未挂载，不显示胶囊）
2. getRecord(root) 命中                          → worktree
3. git -C root rev-parse --show-toplevel 成功：
   3a. 归一化(toplevel) === root                → primary
   3b. 否则                                      → subdir（带 toplevel 与末级相对路径）
4. rev-parse 失败 / git 不可用                    → plain
```

第 3 步**必须在 `root` 里执行**（不是在主检出里），否则子目录会被判成 `primary`。git 不可用时判 `plain` 而不是报错——未装 git 的用户仍要能用会话。

### 12.2 字段差集（相对现有 `worktree:list` 快照）

**已在快照里、可直接复用**（`WorktreeView`，§7.2）：

| 字段 | 胶囊用途 |
|---|---|
| `path` | 面板里的完整路径 |
| `branch` | 胶囊主文字（worktree 类型） |
| `baseLabel` | 面板「切出自」 |
| `targetBranch` | 面板「合并目标」；`null` 时显示「未指定」并给「指定」入口 |
| `state` | 面板里的健康度提示；`branch-mismatch` 时胶囊变色 |
| `deps` / `depsDetail` | 面板里「依赖未就绪」一行（影响 agent 能否正常工作） |
| `sessionCount` | 面板里「该工作区有 N 个会话」 |
| `mergeGate` | 面板里「合并」按钮的可用性 |
| `lockHolder` | 面板里「另一个会话正在操作 git」 |

**必须新增的字段**（这些在快照里都没有）：

| 新字段 | 类型 | 含义 | 为什么不放进 `WorktreeView` |
|---|---|---|---|
| `kind` | `'primary' \| 'worktree' \| 'subdir' \| 'plain'` | §12.1 的四类 | 它是**会话视角**的分类；`WorktreeView` 是 worktree 的记录视图，一条记录永远是 `worktree`。放进 `WorktreeView` 会迫使 `primary`/`subdir` 也伪造一条记录 |
| `repoRoot` | `string \| null` | 该会话所在仓库根 | 同上。`worktree` 类已有，但 `primary`/`subdir` 也需要它来回显 |
| `repoName` | `string` | `basename(repoRoot)` | 显示用，避免每次都算 |
| `relPath` | `string` | `subdir` 类型下相对 `repoRoot` 的路径（`docs`） | 只在 `subdir` 有意义 |
| `ownDirty` | `number \| null` | **该会话工作目录自己**的未提交数（不是主目录的） | 面板要回答「我现在这堆改动在哪儿」。`WorktreeView.dirtyCount` 是 worktree 的，语义重合但不覆盖 `primary`/`subdir` |
| `primaryDirty` | `number \| null` | **主目录**的未提交数（`repoRoot` 检出） | 面板要显示「主目录还有 N 个改动」，这是 §1.5 提示词里那句「不在本区」的界面版。worktree 会话尤其需要 |
| `mergeInProgress` | `{ targetPath: string; unmergedCount: number } \| null` | 目标检出里是否有未收尾的合并 | 见 §13.4。worktree 记录里没有这个概念（合并发生在 target 上） |
| `conflictSessionId` | `string \| null` | 当前是否有针对该 target 的隐藏 AI 会话 | 见 §13.3 |

**`ownDirty` 与 `primaryDirty` 都必须是 `null` 表示「不知道」（读失败），不能是 `0`**。这条对齐仓库铁律：读失败 ≠ 没变化。UI 上 `null` 显示「—」，不显示「0 个改动」。

### 12.3 新通道 `worktree:capsule`

```ts
// 通道
'worktree:capsule'  invoke  { sessionId: string } → CapsuleSnapshot | null

export interface CapsuleSnapshot {
  /** §12.1 的四类 */
  kind: 'primary' | 'worktree' | 'subdir' | 'plain'
  /** 会话当前的工作目录（focusRoot 原值的归一化形式）。null 不会出现在这里——未挂载直接返回 null。 */
  path: string
  repoRoot: string | null
  repoName: string
  /** subdir 下相对 repoRoot 的路径，如 'docs'；其它类型为空串 */
  relPath: string
  /** worktree 类型才有；其余为 null */
  worktree: {
    branch: string
    baseLabel: string
    targetBranch: string | null
    state: WorktreeState
    deps: DepsState
    depsDetail?: string
    sessionCount: number
    mergeGate: { mayMerge: boolean; blocker?: string }
    lockHolder: { label: string; since: number } | null
  } | null
  /** 会话工作目录自己的未提交数；null = 读失败/未知 */
  ownDirty: number | null
  /** 主目录的未提交数；null = 读失败/未知。plain 类型下为 null */
  primaryDirty: number | null
  /** 目标检出里未收尾的合并（§13.4）；没有则 null */
  mergeInProgress: { targetPath: string; unmergedCount: number } | null
  /** 已有的隐藏 AI 会话 id（§13.3）；没有则 null */
  conflictSessionId: string | null
  /** 快照生成时刻，UI 用的「3 秒前刷新」 */
  at: number
}
```

**为什么新开通道而不复用 `worktree:list`**：
1. `worktree:list` 需要一个 `repoRoot` 参数，而胶囊在**会话可能不属于任何仓库**（`plain`）时也要能工作。
2. `worktree:list` 返回全部记录（个位数但仍是全量），胶囊只要一条会话相关的。
3. 胶囊的字段是**会话视角**（`kind`/`ownDirty`/`primaryDirty`/`mergeInProgress`），混进 `WorktreeView` 会让「一条记录 vs 一个会话」两个概念糊在一起。
4. 二者刷新频率不同：胶囊随 `set-focus`、`worktree:changed` 刷新；列表只在打开设置页时拉。

### 12.4 刷新时机（回答「`publishSessionsChanged()` 够不够」）

**不够，而且现在有一个确定的缺陷。**

**缺陷**：`chat:set-focus`（`chat.ts:578-589`）改完 `session.focusRoot` 后**只 `saveProject`，不调 `publishSessionsChanged()`**。对比相邻的 `chat:model-swap-apply`（`:559`）就调了。后果：
- 其它窗口 / 后挂载的视图不知道 `focusRoot` 变了；
- 胶囊若只依赖「本地 state」，用户在**成员会话**里改挂载（走 `setMemberFolder`）时，主对话的胶囊不会更新。

**必须补齐**：`chat:set-focus` 在 `session` 存在且真的改了值之后调 `publishSessionsChanged()`。**注意不要无条件调**——值未变时调用会造成无意义的全局刷新（用户在同一个目录上点两次「挂载」）。

**刷新触发矩阵**（实现时按这张表接，一条不漏）：

| 事件 | 胶囊是否重拉 | 机制 |
|---|---|---|
| 会话切换（`currentSessionId` 变化） | **是** | 渲染层 effect 依赖 `currentSessionId` |
| `focusRoot` 变化（本窗口操作） | **是** | 渲染层 `set-focus` 的 await 完成后主动重拉 |
| `focusRoot` 变化（其它窗口 / 成员会话） | **是** | `publishSessionsChanged` → 会话列表重拉 → `focusRoot` 变了 → 上面的 effect |
| `worktree:changed` | **是** | 事件订阅（deps 状态、state、targetBranch 都可能变） |
| `git:status` 类刷新（streaming 结束） | **是**（只重拉 dirty 部分） | 复用 `GitWidget.tsx:179-182` 的「streaming 由真变假时 refresh」模式 |
| 主进程启动 | **是** | 首次挂载 |
| 空闲轮询 | **否** | 不做定时轮询。胶囊不是仪表盘，用户操作的时刻才需要准 |

**`ownDirty` / `primaryDirty` 走异步两段式**：`worktree:capsule` 立即返回（`dirty` 字段填 `null`），随后后台跑 `git status --porcelain` 再发一次 `worktree:capsule-updated`（带 `sessionId` + `dirty` 字段）。理由：`status` 要遍历工作区，本仓 24 个改动 + 上万文件时几十毫秒到几百毫秒；不能让胶囊「先转圈再出现」，那会让输入框上方跳一下。**先显示胶囊骨架、数字后到**。

**明确不做**：不做 useState 之外的本地缓存（避免与主进程快照漂移，对齐 §1 的原则「状态只由主进程算」）；不在胶囊里显示 git 之外的信息（分支 ahead/behind 属于 GitWidget 的职责）。

### 12.5 `set-focus` 之后的行为（胶囊必须跟变）

`chat:set-focus` 允许改成任意目录，胶囊**必须**跟着变。三种变化的处理：

| 变化 | 胶囊行为 |
|---|---|
| `worktree` → `primary`（用户从 worktree 会话里卸挂到主目录） | 重拉后整块重绘：去掉分支名、换成中性点。**必须同时提示一次**：「本会话已从工作区 `<branch>` 切到主目录；此后改动直接落在主目录」。这是 §1.6 的确认框在成功后的补充告知——因为用户的意图可能是「临时看一眼」，而后果是永久的（会话与 worktree 的关联已断，§1.6 R14） |
| `worktree` → 另一个目录 | 同上，提示里带原分支名 |
| 任意 → `null`（卸载挂载） | 胶囊**隐藏**（返回 `null`）。不要显示「未挂载」胶囊——那会占掉输入框上方一行，而「未挂载」这个状态本身不需要警告（改动落在用户主目录，与 `plain` 的语义不同：`plain` 是「挂了一个非 git 目录」，`null` 是「根本没挂」） |

**唯一不做的跟随**：不在 `set-focus` 时**阻止**用户（§1.6 已定：不拦、只提示）。胶囊的职责是「让后果可见」，不是「替用户决策」。

### 12.6 胶囊与展开面板的信息分配

胶囊本身只能放一个短标签（输入框上方，与模型胶囊并列，宽度紧张），所以必须严格分区：

| 位置 | 内容 | 理由 |
|---|---|---|
| **胶囊（收起态）** | `worktree` → `⎇ <branch>` + 强调点；`primary` → 「主目录」+ 中性点；`subdir` → `<relPath>` + 中性点 + 一个「主目录内」后缀标记；`plain` → 「普通目录」+ 灰点 | 一屏内必须能区分「隔离」与「不隔离」 |
| **面板（展开）** | 完整路径、切出自、合并目标、`ownDirty`、`primaryDirty`、依赖状态、关联会话数、`mergeGate` 说明、出口动作 | 用户主动点开时才看细节 |
| **出口动作** | `worktree`：合并回目标 / 打开终端 / 在文件管理器打开 / 打开设置里的工作区列表；`primary`/`subdir`：打开终端 / 在文件管理器打开（**无合并**）；`plain`：同 `primary` | `plain`/`primary` 不给合并入口，否则暗示「这里有东西可合」 |

**`state` 异常时胶囊必须变色**（`branch-mismatch` / `dir-missing`）：胶囊是用户唯一常驻可见的地方，异常状态只藏在面板里等于没提示。具体：胶囊前置一个警示点，面板展开后第一行是异常说明 + 修复入口（切回分支 / 重建）。

---

## 13. 冲突处理窗口（独立 BrowserWindow）

### 13.0 本次范围变化（明确写清与 v3 的区别）

| 维度 | v3 口径 | 本次定稿 |
|---|---|---|
| 冲突解决 UI | **明确不做**「冲突解决面板、自动 resolve、自动 abort、reset --hard」 | **做**：独立窗口，可手动逐块选，也可 AI 一键起草 |
| 谁发起 | — | **用户点「处理冲突」**打开窗口。冲突发生后没有任何自动动作 |
| AI 做什么 | — | **只改冲突块的内容**。**不执行任何 git 写操作**，也不能写冲突文件之外的文件 |
| 谁完成合并 | — | **用户自己点「完成合并」**，主进程执行 `git commit` |
| 自动 resolve | 不做 | **仍然不做**：没有任何「检测到冲突就自动开窗口/自动调 AI」的路径 |
| 自动 abort | 不做 | **仍然不做** |
| `reset --hard` | 不做 | **仍然不做** |

**一句话**：v3 拒绝的是「让机器决定怎么合并」；本次提供的是「机器起草、人逐块确认、人拍板提交」。**每一个冲突块的默认值是 `pending`，没有任何一块会被默认填成某一边**（§13.6）。

**为什么从「新会话」改成「独立窗口」**（记录决策，避免后来人再走一遍）：
新会话方案的致命缺陷是 **`focusRoot` 必须指主目录**（冲突文件在那儿），于是它就是一个「长得像普通会话、但改的是你主目录」的东西。靠「标题标明」「禁用某些操作」来防误操作，是在往错误方向打补丁——**用户误操作的原因是它长得像普通会话，不是因为它没标注**。独立 `BrowserWindow` 用**空间隔离**解决：没有会话列表、没有普通输入框、关闭即有明确语义，权限边界可以用代码封死。

### 13.1 窗口形态与入口

**形态**：独立 `BrowserWindow`（**不是**主窗口的模态覆盖层）。
- 有自己的 `preload`（`merge-win-preload.ts`），**只暴露 `mergeWin.*` 一组 API**，不暴露 `window.deva` 的全部能力。这是权限边界的第一道（也是最强的一道）闸门：窗口里的任何脚本**拿不到** `git:*`、`chat:*`、`fs:*` 的通用通道。
- 独立 `session` / `partition`：不与主窗口共享渲染进程上下文。
- 尺寸：1200×840，可缩放；`minWidth 900`（两栏对比需要宽度）。
- **单实例**：同一个 `targetPath` 只允许一个窗口（再次请求 → `focus()` 已有窗口）。

**入口（唯一入口）**：合并失败面板（`conflict` 时）的第五个出口，文案是 **「处理冲突」**，不是「让 AI 试试」。

**为什么改文案**：窗口里既能手动逐块选、也能 AI 一键处理。「让 AI 试试」暗示这是 AI 专属功能，会让以为想手动解决的用户不去点。第五个出口与前四个**不平级**（前四个是「退出/查看」，第五个是「进入处理流程」），视觉上单独成区。

### 13.2 状态机

**窗口状态（渲染层状态 + 主进程事实，不落盘）**：

```
          ┌──────────────────────────────────────────────┐
打开窗口 → │ loading（拉冲突清单 + 解析冲突块）             │
          └───────────────┬──────────────────────────────┘
                          ↓
              ┌───────────────────────┐
              │ resolving            │←──────────────┐
              │ （逐块选 / AI 起草中） │               │
              └───┬───────────┬───────┘               │
      全部非pending│           │ 用户点「重新解析」/「重来」│
                  ↓           └───────────────────────┘
        ┌──────────────────┐
        │ ready-to-commit  │  所有块 resolved + 无残留标记
        └────────┬─────────┘
                 ↓ 用户点「完成合并」
        ┌──────────────────┐
        │ committing       │
        └───┬──────────┬───┘
      成功  ↓          ↓ 失败
   ┌──────────────┐  ┌────────────┐
   │ done（成功态）│  │ commit-failed│（留在窗口，显示 git 原文）
   └──────────────┘  └────────────┘
```

**主进程事实（每次现算，不落盘，§13.3 同 §5.5 的原则）**：

| 事实 | 判据 | 用途 |
|---|---|---|
| 合并是否还在进行 | `git -C <targetPath> rev-parse -q --verify MERGE_HEAD` | 窗口打开时的前置校验 |
| 还有哪些文件未解决 | `git -C <targetPath> ls-files -u`（含 stage 号） | 冲突清单的唯一真源 |
| 每个冲突文件是否仍有残留标记 | `git -C <targetPath> grep -n -E '^(<{7}|={7}|>{7})( |$)' -- <files>` | 「完成合并」前置检查（§13.7） |

#### 13.2.1 关窗的三个分支（必做）

| 分支 | 判定 | 行为 |
|---|---|---|
| **① 已完成合并** | 主进程已返回 `commit` 成功（`MERGE_HEAD` 消失） | 直接关，无提示。主窗口收到 `worktree:changed` 后刷新 |
| **② 冲突仍在，用户直接关** | `MERGE_HEAD` 仍存在 | **必须确认**，文案：<br>「合并还没完成。关掉这个窗口不会放弃合并，你随时可以从工作区的「合并进行中」入口回来继续。<br>· 已选的 N 处会丢失（未写入文件的选择不保存）<br>· 已写入文件的修改会保留」<br>按钮：`[继续处理]` `[关闭窗口]` |
| **③ AI 正在跑时关窗** | 渲染层有进行中的 AI 任务 | **先问 AI 任务怎么办**：<br>「AI 正在处理冲突（已处理 2/5 个文件）。<br>`[等它做完]` `[中止并关闭]`」<br>**中止 = 主进程 `chat:abort` 该隐藏会话**，不等它跑完（用户要关窗，不该被后台任务扣住）。中止后已写入的文件修改**保留**（不做自动回滚——自动回滚等于替用户丢工作） |

**为什么②要区分「已选的」与「已写入的」**：这是两个不同的事实，用户必须知道损失的是哪个。已选但未写入的选择只存在渲染层内存里，关窗即丢；已写入文件的修改在磁盘上，保留。这条区分直接来自 §13.6 的「立刻写回」策略（选择一旦确定立刻落盘，所以「已选」和「已写入」在实践中几乎同时发生，但**AI 起草的中间态与用户未点确认的选择**仍可能只存在于内存）。

#### 13.2.2 多冲突并行

**允许同时开多个窗口，但受两条硬约束**：

1. **同一 `targetPath` 只允许一个窗口**（§13.1 单实例）。同一 target 不可能同时有两个 `MERGE_HEAD`，所以这在 git 层面本来就成立。
2. **不同 `targetPath` 可并行**。它们各自持有 `[repoRoot, targetPath]` 锁（§5.2），互不干扰。窗口标题必须带**目标分支名**（`处理冲突 · my/dev`），否则两个窗口长得一样。

**主窗口怎么表达「有 N 个冲突处理中」**：worktree 列表里每张卡片显示 `mergeInProgress`（§12.2 / §13.9），**不需要全局横幅**——冲突是 per-worktree 的事实，全局横幅在只有一个冲突时会显得过重。

### 13.3 权限边界：三道路障（代码封死，不靠提示词）

**这是本节的安全核心。** 仓库现状（已核实）：

- `executeTool`（`tools.ts:2058`）是**唯一**工具执行入口，`try { return await run(a, ctx) }` 之前**没有任何权限闸门**。
- `run_command`（`tools.ts:1800-1806`）注释原文：「cwd 只是相对路径基准，**不是安全边界——命令执行不设任何限制**」。
- `resolvePath`（`tools.ts:723`）注释原文：「**不设任何路径限制**（2026-10-09 起）：不校验受信根，凭据目录、`~/.deva-plus`、`.git` 一律可读写」。
- 权限系统（`permissions.ts`）在这个二开版里**不存在**：全仓 `grep permissionMode` 只命中两处注释，无实现。

所以「用提示词禁止 AI 执行 git 命令」是**不可靠的**；「在 `run_command` 里用正则黑名单拦 `git commit`」同样不可靠（`git -c x=y commit`、`sh -c "..."`、`bash script.sh`、`$(printf git) commit` 都能绕过）。**黑名单在「能执行任意命令」的前提下必然漏。**

#### 路障一：渲染层 preload 白名单

窗口的 preload **只暴露**这 8 个方法，其它一概不暴露：

```ts
// merge-win-preload.ts 暴露且仅暴露
interface MergeWinApi {
  getState(): Promise<ConflictWindowState>       // 冲突清单 + 块结构 + 合并信息
  resolveHunk(req: ResolveHunkRequest): Promise<HunkResult>
  resolveWholeFile(req: ResolveFileRequest): Promise<FileResult>
  aiRun(): Promise<{ ok: boolean; reason?: string }>
  aiAbort(): Promise<{ ok: true }>
  onProgress(cb: (p: AiProgress) => void): () => void
  finishMerge(): Promise<FinishMergeResult>
  restoreFile(req: { relPath: string }): Promise<{ ok: boolean; message?: string }>
}
```

**没有 `git.*`、没有 `chat.*`、没有 `fs.*`、没有 `config.*`。** 窗口里跑的任何脚本都无法执行 git 命令或读写任意文件——它只有这 8 个经过主进程校验的方法。

#### 路障二：主进程只注册 `merge-win:*` 一组通道

新增的 IPC 全部使用 `merge-win:` 前缀，与既有 `git:*` 完全分开（**不复用 `git:merge-abort` 等通道**，因为那些通道接受任意 `dir` 参数，等于给了窗口一个通用的 git 执行入口）。

| 通道 | 作用 | 校验 |
|---|---|---|
| `merge-win:state` | 拉状态 | 用窗口的 `targetPath`（主进程持有，不信渲染层） |
| `merge-win:resolve-hunk` | 选一处冲突 | 校验 `hunkId` 属于当前解析结果；校验目标文件仍在冲突集内 |
| `merge-win:resolve-file` | 整文件选一边 | 同上 |
| `merge-win:ai-run` / `merge-win:ai-abort` | 起/停 AI | — |
| `merge-win:finish` | 完成合并 | §13.6.2 六条前置 + §13.7 动作 |
| `merge-win:restore-file` | 恢复单文件到冲突态 | 校验文件在冲突集内 |

**关键**：所有通道的 `targetPath` 由**主进程在开窗时记录**，**不接受渲染层传入**。渲染层只能传「哪个 hunk」「哪个 relPath」这类**相对标识**，主进程自己拼绝对路径。这样即使窗口被 XSS 或恶意脚本控制，也无法指向别的目录。

#### 路障三：AI 隐藏会话的工具集收窄

AI 仍然走 `agent-loop`（不重写整条链）。载体是一个**不出现在左侧列表的会话**。

**隐藏方式的选择（需实现时核实，给两个候选）**：

| 方案 | 做法 | 风险 |
|---|---|---|
| **A（推荐）复用 `parentId`** | 给会话设一个 `parentId`（指向一个内部占位 id）。渲染层 `store/chat.tsx:1078` 用 `filter(!s.parentId)` 过滤，天然不进列表 | `parentId` 的语义是「成员会话」。用它承载冲突会话会在 `chat-members.ts` 的成员逻辑里被当成成员（如 `memberFolder`、成员提示词注入）。**必须核实**：该会话不经过 `chat-members` 的任何一处分发，否则会被套上成员人格/职责提示词 |
| **B 新增 `hidden: true` 标记位** | 会话加字段，`store/chat.tsx:1078` 的过滤加上 `&& !s.hidden` | 要改会话类型、索引、以及**所有**列举会话的地方（`scanSessionsByModel`、任务绑定、导出…）。风险是漏一处就泄漏进某个列表 |

**定稿：优先 A，但必须先验证。** 验证方法（实现时必做）：
1. 造一个 `parentId` 非空的会话，确认它不出现在左侧列表（`store/chat.tsx:1078` 的过滤生效）。
2. 确认对它调用 `runTurn` 时**不会**走 `chat-members.ts` 的成员提示词分支（`chat-prompts.ts:158-170` 的 `memberSystemPrompt`）。若会走，则 A 不可用 → 改用 B。
3. 确认它不参与 `chat:model-swap-scan`（`chat.ts:541`）等批量操作，或者参与也不影响（它本来就是临时的）。

**若 A 不可用而走 B**，则 `hidden` 字段的**完备清单**是：`chat-store.ts` 的类型与索引、`chat.ts` 的所有 `listSessions` 出口、`scanSessionsByModel`、渲染层 `store/chat.tsx:1078`、以及 `Rail.tsx` 的任何直接读 `sessions` 的地方。**漏一处 = 隐藏会话泄漏进用户列表**，这是 B 方案的主要成本。

**工具集（硬性，不可配置）**：

```ts
// 冲突处理 AI 会话的工具白名单 —— 用「只提供这些」代替「禁止那些」
const MERGE_AI_TOOLS = [
  'read_file', 'glob', 'grep', 'list_dir',
  'edit_file', 'write_file',
  'todo_write'
] as const
```

**不含 `run_command`** → 没有执行 git 的入口，不需要「禁止 git commit」。这是唯一可靠的实现方式：**「跑命令」这个能力不存在，就没有绕过黑名单的问题。**

**`ToolContext` 的收窄字段**（本需求新增）：

```ts
export interface ToolContext {
  // …既有字段…
  /**
   * 会话级写入白名单：存在时，write_file / edit_file 的目标必须落在其中某个根内。
   * 只有冲突处理 AI 会话会传（= [targetPath]）。其它会话不传 → 行为与现在完全一致（零回归）。
   */
  writeRoots?: string[]
  /** 会话可用工具白名单：存在时，executeTool 对不在名单内的一律拒绝。 */
  allowedTools?: string[]
}
```

**两道校验的落点**：

| 校验 | 落点 | 说明 |
|---|---|---|
| 工具白名单 | `executeTool`（`tools.ts:2058`）第 2065 行之后、`run(a, ctx)` 之前 | `if (ctx.allowedTools && !ctx.allowedTools.includes(name)) return { content: '本会话不可用该工具', summary: '已拒绝', isError: true }` |
| 写路径白名单 | `write_file`（`:1702`）/ `edit_file`（`:1721`）拿到 `abs` 之后、写盘之前 | 用 `isWithinDir`（`fs-guard.ts:118`）+ `realResolve`；越界返回 `isError` |

**为什么必须两道**：工具白名单挡不住「`write_file` 写 `~/.deva-plus/config.json`」——因为 `write_file` **在**白名单里。而 `resolvePath` 现在完全不设限（上面已引注释原文），所以写路径白名单是独立的、必需的第二道。

**读路径不限制**：AI 需要读 source 侧的代码对照、读 `AGENTS.md`、读项目记忆——这些都在 `targetPath` 之外。拦了它没法工作。

**隐藏会话的 `focusRoot`**：**由主进程写死为 `targetPath`**，渲染层不得指定（否则可以用任意 `focusRoot` 开一个「冲突处理会话」，拿到一个无 `run_command` 但能写该目录的会话——这是提权）。同时 `writeRoots: [targetPath]` 让它的写能力**比普通会话更窄**：

| 会话类型 | `run_command` | 可写范围 |
|---|---|---|
| 普通会话 | 有（无任何限制） | 任意路径（`resolvePath` 不设限） |
| 冲突处理 AI 会话 | **无** | 仅 `targetPath` 内 |

**明确不做**：不给它开 `run_command` 后再用正则拦（前面已论证必漏）；不给它「只读」模式（只读就无法解决冲突，自相矛盾）；不改 `resolvePath` 的全局语义（会影响所有既有会话，属另一个议题）。

### 13.4 冲突块的数据模型

#### 13.4.1 解析方式：解标记，不用 `git diff`

**结论：解析工作区文件里的冲突标记。不用 `git diff` 还原。**

理由（三条，按重要性）：

1. **`git diff` 不直接给「块」。** `git diff` 的输出是行级差异，要还原成「一对 ours/theirs 块」需要自己做匹配，而 git 已经把它做完了并写进文件里。**文件里的标记就是 git 的匹配结果**，这是最权威、最省事的数据源。
2. **`git diff` 在重命名/模式变更下形态完全不同**（`similarity index`、`rename from/to`、`old mode/new mode`），而这类冲突根本不能逐块选（§13.5 整文件处理）。用 `git diff` 解析会让「能逐块选的」与「不能的」混在同一套逻辑里。**实测确认**：rename/rename 场景下 `git status --porcelain` 与 `ls-files -u` 都可能是空的（git 把两侧改名都当作已合并），此时只能靠 `kind: rename` 的整文件处理，逐块解析无从谈起。
3. **文件是用户最终要提交的东西**。我们改的是文件，校验的也是文件。以文件为准，闭环最短。

**解析规则**（`main/services/worktree/conflict-parse.ts`）：

```
逐行扫描，状态机：normal → ours → base? → theirs
标记行（必须从行首开始，且标记后是空格或行尾）：
  /^<{7}( |$)/      → ours 段开始
  /^\|{7}( |$)/     → base 段开始（仅 diff3 / zdiff3 样式）
  /^={7}$/          → theirs 段开始
  /^>{7}( |$)/      → 块结束
```

**必须支持 `diff3` 与 `zdiff3`**（`|||||||` 段）。**实测确认三种样式的形态**（本机 git 2.x）：

| `merge.conflictStyle` | 实际写进文件的结构 |
|---|---|
| `merge`（默认） | `<<<<<<< HEAD` / `=======` / `>>>>>>> <branch>` —— **无 base 段** |
| `diff3` | `<<<<<<< HEAD` / `||||||| <sha7>` / `=======` / `>>>>>>> <branch>` —— **有 base** |
| `zdiff3` | 与 `diff3` 同构（差异只在「公共前后缀被提到标记外」，标记本身不变） |

**关键决定：解析器必须处理 `|||||||`，且 `base` 字段可选。** 用户在 `~/.gitconfig` 里设了 `diff3` 是个很常见的选择（很多人为了看原版），而**我们的窗口读取的是他的工作区文件**——他设了 diff3，文件里就有 `|||||||` 段。解析器不支持就会把 base 段误当成 ours 内容，写出错误的文件。

**不要**为了简化而在 merge 时强制 `merge.conflictStyle=merge`：那会覆盖用户的配置习惯，而且 `git merge` 在冲突发生的那一刻就写好了文件，**窗口打开时文件已经定型**，改不了。

#### 13.4.2 `ConflictHunk` 的完整定义

```ts
/** 一个冲突块。id 在该文件内稳定（见「行号漂移」）。 */
export interface ConflictHunk {
  /** `h:<relPath>:<块起始行号>:<块序号>` —— 见 13.4.4 的漂移处理 */
  id: string
  /** 相对 targetPath 的路径（统一 / 分隔）。主进程自己拼绝对路径，渲染层拿不到绝对路径。 */
  relPath: string
  /** 块在**当前文件**里的起止行（1 起，含起止；仅用于展示与重新解析比对，不用来写回） */
  startLine: number
  endLine: number
  /** 主目录（target 检出）那一侧；对应 `<<<<<<<` 之间的行 */
  ours: string[]
  /** worktree 那一侧；对应 `=======` 与 `>>>>>>>` 之间的行 */
  theirs: string[]
  /** diff3/zdiff3 才有；对应 `|||||||` 与 `=======` 之间的行 */
  base?: string[]
  /** 两侧的标签（`<<<<<<<` 与 `>>>>>>>` 后面那串），仅供展示 */
  oursLabel: string
  theirsLabel: string
  /** **默认必须 pending**，不得预填任何一边（§13.6） */
  resolution: 'pending' | 'ours' | 'theirs' | 'both'
  /** resolution === 'both' 时的最终内容（用户编辑或自动拼接） */
  merged?: string[]
}

/** 一个冲突文件。 */
export interface ConflictFile {
  relPath: string
  /** `git status --porcelain -z` 的 XY 码，如 'UU' / 'AA' / 'UD' / 'DU' / 'DD' / 'AU' / 'UA' */
  xy: string
  /** 冲突类型，由 xy 与 stage 情况推出（§13.5） */
  kind: 'text' | 'binary' | 'add-add' | 'modify-delete' | 'delete-modify' | 'both-delete' | 'rename'
  /** kind === 'text' 时非空；其它类型为空数组 */
  hunks: ConflictHunk[]
  /** kind !== 'text' 时的整文件选择 */
  fileDecision: 'pending' | 'keep-ours' | 'keep-theirs' | 'keep-deleted'
  /** 是否检测到二进制（含 NUL 字节，或 git 认为是 binary） */
  binary: boolean
}
```

#### 13.4.3 「用哪一边」的语义映射（ours/theirs 谁是谁）

**这是最容易搞错、错了就静默丢改动的一点。**

实测确认（`git ls-files -u` 的 stage 号 + 文件标记）：

| 标记 | 含义 | 对应 |
|---|---|---|
| `<<<<<<<` 之后到 `=======` 之前 | **ours** | **target 检出当前的 HEAD**（= 主目录那一侧，= `targetBranch`） |
| `=======` 之后到 `>>>>>>>` 之前 | **theirs** | **被合并进来的提交**（= worktree 分支那一侧，= `frozenSha`） |
| `|||||||` 之后到 `=======` 之前 | base | 共同祖先（merge-base） |
| stage `1` / `2` / `3` | base / ours / theirs | 同上 |

**为什么必须写清**：`ours` / `theirs` 这两个词在「我在合别人的分支」时直觉上会反——用户以为「ours 是我的 worktree」，实际 `ours` 是**主目录**。所以窗口 UI **不使用 ours/theirs 这两个词**，而是用：

- 左栏：「主目录（`<targetBranch>`）」
- 右栏：「工作区（`<sourceBranch>`）」

这也正是「两栏对比」结构的价值（§13.4.5）。

#### 13.4.4 写回策略：立刻写，用「重新解析」对抗漂移

**结论：每选完一块立刻写回文件，然后重新解析该文件。**

理由：
1. **关窗/崩溃的损失最小**。全部选完统一写的话，用户做了 20 个选择、关窗时丢 20 个。立刻写只丢最后一个未确认的。
2. **「已选」与「文件内容」始终一致**。统一写会让渲染层的选择与磁盘内容分叉，而「完成合并」检查的是**磁盘内容**（§13.7）。分叉 = 检查通过但文件没改。
3. **用户能立刻看到结果**。选完一块，文件就变了；下次打开编辑器/查看 diff 看到的就是真实状态。

**代价：行号漂移。** 写回一块后，后面的块行号全变。处理方式：

```
1. 每次写回后，用 merge-win:state 的增量路径**重新解析该文件**
2. 重新解析得到的块，按「块在该文件内的序号」与「id」重新对上：
   - id 格式 `h:<relPath>:<块序号>`（不含行号 → 行号变了 id 不变）
   - 用「已选过的块」的 id 集合 + 其 resolution 值，回填到新解析结果上
3. 若重新解析后块数变少（用户的选择让两个块合并了），说明有块的边界消解——
   把消失的块视为已解决（它的选择已写入文件），只保留仍存在的块的 resolution
```

**id 不含行号是刻意的**：含行号的话，写第一块就把后面所有块的 id 变了，已选状态全部对不上。**用「块序号」+ `relPath` 唯一即可**（同一文件内序号稳定；跨文件靠 `relPath`）。

**边界情况（必须处理）**：用户在窗口开着的时候，用外部编辑器改了同一个文件（或 AI 在跑）。此时重新解析的结果可能与他看到的完全不同。判据：写回前记下该文件的 `mtime + size + sha256`，写回时再算一次，**不一致则拒绝并提示「该文件已被外部修改，请重新加载」**。不让窗口用陈旧的内存状态覆盖外部改动。

#### 13.4.5 两栏对比 + 三选一（不做三栏）

**结构**（用户已定稿）：

```
┌─────────────────────────────────────────────────┐
│ 第 2 处，共 3 处                        ● ● ○   │
├──────────────────────┬──────────────────────────┤
│ 主目录（my/dev）      │ 工作区（deva/ui）         │
│ <ours 内容>           │ <theirs 内容>             │
├──────────────────────┴──────────────────────────┤
│  [ 用主目录的 ]  [ 用工作区的 ]  [ 两个都要 ]      │
└─────────────────────────────────────────────────┘
```

**「结果」栏只在选了「两个都要」时出现且可编辑。**

**为什么不做三栏（base 段不单独成栏）**：三栏默认了「两份代码要对比」这个认知模型，而用户实际面对的决策是「**同一处有两个版本，选一个**」。base 段的信息价值是「帮我判断该选哪个」，它应该作为**上下文提示**（灰色的「原始版本」折叠行）出现在两栏下方，而不是占据第三栏的视觉权重。

**`base` 有值时**（用户设了 diff3）：两栏下方给一行可折叠的「原始版本（共同祖先）」，默认收起。**`base` 无值时**（默认 merge 样式）：不显示这一行，也不要提示「没有原始版本」——那是噪音。

#### 13.4.6 「两个都要」是主路径

**最常见的真实冲突是两边改了同一个函数的不同部分**，这时两个单选项都不对。所以：

| 方面 | 定稿 |
|---|---|
| `merged` 怎么产生 | **默认自动拼接 `ours + theirs`**（ours 在前），但**用户必须能编辑**。不默认拼接的话，用户要手打全部内容；默认拼接能给一个可用的起点 |
| 写回内容 | `merged` 的行数组，原样拼成文本（保留每行自己的换行风格，见下） |
| 写回后验证 | **必须**扫残留标记（§13.7 同一判据），且**必须**验写盘成功（`writeFileAtomic` 的返回/异常） |

**换行风格**：从**原文件的主导换行**（CRLF vs LF）决定，不逐行猜。既有 `dominantEol`（`tools.ts:1710` 用过）就是这个用途，直接复用。**不做逐行保留**——混合 EOL 的文件本来就有问题，我们不该把它放大。

**`merged` 里允许用户写入任意内容**（包括再写出 `<<<<<<<`）：**不阻止，但写回后会被残留检查抓到并拒绝完成合并**。用户若真要提交一个含 `<<<<<<<` 的文件（极少但合法，比如写文档描述冲突），唯一路径是绕开本窗口手动操作——**这符合「机制只管冲突标记消不消失」的责任边界**。

### 13.5 非文本冲突：整文件选边

#### 13.5.1 状态码与类型（实测确认）

**`git status --porcelain` 的 XY 码**（实测：`AA` / `UU` / `D ` 等形态已在本机确认）：

| XY | 含义 | 本窗口的 `kind` | 可用操作 |
|---|---|---|---|
| `UU` | 双方都修改 | `text`（能解析出块 → 逐块选；解析不出块 → 退化为 `binary`/整文件） | 逐块三选一；或整文件选边 |
| `AA` | 双方都新增（同一路径） | `add-add` | **整文件选边**：保留主目录版 / 保留工作区版 / 两边都删 |
| `UD` | 我方修改、对方删除 | `modify-delete` | 保留主目录版（= 保留改动）/ 接受删除 |
| `DU` | 我方删除、对方修改 | `delete-modify` | 接受删除 / 保留工作区版（= 保留对方改动） |
| `DD` | 双方都删除 | `both-delete` | 只有一个选项：接受删除 |
| `AU` / `UA` | 一方新增、另一方未变（罕见） | 按 `add-add` 处理 | 同上 |
| `UU` 且含 NUL 字节 / git 判为 binary | 二进制冲突 | `binary` | **整文件选边**（无内容预览，只显示大小与 hash） |
| 涉及 rename | `git ls-files -u` 的 stage 组合体现 | `rename` | **整文件选边**（无法逐块：改名后的两侧路径不同） |

**实测确认的 stage 语义**（`git ls-files -u` 输出）：stage `1`=base、`2`=ours、`3`=theirs。`AA` 场景**没有 stage 1**（没有共同祖先），只有 `2` 和 `3` —— 这可以用来区分「新增冲突」与「修改冲突」，比只看 XY 码更准。

**判定顺序**（主进程算，`kind` 只由主进程给）：

```
1. xy === 'DD'                       → both-delete
2. xy === 'UD'                       → modify-delete
3. xy === 'DU'                       → delete-modify
4. xy === 'AA' | 'AU' | 'UA'         → add-add
5. stage 组合显示 rename              → rename
6. 二进制（NUL 字节 或 git 判 binary） → binary
7. 能解析出 ≥1 个块                    → text
8. 其余（既非二进制也无块）             → binary（保守：不给逐块选，只能整文件选边）
```

**第 8 条是刻意的保守**：`UU` 但解析不出块（例如只有 submodule 指针变化、或文件被外部改掉了标记），**不能当成「没有冲突」**，而应退化成整文件选边。**空集合落到保守分支，不落到成功**（§6.5 的自查原则）。

#### 13.5.2 界面怎么表达「这个文件没法逐块选」

文件列表里该行显示：
- 类型标签：`新增冲突` / `删除/修改` / `二进制` / `重命名`
- **不显示块数**（那会暗示可以逐块点）
- 打开后是**整文件选边面板**，顶部一行说明为什么不能逐块选：

```
这个文件无法逐块选择：双方都新增了同一路径（AA）。
请整体选择保留哪一份。
```

- 二进制的选边面板**不给内容预览**，只显示：两侧的字节大小 + 短 sha。理由：把二进制当文本渲染会乱码，渲染成 hex 也没有决策价值。
- **有一类特殊情况必须给出口**：文件在 `targetPath` 里但被 git 判 binary（比如 `.docx`）。用户在窗口里选不了内容层面的合并，此时给「在文件管理器打开两侧文件」的按钮——让用户用外部工具合并，回来再选边。

### 13.6 「未解决」是默认，且挡住完成合并

#### 13.6.1 三个硬约束

1. **每个冲突块的 `resolution` 初始必须是 `'pending'`。**
2. **每个非文本冲突文件的 `fileDecision` 初始必须是 `'pending'`。**
3. **存在任一 `pending`（块或文件）时，「完成合并」按钮必须禁用**，并显示还差多少（「还有 2 处未选择」）。

**绝不允许把「结果」预填成任何一边。** 这一条的理由来自我们这几轮一直在修的同一类 bug：**`ok: true` 但数据没落盘 / 界面说成功但东西没生效**。把默认值填成 ours，用户一路点下去，`theirs` 的改动**静默消失**，而界面看起来一切正常、合并成功、`ok === true`。这是本需求里最容易发生、后果最严重（丢用户代码）的静默错误。

**同理禁止**：「默认为 ours 但标个黄点提示」「AI 起草后自动把 pending 填成 AI 的结果」。AI 起草的产出必须**仍然以 pending 呈交用户逐块确认**（§13.8）。

#### 13.6.2 「完成合并」的完整前置条件（六条，全部必须满足）

按执行顺序，任一失败即拒绝并给出具体原因：

| # | 条件 | 判据 | 失败时 |
|---|---|---|---|
| **1** | 合并仍在进行 | `git -C <targetPath> rev-parse -q --verify MERGE_HEAD` 退出码 0 | `not-merging`：可能已在终端完成或中止 → 刷新状态 |
| **2** | **没有任何 `pending` 块 / 文件** | 渲染层提交的选择集里 `pending` 计数为 0；主进程**再按自己的解析结果核一遍**（不信渲染层） | `pending-remaining`：回未解决清单 |
| **3** | 所有冲突文件都已成功写盘 | 每个被选择过的文件：写盘返回值 + `stat` 的 size/mtime 变化 + 内容 hash 与预期一致 | `write-failed`：**这是数据安全问题，必须拦住**。不拦就会「提交了一份没写进去的文件」 |
| **4** | 无残留冲突标记 | 两道判据都要过：<br>**4a** `git -C <targetPath> ls-files -u` 输出为空<br>**4b** `git -C <targetPath> grep -n -E '^(<{7}|={7}|>{7})( |$)' -- <冲突文件集>` 退出码为 **1**（0=找到=拒绝、1=没找到=通过、>1=出错=拒绝） | `markers-remain`：回文件名+行号；`>1` 按 `error` 处理，**不得当成通过** |
| **5** | 目标检出仍干净（除冲突文件外） | `git -C <targetPath> status --porcelain` 里，**除冲突文件集之外**不应出现新的非冲突改动 | 不阻断，但返回 `extraChanges`，UI 提示「本次提交只包含合并的文件，另有 N 个改动未提交」 |
| **6** | 内容已复核 | 渲染层记录用户是否展开过 diff/逐块面板 | 不满足则按钮**禁用**（见下） |

**条件 4a 与 4b 为什么都要（本次实测的关键结论）**：

| 场景 | `ls-files -u` | `git grep` 标记 | `git diff --check`（原方案） | 结论 |
|---|---|---|---|---|
| 冲突未处理 | 非空 | 找到 | 找到 | 都拦得住 |
| 已 add + 标记残留（AI 改砸后 `git add` 过） | **空** | **找到** | **`--check` 漏检（exit 0）**；`--check --cached` 能抓到 | **只有 4b 能抓** |
| 标记在同一行被 `=======` 之外的前缀包裹（如 `x <<<<<<<`） | 空 | **找不到**（行首锚定） | 找不到 | 都抓不到 → 属「不是 git 生成的标记」，不拦（合理） |
| 未跟踪的新文件含标记 | **不出现** | 需靠 `--untracked`；默认 `git grep` 不搜未跟踪 | **抓不到**（不在任何 diff 里） | 见下方说明 |

**实测数据（本机 git 2.x，逐条跑过）**：
- `git diff --check`（冲突态未 add）：`f.txt:2/4/6: leftover conflict marker`，**exit 2**。
- `git add` 之后再跑 `git diff --check`：**exit 0（漏检！）**。
- `git diff --check --cached`：能抓到，**exit 2**。
- `git grep -n -E '^(<{7}|={7}|>{7})( |$)' -- f.txt`：有标记 **exit 0**、无标记 **exit 1**。
- **二进制冲突实测**：文件里**没有任何冲突标记**（`git` 直接留了 ours 的内容），`git grep` **exit 1（判为通过）**。→ **证明只靠标记检查不足以判定二进制冲突已解决**，必须靠 `ls-files -u`（4a）拦住它。

**所以定稿：4a + 4b 双判据，且二进制/非文本冲突只能靠 4a。** 原方案的 `git diff --check` **不再使用**——它在「已 add」后会漏检，而「已 add」正是 AI 处理完的典型状态。

**未跟踪文件含标记**：不在冲突文件集里（它不在 `ls-files -u`），因此本窗口不负责它。**明确不做**：不去扫描工作区里的每个文件——那会把用户本来就含 `<<<<<<<` 的文档（如 Markdown 教程）误报成冲突。

#### 13.6.3 条件 6「内容已复核」的实现

「完成合并」按钮的可用性 = 条件 1-4 满足 **且** 用户已展开过每个文件的 diff 或逐块面板（一次即可，不要求逐块点击）。

**为什么要这一条**：这是「人复核」这一步的唯一强制点。不强制的话，AI 起草完 → 用户直接点完成 → 等于自动 resolve，回到 v3 明确要避免的状态。

**但也不做过度强制**（不要求用户滚动到每个块底部、不要求逐块停留若干秒）——那会把「复核」变成形式主义的点击负担，用户会养成「一路点过去」的习惯，反而更糟。

### 13.7 完成合并的动作

```ts
'merge-win:finish'  invoke  (无参)  → FinishMergeResult
// targetPath 由主进程持有，渲染层不传
```

**动作序列**：

```
1. 前置六条件（§13.6.2），任一失败即返回
2. git -C <targetPath> add -- <冲突文件集>      ← 只 add 冲突涉及的文件
3. git -C <targetPath> commit --no-edit
4. 校验：MERGE_HEAD 消失 ∧ HEAD 有两个 parent
5. 清 conflictSessionId（若 AI 用过）+ publishSessionsChanged + worktree:changed
6. 返回 { ok:true, mergeCommit, gitOutput }
```

| 决定 | 选择 | 理由 |
|---|---|---|
| `git commit` vs `git merge --continue` | **`git commit --no-edit`** | **实测确认**：在 `MERGE_HEAD` 存在、冲突已 add 的仓库里执行 `git commit --no-edit`，退出码 0、不打开编辑器、生成的提交**有两个 parent**（`parents=<A> <B>`），且 `MERGE_HEAD` 随之消失。`merge --continue` 除了多一层内部调用没有额外价值，且在某些 git 版本上会尝试拉起编辑器 |
| 是否 `--no-verify` | **不用**（会跑钩子） | 用户的 `pre-commit` 钩子（lint、格式化、检查密钥）必须生效。**跳过钩子等于绕过用户自己的质量门**。代价：钩子失败时合并无法完成 → 返回 `commit-failed` + git 原文 + 出口「在终端打开」（用户在终端里 `--no-verify` 是他自己的决定，不由我们替他做） |
| 是否 `add -A` | **不用** | **这是最严重的数据事故入口**：`-A` 会把用户在 `targetPath` 里的所有未提交改动一起提交进合并提交。本仓主目录常态 24 个未提交文件——一次「完成合并」会吞掉全部工作 |
| 提交信息 | **默认用 git 已有的**（`.git/MERGE_MSG` 里 `Merge branch 'x' into y`） | `--no-edit` 就是取它。**允许用户改**：窗口底部给一个可编辑的提交信息框（默认填 `MERGE_MSG` 的内容），用户改了则以用户为准（`git commit -F -` 从 stdin 喂）。**不做「强制用户确认信息」**——那是无意义的确认步骤 |

**成功后窗口的行为**：**不自动关闭**，进入 `done` 成功态：

```
✓ 已合并到 my/dev
  合并提交 3f9a2c1
  [查看提交]  [关闭窗口]
  [可展开] git 的输出（原样）
```

理由同 §4.8：用户需要核验（A37/A52 要查合并提交），自动关闭会让「刚才发生了什么」无从追溯。

### 13.8 AI 一键处理流程

#### 13.8.1 一次处理全部，还是逐块

**一次处理全部文件，但产出必须逐块呈交用户确认。**

| 方面 | 定稿 |
|---|---|
| 调用粒度 | **一次会话、一轮内处理全部冲突文件**（不是一次一块） |
| 理由 | 冲突文件之间常有逻辑关联（改了接口就要改调用方）。逐块调用会让 AI 失去整体视角，且 N 次调用 = N 次上下文装载，慢且贵 |
| 产出形态 | AI 用 `edit_file`/`write_file` **直接改文件**（消除标记），**不改「选择」**。改完后窗口重新解析，把解析结果显示成**每个块的具体内容**，`resolution` 仍为 `pending` |
| 用户的动作 | 逐块看「AI 的结果」并点确认（`用主目录的` / `用工作区的` / `两个都要`+编辑 / **`采用 AI 的结果`**） |

**关键：AI 产出后 `resolution` 仍是 `pending`，不自动算作已解决。** 理由见 §13.6.1——自动填成「已解决」就是自动 resolve。

**界面呈现（用户复核的唯一依据）**：AI 起草完成后，每个块的三栏/三选项旁显示「AI 建议」标记，点开后是 AI 对该块的处理结果（对比 ours/theirs），用户可以：
- `采用 AI 的结果`（把 AI 写进文件的内容作为该块的 `merged`，置 `resolution: 'both'`）
- 或选 ours / theirs 覆盖 AI 的写法

**必须显示「AI 改了什么」的 diff**：不给 diff，用户无法复核。落点：每个文件一行「AI 修改了 N 处（+X −Y 行）」，点开是 `git diff -- <file>` 的原文（**在 AI 改之前记一个快照，改之后算 diff**）。快照复用会话的 checkpoint 机制（`checkpoints.ts`，AI 的每次 `write_file`/`edit_file` 都会备份原文件）——**这是现成能力，不要另造**。

#### 13.8.2 残留标记检测（AI 自称解决了）

**不信 AI 的话，只信 git 的输出。** 判据与 §13.6.2 的条件 4 完全相同（4a + 4b），在 AI 跑完后**立刻**执行一次：

| 结果 | 窗口显示 |
|---|---|
| 4a 空 ∧ 4b exit 1 | 「AI 已消除全部冲突，请逐块确认」→ 进入待确认 |
| 4a 非空 | 「AI 处理后仍有 N 个文件未解决：<清单>」+ `[让 AI 继续]` `[手动处理]` |
| 4a 空 ∧ 4b 找到标记 | 「还有冲突标记残留（<文件>:<行>）」+ 同上两个按钮 |
| 有二进制/非文本冲突 | 明确说「AI 无法处理二进制冲突，请整体选边」 |

**绝不允许**：AI 说「已解决」就当已解决；AI 跑了但没检查就显示成功。

#### 13.8.3 失败、超时、会话挂了

| 情况 | 窗口显示 | 文件状态 |
|---|---|---|
| AI 报错（工具失败、模型错误） | 「AI 处理失败：<原因>」+ `[重试]` `[手动处理]` | 已改的保留（不自动回滚） |
| AI 超时（默认 5 分钟无进展） | 「AI 处理超时」+ `[查看它做到哪一步]` `[中止]` `[手动处理]` | 同上 |
| 用户点中止 | 「已中止」+ `[重新开始]` `[手动处理]` | 同上 |
| 隐藏会话被外部删掉 | 「AI 会话已不存在」+ `[重新开始]` | 同上 |
| AI 跑完但没改任何文件 | 「AI 未产生改动」+ `[重试]` `[手动处理]` | 不变 |

**统一原则：任何 AI 失败都不自动回滚文件。** 回滚 = 丢掉 AI 已经做对的部分，而用户可能想接着手工改。想回退的路径是显式的（§13.8.4）。

#### 13.8.4 用户不满意怎么回退

**两条粒度，都要有**：

| 粒度 | 命令 | 实测确认 |
|---|---|---|
| **单文件回到冲突初始态** | `git -C <targetPath> checkout --merge -- <relPath>` | **实测有效**：把已被改成 `WRECKED-BY-AI` 的文件恢复到带冲突标记的初始态，`ls-files -u` 恢复为 3 条，退出码 0，输出 `Recreated 1 merge conflict`。**即使已经 `git add` 过也能恢复**（实测：add 后再 `checkout --merge` 同样成功回到冲突态）。<br>**但有一个必须写进 UI 的细节**：恢复后的标记标签会从 `<<<<<<< HEAD` / `>>>>>>> other` 变成 `<<<<<<< ours` / `>>>>>>> theirs`（git 不保留原始标签）。**内容与结构完全一致，仅标签文字不同**——解析器按标记前缀匹配，不受影响；但用户如果对比过之前的截图会看到差异，需要在 UI 里说明一句「恢复后标记文字可能变为 ours/theirs，内容不变」 |
| **整体放弃合并** | `git -C <targetPath> merge --abort` | 用户明确要求时才执行（第五个出口之外的一个独立入口，需二次确认） |

**另外一条不依赖 git 的保底**：会话 checkpoint（`checkpoints.ts`）记录了 AI 每次 `write_file`/`edit_file` 前的原文件。若 `checkout --merge` 因为某种原因不可用（比如文件已从 git 索引里消失），可用 checkpoint 回滚到 AI 动手之前的状态。**这是第三条路，不是主路径**——`checkout --merge` 才是（它恢复的是**冲突初始态**，语义更准）。

**AI 处理的结果要能「只回退 AI 的改动，保留我手动选的」**：做不到，也不做。原因：文件里 AI 的改动与用户的选择已经混在一起，逐行归因需要一个影子版本库，成本远超收益。**给一句话说清**：「回退会把这个文件恢复成冲突初始态，你和 AI 在这个文件上的所有选择都会丢失」。

### 13.9 手动改的写入策略（与 AI 共用的底层）

手动逐块选与 AI 起草**共用同一套写回逻辑**（`conflict-parse.ts` 的 `applyResolution`），避免两条写入路径：

```
applyResolution(relPath, hunks: ConflictHunk[]) → { ok, bytes, sha256 }
  1. 重新读文件（拿真实当前内容，不用内存里的旧内容）
  2. 核对 mtime+size+sha256 与内存记录一致 → 不一致则拒绝（外部已改）
  3. 按块序号从小到大重放：
       把该块的 [startLine, endLine] 区间替换为 resolution 对应的行
       未 resolved 的块保持原样（含标记）
  4. 换行风格：dominantEol(原文件)
  5. writeFileAtomic(relPath, out)
  6. 回读校验：sha256(out) === sha256(磁盘)  → 不一致则报 write-failed
```

**必须「重新读文件」而不是用内存旧内容**：AI 可能刚改过、用户可能在编辑器里改过。用旧内容写回 = 覆盖别人的改动（这是最典型的静默数据丢失）。

**「未 resolved 的块保持原样（含标记）」**：这让「选了一部分就关窗」的状态是自洽的——文件里既有已选的干净内容，也有未选的标记块。下次打开窗口能重新解析出这些标记块，`git ls-files -u` 也仍非空（不会误判为已解决）。

### 13.10 与既有设计的关系

| 既有条目 | 变化 |
|---|---|
| §4.7 失败出口 | **四个变五个**。第五个是「处理冲突」（开窗口），与前四个**不平级**（前四个是退出/查看，第五个是进入处理流程），视觉上单独成区 |
| §1.4 记忆共享 | **对隐藏会话也生效**：它的 `focusRoot` 是 `targetPath`（主目录）→ `projectMemoryRootOf` 返回主目录 → 与主目录会话共享项目记忆。这是对的（冲突处理也是在这个项目上工作） |
| §5 Git 锁 | `merge-win:finish` 加 `[repoRoot, targetPath]`；`resolve-hunk` / `resolve-file` / `restore-file` **也要加同一把锁**（它们写 `targetPath` 的文件） |
| §12 胶囊 | 新增 `mergeInProgress` 的展示（§12.2 已列该字段）；**胶囊不是冲突处理的入口**——入口在工作区的合并面板（那里才有 target 上下文） |
| §2.5 「关联会话」 | 隐藏会话的 `focusRoot` 是 `targetPath` 而非 worktree 路径 → **天然不计入 worktree 的 `sessionCount`**，不需要额外排除 |
| §7.2 `WorktreeView` | 新增 `mergeInProgress: { targetPath, unmergedCount } \| null`（不是仅胶囊有），让设置页也能看到「合并进行中」 |

**`mergeInProgress` 必须每次从 git 现算，不落盘。** 理由（§6.5 同类）：用户在终端里手跑 `git merge --abort` 后，落盘状态会立刻过期，界面会一直显示「合并中」，用户以为卡死。

### 13.11 需要拍板的点

**P1（必须确认）隐藏会话的实现方式：复用 `parentId` 还是新增 `hidden` 字段？**
我推荐**先试 `parentId`**（零字段改动、过滤已存在），但**必须先验证它不会走 `chat-members.ts` 的成员提示词分支**（§13.3 路障三的三步验证）。若会走，则必须改用 `hidden` 字段，代价是要清点所有列会话的地方。**这是实现前必须先跑通的一步，不是设计可选。**

**P2（建议拍）AI 处理的超时值。**
我建议 **5 分钟无进展**（不是总时长）。判据：连续 5 分钟没有新的工具调用完成。理由：大文件、多文件时 AI 可能需要几分钟，卡死总时长的阈值会把正常工作打断。**「无进展」比「总时长」准。**

**P3（建议拍）「完成合并」的提交信息是否允许编辑。**
我推荐**允许**（默认填 `MERGE_MSG`）。理由：合并提交信息是用户会 grep 的历史记录，默认的 `Merge branch 'x' into y` 够用但往往不够准确（不知道合的是什么需求）。代价是一个可编辑框，成本很低。

**P4（建议拍）冲突块是否显示 `base`（diff3 的原始版本）。**
我推荐**显示但默认折叠**。理由：`base` 对判断「该选哪个」有价值，但它占视觉空间；默认折叠 = 想看的人点开、不想看的人不受干扰。**不要因为「用户可能没设 diff3」就不做** —— 我们要处理的是「文件里有没有 `|||||||`」，不是「用户有没有设」。

## 14. 合并入口分工（会话胶囊 vs 设置页）

### 14.1 两条路径走**同一个** `worktree:merge` 通道

**确认：同一通道，不新开第二个入口。** 理由：

1. 四项检查（§4.2）是**安全前提**，不是 UI 便利。两个入口各写一套检查，必然漂移 —— 这是仓库里已经有过教训的模式（`model-availability.ts` 的注释：「判定只在主进程做，渲染层不复算——两套规则迟早漂移」）。
2. 两个入口的**差异全在展示层**：会话胶囊是「我现在就要合」的即时动作；设置页是清单视角。它们的 `path` 参数来源不同，但请求体完全一样。
3. 合并的锁（§5.2）、SHA 冻结（§4.3）、失败出口（§4.7）都不需要因入口不同而不同。

**唯一的接口扩展**：设置页需要在**没有会话**的情况下合并，这不需要新参数（`worktree:merge` 的入参是 `{ path }`，与会话无关）。

### 14.2 设置页合并没有会话的 worktree：需要额外检查吗

**结论：C0~C6 已经覆盖，不需要新增检查。** 逐条核：

| 顾虑 | 已被哪条覆盖 |
|---|---|
| 「它可能很久没更新」 | **不是检查项，也不需要**。合并的是分支内容，不是「新鲜度」。旧的 worktree 照样能合；若它落后于 target，`--no-ff` 会正常产生合并提交（可能带冲突，冲突出口已有） |
| 「`targetBranch` 还成立吗」 | **C4**：`git worktree list` 里查 `refs/heads/<targetBranch>` 是否有唯一检出。分支被删/改名/不再检出 → C4 失败，`reason: 'target-not-checked-out'`，界面提示「主目录已切到 X」 |
| 「目录还在吗」 | **C0** |
| 「它自己的改动提交了吗」 | **C1**（source 脏则拒绝） |
| 「它还在自己的分支上吗」 | **C2** |
| 「有没有别的 git 操作在跑」 | **C3/C6** |

**但有一件事必须补：设置页的「批量合并」。**

原型与需求都提到「统一处理」。批量合并 = 遍历选中的 worktree 逐个调 `worktree:merge`。必须遵守：

| 要求 | 理由 |
|---|---|
| **串行，不并发** | 它们共享 `repoRoot` 锁（§5.2），并发只会排队；串行还能让失败原因按顺序报，用户看得懂 |
| **单个失败不中断批次** | 一个 worktree 脏不该让后面 8 个都不执行。返回 `results: MergeResult[]`（逐条） |
| **按 `repoRoot` 分组** | 跨仓库的批量合并要分组串行，锁才不会被无谓争抢 |
| **每个都重新跑 C0~C6** | 不复用批次开始时的快照：第 2 个合并时，第 1 个已经改了 target 的 HEAD，第 2 个的检查必须基于新状态 |
| **批次里任一项产生冲突 → 立即停止后续** | 冲突意味着 target 进入 `MERGE_HEAD` 状态，后续合并必然被 C6 拒绝。**与其让后 7 个都报「target-busy」，不如在第一个冲突处停下并显示「已停止：前 3 个成功，第 4 个冲突，其余未执行」** |

**返回形状**：

```ts
'worktree:merge-batch'  invoke  { paths: string[] } → {
  ok: boolean                        // 全部成功才 true
  results: { path: string; result: MergeResult }[]
  stoppedAt?: string                 // 因冲突/busy 停止时的那个 path
  notRun: string[]                   // 未执行的 path
}
```

### 14.3 失败时两个入口的出口差异

**同一套出口（§4.7），但入口不同，可见性不同**：

- **会话胶囊发起的**：`targetPath` 就在旁边（用户当前会话的 `focusRoot` 往往就是 target 或与之相关），四个出口都可直接点。
- **设置页发起的**：用户可能根本不在 target 目录。所以设置页的失败面板**必须**包含「在终端打开 target」（`terminal:create({ cwd: targetPath })`）——否则用户在设置页看到「有冲突」，却没有任何方式到达现场。四出口里这一条对设置页是**必需**，对胶囊是可选的。

---

## 15. 新增与变更的验收断言

### 15.1 新增（A56 起）

| 编号 | 断言 |
|---|---|
| **A56** | 胶囊四类判定正确：构造 `primary`（`focusRoot`=`E:\deva`）、`worktree`（登记的路径）、`subdir`（`E:\deva\docs`）、`plain`（`E:\chronic-care` 若其非 git 仓库）四种会话，`kind` 分别为对应值。**`subdir` 不得被判成 `primary` 或 `plain`** |
| **A57** | `focusRoot` 为 `null` 时会话无胶囊（`worktree:capsule` 返回 `null`）；会话有挂载时返回非空 |
| **A58** | `chat:set-focus` 改值后**确实广播**：另一个窗口（或成员会话改挂载后）的胶囊在 1 次刷新内跟上；**值未变时不得产生广播**（用调用计数验证） |
| **A59** | 胶囊的 `ownDirty` / `primaryDirty` 读失败时为 `null`（界面显示「—」），**不得为 0**。构造：把工作区目录权限设为不可读 |
| **A60** | `worktree` 会话的胶囊显示分支名；`primary` 显示「主目录」；`subdir` 显示相对路径且带「主目录内」标记；三者的强调色/中性色不同 |
| **A61** | 隐藏 AI 会话的**工具集不含 `run_command`**：可用工具清单里没有它；直接构造一次 `run_command` 调用被 `allowedTools` 白名单拒绝（返回 `isError`）。**这是本需求的安全基石断言** |
| **A62** | 隐藏 AI 会话的 `focusRoot` **由主进程写死为 `targetPath`**，`writeRoots = [targetPath]`；渲染层传入其它路径时被忽略/拒绝（构造一次伪造请求） |
| **A63** | 隐藏会话里 `write_file` / `edit_file` 写到 `targetPath` 之外**被拒绝**：分别构造 `~/.deva-plus/config.json`、`targetPath` 的父目录、另一个 worktree 三条路径，全部返回 `isError`；写到 `targetPath` 内的文件正常成功。**读工具（`read_file`/`grep`）对同三条路径仍然可用**（不限制读）。**注意 `resolvePath` 本身不设限，这条验的是新增的 `writeRoots`** |
| **A64** | 同一 `targetPath` 只能有一个冲突处理窗口：第二次请求时 `focus()` 已有窗口，不新建（用窗口计数验证）。**不同 `targetPath` 可各开一个**，且窗口标题分别带各自目标分支名 |
| **A65** | 「完成合并」前置条件 4a：`git ls-files -u` 非空时拒绝，返回未解决文件清单，**不执行 commit** |
| **A66** | 「完成合并」前置条件 4b：所有冲突文件**已 add** 但内容里仍有 `<<<<<<<` 标记 → 拒绝，返回文件名 + 行号，不执行 commit。**构造方式：先 `git add` 再写回标记**（这正是 A66 与旧方案 `git diff --check` 的分界——后者在此场景漏检，实测 exit 0） |
| **A67** | 「完成合并」**不使用 `git add -A`**：`targetPath` 另有 5 个未提交改动时，完成合并后这 5 个改动仍未提交（不在合并提交里） |
| **A68** | 「完成合并」成功后：`MERGE_HEAD` 消失、`mergeCommit` 有两个 parent、窗口进入 `done` 成功态且**不自动关闭**、隐藏会话的指针被清 |
| **A69** | 用户在冲突中**直接关窗**（合并未完成）→ 出现 §13.2.1 分支②的确认框；确认关闭后 `MERGE_HEAD` 仍在、`mergeInProgress.unmergedCount` 仍正确、界面上「合并进行中」提示仍可见且可再次打开窗口 |
| **A70** | 单文件恢复：`git checkout --merge -- <file>` 把一个被改砸的**已 add** 文件恢复成冲突初始态（`ls-files -u` 恢复为 3 条，内容含标记），其它文件不受影响。**恢复后标记标签为 `ours`/`theirs`（非原名），界面必须说明这点且解析器仍能正确解析** |
| **A71** | 会话胶囊发起的合并与设置页发起的合并**走同一通道**：两者产生完全相同的 `checks` 结构与失败 reason（同一场景各跑一次，结果逐字段相同） |
| **A72** | 设置页批量合并：第 3 个产生冲突 → 第 1、2 个成功、第 3 个失败（conflict）、`stoppedAt` = 第 3 个、`notRun` 含第 4 个及以后；**每个都重新跑了 C0~C6**（构造：合并第 1 个后 target HEAD 前进，第 2 个的 C4/C5 反映新状态） |
| **A73** | 设置页失败面板**必须**有「在终端打开 target」出口，且 `cwd` 是 `targetPath`（不是 sourcePath） |
| **A74** | `mergeInProgress` 非空时，worktree 卡片与相关会话的胶囊都显示「合并进行中」，且**在非 worktree 会话（`primary`）里也能看到**（构造：用户在完全无关的主目录会话里工作） |
| **A75** | 冲突块**默认全部 `pending`**：打开窗口后不点任何东西，「完成合并」处于**禁用**态并显示「还有 N 处未选择」。**任何块都不得被预填成 ours/theirs/both**（构造：直接读窗口状态，逐块断言 `resolution === 'pending'`） |
| **A76** | 存在任一 `pending` 块或 `pending` 整文件选择时，「完成合并」**必须拒绝**（不只是禁用按钮，主进程也要拒——构造一次绕过 UI 的直接调用） |
| **A77** | `diff3` / `zdiff3` 样式的文件能被正确解析：设 `git config merge.conflictStyle diff3` 制造冲突，`base` 段非空且**不被并进 `ours` 或 `theirs`**；`ours`/`theirs` 内容与 stage 2/3 的 blob 内容一致 |
| **A78** | 写回后 `resolution` 状态与**磁盘内容**一致：选 ours 后文件里该块内容 === ours 的行；选 both 后 === `merged` 的行；未选的块**仍保留完整标记**（所以 `git ls-files -u` 仍非空） |
| **A79** | 行号漂移不破坏已选状态：一个文件有 3 个块，选第 1 块写回后，第 2、3 块的行号变化但 `id` 不变、已选状态不错位（构造：断言第 1 块 resolved、第 2/3 块仍 pending） |
| **A80** | 外部修改保护：窗口打开后，用外部工具改同一文件 → 再次写回时被拒绝并提示「该文件已被外部修改，请重新加载」，**不覆盖外部改动** |
| **A81** | 非文本冲突整文件选边：构造 `AA` / `UD` / `DU` / `DD` / 二进制 五种，各自 `kind` 正确、`hunks` 为空、只能整文件选、界面不显示块数；`fileDecision` 默认 `pending` |
| **A82** | AI 处理完后 `resolution` **仍是 `pending`**（不自动算已解决），且窗口显示「AI 已消除全部冲突，请逐块确认」；用户点「采用 AI 的结果」后才变为 `both` |
| **A83** | AI 处理后残留检测生效：AI 声称完成但文件里仍有标记 → 窗口显示「还有冲突标记残留（文件:行）」，`[让 AI 继续]`/`[手动处理]` 可用；**不得显示成功** |
| **A84** | 二进制冲突只能靠 4a 拦住：文件无任何标记（实测 git 保留 ours 内容）、`git grep` 判为无标记的情况下，`ls-files -u` 非空 → 「完成合并」仍被拒绝 |
| **A85** | 关窗分支③：AI 正在跑时关窗 → 出现「等它做完 / 中止并关闭」；选中止后隐藏会话被 `chat:abort`、**已写入的文件改动保留**（不自动回滚） |
| **A86** | 窗口的 preload **不暴露** `git.*` / `chat.*` / `fs.*` / `config.*`：在窗口渲染进程里 `typeof window.deva === 'undefined'`（或至少这些命名空间为 undefined），只有 `mergeWin.*` 的 8 个方法 |
| **A87** | 所有 `merge-win:*` 通道**不接受渲染层传入的 `targetPath`**：构造一次带 `targetPath` 的伪造请求，它被忽略（仍作用于开窗时记录的那一个） |
| **A88** | 「完成合并」**不跳过钩子**：设一个必定失败的 `pre-commit` 钩子 → 合并被拒绝、返回 `commit-failed` + git 原文、`MERGE_HEAD` 仍在、无新提交 |
| **A89** | 隐藏会话**不出现在左侧列表**：`chat:list-sessions` 的结果里没有它；同时**它仍能被 `runTurn` 正常驱动**（否则 AI 无法工作） |
| **A90** | target 脏改动**与合并路径有交集**时：C5 报 `target-overlap`，`detail.overlapPaths` 是**完整交集清单**（不只第一个），且界面给出三个出口（先存起来再合并 / 去终端 / 取消）；**不执行 merge** |
| **A91** | **路径交集用三点语义（merge-base..frozenSha），不用两点**：构造「target 分支自己改过 `masteronly.txt` 并提交、frozenSha 没碰它、工作区又脏了它」→ C5 **通过**（`overlapPaths` 为空），合并成功且该文件脏改动保留。**若实现误用两点 diff，此断言会因 `masteronly.txt` 被误列入而失败** |
| **A92** | **ff 场景下交集判定正确**：target 落后 frozenSha 一个提交（可快进）、工作区脏了同一个文件 → C5 报 `target-overlap`（**不得因 ff 而漏判**）。同时断言实现**未使用 `git merge-tree` 做预测**（该命令在此场景不输出路径） |
| **A93** | **untracked 撞路径被正确识别**：工作区有未跟踪的 `new.txt`，frozenSha 新增同路径 → C5 报 `target-overlap` 且清单含 `new.txt`（`status --porcelain -z` 的 `??` 必须计入脏路径集） |
| **A94** | **显式 stash 流程的每一步都可核验**：①`stash push --include-untracked` 后 `status --porcelain` 为空 ②merge 执行 ③`stash pop` 后：若无冲突则 stash 条目自动消失、改动完整回来、**untracked 文件也在**；若有冲突则 **`pop exit=1` 且 stash 条目仍保留**、工作区为 `UU`、改动内容 100% 在文件里 |
| **A95** | **merge 本身冲突时 stash 完好**：stash 后 merge 冲突（exit 1）→ `stash@{0}` 仍在；执行 `merge --abort` 后 `stash@{0}` **仍**在；此时 `stash pop` 能把改动完整恢复（A94 的失败分支） |
| **A96** | **不使用 `git merge --autostash`**（硬断言）：全仓 `grep -n 'autostash' --include=*.ts` 只在注释/文档里出现，**代码中不得有 `--autostash` 参数**；任何 merge 调用都不得带它（构造一次 autostash 会产生的场景，断言实际走的是显式 stash 流程） |
| **A97** | **stderr 解析不写死格式**：构造三种变体各一次 —— ①unstaged（`\t` 缩进）②staged（两个空格缩进）③untracked（另一条 `untracked working tree files` 报错）→ 三种都能正确提取路径清单；④ `advice.commitBeforeMerge=false` 使提示行变空行时，**不得把「提取为空」当成「无路径」而放行**（必须退回「原始 stderr + 出口」） |
| **A98** | **退出码不作为性质判据**：ff 脏拦退 **1**、non-ff 脏拦退 **2**，两者都必须被识别为「脏工作区拦合并」而非「冲突」/「未知错误」 |

### 15.2 变更的既有断言

| 编号 | 变更 |
|---|---|
| **A36** | 保留（系统提示词仍要那五段）。**新增一条要求**：提示词里的「不在本区」数字必须与胶囊 `primaryDirty` 同源（同一次 `git status` 计数） |
| **A42** | 原先只有四个出口。**现在第五个出口**：「**处理冲突**」（开独立窗口；仅 `conflict` 时出现）。**文案不是「让 AI 试试」**——窗口里手动与 AI 都能做。四出口仍是「平权」的退出/查看动作，第五个是**进入处理流程**，视觉上单独成区、不与它们平级 |
| **A45** | 补充：`set-focus` 改挂后胶囊必须跟变（见 A58/A60） |

### 15.3 明确「不验」的（避免验收范围膨胀）

- **AI 解决冲突的代码质量**（是否合理地合并了两边逻辑）：不可断言，由用户复核判断。验收只验「标记消失 + 机制生效 + 默认 pending」。
- **AI 会不会自称解决了但实际没改**：不验 AI 的话，只验 `git ls-files -u` 与标记扫描的结果（A65/A66/A83）。**机制不相信 AI 的自述。**
- 窗口与 AI 的**响应速度**：不设指标（P2 的超时是保护机制，不是性能指标）。
- 用户编辑 `merged` 的**内容正确性**：只要不残留标记、写盘成功，写什么都可以。

### 15.4 断言与实测事实的对应（验收时可复现）

这些结论是本设计的依据，验收方可以按同一命令复现（本机 git 2.55.0.windows.5）：

**冲突处理窗口相关（§13）**

| 事实 | 复现命令 | 实测结果 |
|---|---|---|
| `git diff --check` 在已 add 后**漏检** | `git add f.txt && git diff --check` | **exit 0**（无输出）→ 所以不用它 |
| `git diff --check --cached` 能抓到 | `git diff --check --cached` | exit 2 + `leftover conflict marker` |
| `git grep` 能抓到已 add 的残留 | `git grep -n -E '^(<{7}\|={7}\|>{7})( \|$)' -- f.txt` | 有标记 exit 0、无标记 exit 1 |
| `git checkout --merge` 能恢复（含已 add） | `git add f.txt && git checkout --merge f.txt` | `Recreated 1 merge conflict`，exit 0，`ls-files -u` 恢复 3 条；**标记标签变为 ours/theirs** |
| `git commit --no-edit` 在合并态生成双亲提交且不挂起 | `git add f.txt && git commit --no-edit` | exit 0，`parents=<A> <B>`，`MERGE_HEAD` 消失 |
| 二进制冲突**没有**标记 | 造二进制冲突后 `git grep` | **exit 1（判为无标记）** → 只能靠 `ls-files -u` 拦（A84） |
| `git worktree add` 拒绝尾带空格/点并**留孤儿分支** | `git worktree add -b t1 "../wt-space " HEAD` | exit 128；随后 `git branch --list` 里**有 `t1`** |

**脏工作区合并策略相关（§4.9）**

| 事实 | 复现命令 | 实测结果 |
|---|---|---|
| **git 按路径粒度拦，同文件不同行也拦** | 同文件改第 1 行、feat 改第 3 行 → `git merge feat` | `error: Your local changes … would be overwritten by merge:` + `f.txt`，**exit 1** |
| **不相干文件的脏改动放行** | target 脏 `shared.txt`、feat 改 `both.txt` → `git merge --no-ff feat` | **exit 0**，合并成功，`shared.txt` 的脏改动仍在（`status` 显示 `M shared.txt`） |
| **退出码不唯一** | ff 场景脏拦 vs non-ff 场景脏拦 | ff: **exit 1**；non-ff: **exit 2** + `Merge with strategy ort failed.` |
| **缩进格式不统一** | `od -c` 看 stderr | unstaged: `:` `\n` `\t` `f.txt`；staged: `:` `\n` ` ` ` ` `other.txt` |
| **untracked 是另一条报错** | 工作区有未跟踪 `newfile.txt`、feat 新增同路径 | `error: The following untracked working tree files would be overwritten by merge:` + `Please move or remove them before you merge.`，**exit 1** |
| **ff 场景 `merge-tree --name-only` 不报路径** | `git merge-tree --write-tree --name-only master feat` | **只输出树 OID**，无路径；而 `git diff --name-only master feat` 给出 `f.txt` → 所以不用 merge-tree 预测（A92） |
| **三点 diff 与真实拦截一致（四格全对）** | `git diff --name-only master...feat` | ff→`f.txt` ✅；non-ff→`both.txt` ✅；master 独改→不列出 ✅；混合→只 `B` ✅ |
| **两点 diff 会误报** | master 改 `masteronly.txt` 并提交、feat 未碰、工作区脏它 → `git diff --name-only master feat` | **列出 `masteronly.txt`（误报）**，而真实 merge **exit 0 不拦** → 必须用三点（A91） |
| **`--autostash` 退出码 0 但工作区冲突** | 脏改动与合并结果同文件 → `git merge --autostash --no-ff --no-edit feat` | **exit 0**，`status` 为 `UU a.txt`，**`MERGE_HEAD` 为空**，`stash@{0}: autostash` 残留 → 禁止使用（A96） |
| **`--autostash` 在合并冲突时 pop 拿不到东西** | stash 后 merge 冲突 → `git stash pop` | `No stash entries found.`（autostash 钉在 `MERGE_AUTOSTASH`，不在 `refs/stash`）；`git stash apply <MERGE_AUTOSTASH>` → `error: could not write index` |
| **显式 `stash push -u` → merge → pop 全链路安全** | 见 §4.9.5 | 无冲突：pop exit 0、条目消失、改动+untracked 全回来；pop 冲突：**exit 1 且条目保留**、改动 100% 在文件里；merge 冲突：stash 保留，`merge --abort` 后**仍保留**，随后 pop 干净恢复（A94/A95） |

---

## 16. 本次变更对既有章节的影响清单（改动追溯）

| 章节 | 变更 |
|---|---|
| §1.5 边界告知 | **保留**（给模型的提示词），但不再是「用户唯一的可见渠道」。新增一句：胶囊是给用户的常驻视图（§12） |
| §2.2 `deps` 五态 | 不变 |
| §2.6 删除语义 | 不变 |
| §4.2 四项检查 | **C1 与 C5 的判据变了**（§4.9）：C1 从硬拦改为「恒通过 + 必显警告」（`status: 'warn'`）；C5 从「`status` 输出为空」改为「脏路径集 ∩ 合并路径集 = ∅」（三点 diff 语义）。**C2/C3/C4/C6 不变**。`MergeCheck.status` 新增 `'warn'` |
| §4.7 失败出口 | **新增第五个操作区**「处理冲突」（开独立窗口，§13）。**文案不是「让 AI 试试」** |
| §7.1 通道一览 | 新增 `worktree:capsule`、`worktree:capsule-updated`(send)、`worktree:merge-finish`、`worktree:merge-batch`、`worktree:conflict-session`、`worktree:restore-file` |
| §7.2 `WorktreeView` | 新增 `mergeInProgress` 字段（§13.10） |
| §7.4 i18n | 新增胶囊文案（`cf.wt.capsule.*`）与冲突窗口文案（`cf.mw.*`）：块计数、三选一、整文件选边、六条前置的拒绝原因、AI 各失败态 |
| §1.4 记忆共享 | **不变，但对隐藏 AI 会话也生效**：它的 `focusRoot` 是 `targetPath`（主目录）→ `projectMemoryRootOf` 返回主目录 → 与主目录会话共享同一份项目记忆。这是对的（冲突处理也是在这个项目上工作） |
| §5 Git 锁 | `merge-win:finish` / `resolve-hunk` / `resolve-file` / `restore-file` 全部加 `[repoRoot, targetPath]`（它们都写 `targetPath`）。窗口打开（`merge-win:state`）**不加锁**（只读） |
| **§12 胶囊** | 胶囊**不是**冲突处理的入口（入口在工作区合并面板，那里才有 target 上下文）。胶囊只负责**显示** `mergeInProgress` 并提供「查看」跳转 |
| **§2.5 关联会话** | 隐藏 AI 会话的 `focusRoot` 是 `targetPath` 而非 worktree 路径 → **天然不计入 worktree 的 `sessionCount`**，不需要额外排除逻辑 |

### 16.1 实施顺序的插入点

新任务按依赖插进 §8 的三段里：

| # | 任务 | 依赖 | 归入 |
|---|---|---|---|
| **T1.8** | `worktree:capsule` 通道 + 四类判定（§12.1-12.3） | T1.2（快照）、T0.6 | P1 |
| **T1.9** | `chat:set-focus` 补广播（§12.4）—— **独立小改动，可提前做** | — | P1（可以与 T0.x 并行） |
| **T1.10** | 胶囊 UI + 展开面板 + 异步 dirty（§12.6） | T1.8 | P1 |
| **T2.4** | `conflict-parse.ts`：标记解析（含 `diff3` 的 `|||||||`）、`applyResolution` 写回（重读校验 + 原子写 + 回读校验）、id 不含行号（§13.4） | T2.1 | **A75/A77/A78/A79/A80/A81** 绿 |
| **T2.5** | `merge-win:*` 一组 IPC + 独立 preload（只暴露 8 个方法）+ 独立 `BrowserWindow`（单实例 per targetPath）（§13.1-13.3） | T2.1 | **A64/A86/A87** 绿 |
| **T2.5b** | `ToolContext.allowedTools` + `writeRoots` 两道校验（`executeTool` / `write_file` / `edit_file`）；**其它会话不传，零回归** | T2.5 | **A61/A62/A63** 绿；既有会话写入行为逐条不变（跑 QA 回归） |
| **T2.5c** | 隐藏 AI 会话：先验 `parentId` 能否复用（§13.3 三步验证），不通过则改 `hidden` 字段并清点所有列会话出口 | T2.5b | **A89** 绿（不进列表 ∧ `runTurn` 可驱动） |
| **T2.6** | `merge-win:finish`：六条前置（含 4a+4b 双判据）、只 add 冲突文件、`commit --no-edit`、不 `--no-verify`（§13.6-13.7） | T2.4、T2.5 | **A65/A66/A67/A68/A88** 绿 |
| **T2.6b** | `merge-win:restore-file`（`git checkout --merge`）+ 关窗三分支（§13.2.1） | T2.6 | **A69/A70/A85** 绿 |
| **T2.7** | `mergeInProgress` 接入 `WorktreeView` 与胶囊（§13.10） | T1.8、T2.1 | **A74** 绿 |
| **T2.8** | `worktree:merge-batch`（串行、遇冲突停止、按 repoRoot 分组，§14.2） | T2.1 | **A71/A72/A73** 绿 |
| **T2.9** | AI 一键处理：隐藏会话 + 提示词（冲突清单喂给它）+ 残留检测 + 逐块呈交（§13.8） | T2.5c、T2.6 | **A82/A83/A84** 绿 |
| **T2.10** | 手动逐块 UI：两栏对比 + 三选一 + 「两个都要」编辑 + base 折叠（§13.4.5-13.4.6） | T2.4、T2.5 | 三选一与整文件选边都可用；**无 pending 时完成按钮才可用**（A75/A76） |

**依赖关系的关键点（三条）**：

1. **T2.4/T2.5b（写回与权限地基）必须先于 T2.9（AI）**。否则会出现「AI 能改文件，但没有安全边界、也没有可靠的写回」的窗口期。
2. **T2.6（完成合并）必须先于 T2.10（手动 UI）交付可用的最小版本**——因为「选了半天却提交不出去」比「不能选」更挫败。
3. **T2.5c（隐藏会话验证）是唯一的「先验证再动工」项**。`parentId` 能否复用决定要不要改会话模型；不先验证就动手，可能在实现到一半时被迫改道（清点所有列会话出口的工作量远大于先跑三步验证）。

### 16.2 风险清单补充（本次新增）

| # | 风险 | 静默方式 | 兜法 |
|---|---|---|---|
| **R16** | `subdir` 会话被判成 `plain`，胶囊不警告「改动落在主目录」 | 用户以为隔离了，实际没有 | A56；胶囊判定顺序硬编码 §12.1 |
| **R17** | `chat:set-focus` 不广播，胶囊显示旧目录 | 用户看到的目录 ≠ 实际目录，**比不显示更糟** | A58；T1.9 |
| **R18** | `dirty` 读失败当成 0 | 「0 个改动」让人放心，实际有改动没读出来 | A59；`null` 语义 §12.2 |
| **R19** | 「完成合并」用了 `git add -A`，吞掉 target 检出里的未提交改动 | **一次操作毁掉用户全部工作区改动** | A67；§13.7 决定点 |
| **R20** | AI 通过 `run_command` 执行 `git commit` / `push` | 用户的代码在未复核的情况下被提交甚至推送 | A61；**不给工具**（§13.3 路障三） |
| **R20b** | AI 用 `write_file` 写 target 之外的文件（`config.json`、`secrets.json`、别的项目） | **写坏应用配置或别的项目，且无任何提示** | A63；`ToolContext.writeRoots`（§13.3）。**注意：`resolvePath` 现在完全不设限（`tools.ts:723`），不能靠它** |
| **R21** | 两个窗口同时改同一批冲突文件 | 互相覆盖、无法归因 | A64；同一 targetPath 单实例（§13.1） |
| **R22** | 隐藏会话的 `focusRoot` 由渲染层指定 → 提权（能写任意目录） | 用户不知情，任意目录可写 | A62；主进程写死 + `writeRoots` 收窄 |
| **R23** | AI 说「解决了」实际标记还在 | 用户点完成 → 提交了带冲突标记的代码（**编译必炸、且已进历史**） | A66/A83；4b 标记扫描 |
| **R24** | `ls-files -u` 空但标记还在（AI 删标记后又 write_file 覆写回冲突态） | 同上 | A66；**4a+4b 双重判据**（实测证明 `git diff --check` 单用会漏检） |
| **R25** | 关掉窗口后用户找不到「怎么继续合并」 | 合并永远挂着，target 处于 MERGE_HEAD，后续 git 操作全报错 | A69/A74；`mergeInProgress` 全局可见 + 关窗确认框写清「随时能回来」 |
| **R26** | `mergeInProgress` 落盘缓存 → 用户在终端 abort 后界面仍显示「合并中」 | 提示常驻，用户以为卡死 | §13.2：每次从 git 现算，不落盘 |
| **R27** | 设置页批量合并沿用批次开始时的快照 | 第 2 个的检查基于旧 target HEAD → 漏检或误报 | A72；每个都重跑 C0~C6 |
| **R28** | 胶囊轮询造成主进程被 `git status` 淹没 | 界面卡顿、CPU 高 | §12.4：不轮询，只在事件时拉 + dirty 两段式异步 |
| **R29** | 冲突块 `resolution` 被预填成 ours（或 AI 结果自动算已解决） | 用户一路点下去，**theirs 的改动静默消失**，而界面显示合并成功、`ok === true` | A75/A76/A82；§13.6.1 三硬约束 |
| **R30** | 写回时用了内存里的旧内容，覆盖外部改动（AI 或用户在编辑器里改过） | 别人的改动无声丢失 | A80；`applyResolution` 必须重读 + mtime/size/sha256 三重核对 |
| **R31** | 写回「成功」但磁盘没变（`writeFileAtomic` 的 rename 回退路径出问题） | 界面显示已选，实际文件没改 → 完成合并提交了未解决内容 | A78；写后**回读校验 sha256**，不一致按 `write-failed` 拒 |
| **R32** | 行号漂移导致已选状态错位 | 用户选过第 1 块，写回后状态跑到第 2 块 → 选错内容被提交 | A79；`id` 不含行号，用 `relPath + 块序号` |
| **R33** | `diff3` 样式下把 `|||||||` 的 base 段并进 ours | 写回的文件内容错乱（多出 base 的代码） | A77；解析器必须识别 `|||||||` |
| **R34** | 二进制冲突被当成「无标记 = 已解决」 | 提交了半选的二进制（只留了 ours，theirs 的版本丢了） | A84；`ls-files -u` 是二进制冲突的唯一判据 |
| **R35** | 隐藏会话泄漏进用户会话列表 | 用户看到一个莫名其妙的会话，且它在主目录有权限 | A89；`parentId` 验证或 `hidden` 字段的完备清单 |
| **R36** | **用了 `git merge --autostash`** | **退出码 0 但工作区是冲突态、`MERGE_HEAD` 不存在** → 被误判成「合并成功」，用户的改动躺在 stash 里而界面说一切正常 | A96；**明确禁止**（§4.9.2） |
| **R37** | **路径交集用了两点 diff** | 误把「target 分支自己改过、frozenSha 没碰」的文件算进交集 → **白拦一次，用户去终端一跑就成功**（对工具失去信任） | A91；必须 `merge-base..frozenSha`（§4.9.3） |
| **R38** | **用 `merge-tree` 预测会不会被拦** | ff 场景它不输出路径 → 判成「干净可叠加」→ 实际被拦 → 用户看到「说要合并却失败」 | A92；§4.9.3 的实测 |
| **R39** | **stderr 解析写死格式** | staged（两空格）/unstaged（tab）/untracked（另一条报错）三种变体里只能认出一种 → 另外两种退化成「未知错误」，用户不知道该清哪些文件 | A97；§4.9.7 锚点+宽松提取 |
| **R40** | **只看退出码判性质** | ff 脏拦退 1、non-ff 脏拦退 2、冲突退 1 → 混淆「脏拦」与「冲突」，给出错误的出口 | A98 |
| **R41** | **stash pop 冲突后当成失败回滚** | 若自动 `stash drop` 或 `reset`，会**丢掉用户刚恢复的改动**（虽然文件里也有，但 stash 是第二份保障） | A94；**不自动 drop**（§4.9.5） |
| **R42** | **staged 状态静默丢失**（`stash pop` 不带 `--index`） | 用户原本 `git add` 过的文件变回 unstaged，他不知情 → 下次 commit 漏提交 | §4.9.5 的「已知残余缺陷」：**必须在结果面板列出受影响的文件**，不能不说 |
