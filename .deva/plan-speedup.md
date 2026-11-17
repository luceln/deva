# 提速方案：用机制防住「静默失败」

> 依据：本次导入功能（24 文件 / 1744 行）走四轮审查-修复循环的实际 bug 分类，
> 加 yetone/magpie 的公开工程规则（8528 次提交 / 54 天，MIT）。
> 每条规则都标了来源和它防住的具体 bug。

---

## 零、先看清问题是什么

### 四轮挖出的 bug，按性质分类

| 轮次 | 发现者 | bug | 性质 |
| --- | --- | --- | --- |
| 1 | 审查 | P0-A 角色启用态写盘返回值被丢 | **失败被当成功** |
| 1 | 审查 | P0-B 第二轮导入竞态 | 并发时序 |
| 1 | 审查 | `targetState` 读失败当「坏了」→ 覆盖正常会话 | **失败被当确定结论** |
| 1 | 审查 | 记忆写盘失败界面显示 i18n key 原文 | **契约两端不一致** |
| 2 | 验收 | 会话产出静默丢盘（清了 sessionCache） | **缓存失效语义错** |
| 2 | 验收 | checkpoint 被清扫删空（复制保留旧 mtime） | **元数据被忽略** |
| 2 | 验收 | 会话目标被占位伪装成 skipped | **异常被当正常** |
| 2 | 验收 | 加密不可用伪装成 skipped | **异常被当正常** |
| 3 | 审查 | `mergeProviders` 第二次返回值被丢 | **失败被当成功** |
| 3 | 审查 | `targetState` 的 readFileSync 与 JSON.parse 共用 try | **失败被当确定结论** |
| 4 | 验收 | `copyAssoc` / `mergeDir` / `copyCompacted` 三处同样的 `existsSync` 裸判断 | **同类未修完** |

### 关键结论

**11 个 bug 里，没有一个是「功能逻辑写错」。**

- 7 个是「失败被当成了成功或确定结论」
- 3 个是「同类错误没有一次修完」
- 1 个是「契约两端不一致」

也就是说：**你不需要更多测试，你需要让「把失败当成功」这件事在写代码时就更难发生，并且在漏掉时能被机械检出。**

---

## 一、magpie 的做法（有出处）

仓库首页写着一句关键的话：

> magpie's code is written, reviewed, merged and released by agents.
> Each night the day's commits are reviewed for what had to be fixed again,
> what shouldn't have merged and what was verified too thinly.

它 2026-10-05 一天 220 次提交、约 170 个 release，其中 40 个是修当天或前一天发出去的东西。
这些修复落在少数几个可复现的模式里，于是被写成规则。

### 它的机制：教训 → 规则 → 检查

三层文件，逐层沉淀：

```
LESSONS.md              每条带「Seen N×」计数，记录哪些天又见到了
   ↓ 同一问题被看到 3 个以上不同的天
docs/code-standards.md   转成 reviewer 逐条核对的表
   ↓
验收标准 6 条 + Reviewing a PR 清单
```

**`LESSONS.md` 开头原文**：

> Each lesson is a rule, then why, then the evidence. "Seen" counts the days
> a review found it. A lesson seen on 3 or more separate days moves into
> [docs/code-standards.md](docs/code-standards.md).
> Read this before changing code.

### 它的两条核心规则，逐字命中我们的坑

**规则 1（`docs/code-standards.md`，What a change contains 表）**

> **A failed read, parse or hash means "unknown".** It never means "empty",
> "none" or "equal". Keep what was read before, copy a file that doesn't
> parse aside before writing over it, and fix the shared reader rather than
> writing a strict one beside it. A list that guards access (an allow list,
> a key limit) fails closed when its file can't be read. Test with the file
> unreadable.

它给了四个实例，每一个都能对上我们的：

- `readLogins` 把 parse 错误写回成「没有账户」→ 正对应我们的 `targetState` 把读失败当「坏了」
- `agent/stash.go` 两天后犯同一个 bug
- IP allow list 把读不出的 settings.json 当成空列表，**放行了所有地址**
- codex-autoreset.json 读不出被当成「没花过重置」

**规则 2（同表）**

> **A fix reaches every sibling of the bug.** Grep for the same pattern:
> every agent, subcommand, guard of the same shape and caller of a changed
> predicate gets the fix in the same change. That includes the other
> branches of the same operation and the other messages that name the same
> endpoint or rule. On 2026-10-05 six fixes needed a second release because
> they covered only the case in the report.

**这一条精确对应我们第四轮才发现的那三处 `existsSync`。** 而且它记着「2026-10-05 有六个修复因为只覆盖了报告里那一个 case，需要第二次发版」，后来 10-08 又漏了一次。

**规则 3（`LESSONS.md`，Verification 节）**

> When a rule keeps being missed, put its check where the work already runs.

它记录了这条规则自己被漏掉的经过：一条 CLI 路由检查反复被跳过（因为改 GUI 的人不跑 `internal/cli` 的测试），
于是把检查**搬到了改 GUI 时本来就会跑的包里**（`internal/gui` 的 `TestEveryRouteIsNamedForTheCLI`）。

**这条对我们最有启发**：不要指望人记得跑某个检查，要把检查放进「本来就会跑的路径」。

### 它的验收标准第 1 条：反向验证

> **A test that fails without the change.** Put the old code back and run
> the new test. It must fail with a real `FAIL` that names the behavior.
> A compile error or a skipped test doesn't count. Say which test fails and
> what it failed with. Then restore the change and check the test passes.

以及 Reviewing a PR 里的：

> **Break it on purpose.** Revert the fix, or break the code it guards in
> several ways, and check that the new tests catch each break (#901 broke
> `backup.go` four ways).

**你的测试成员已经自发做了这件事**（用旧 `invalidateIndex()` 做对照组复现丢盘），
但它是「碰巧想到」，不是流程要求。magpie 把它变成**每一次修复都必须交的证据**。

### 它还有一条直接适用：一个 checkout 属于它的 session

> A checkout, a worktree and the logs in it belong to the session that made
> them. Work in a worktree of your own (`git worktree add --detach`), never
> check out, commit from or clean another session's.

**magpie 自己就是多个 agent session 并行跑的，靠 worktree 隔离。** 你要做的多任务并行功能，
它已经在用同一套解法 —— 这条能验证架构方案的判断是对的。

---

## 二、落地方案（本项目）

### 前提：这个仓库没有 lint

已确认：`package.json` 和 `apps/desktop/package.json` 里都没有 eslint / prettier / biome，
上游也没有。装 eslint 的代价（配置 + 上百条既有告警）不值得。

**所以采用零依赖自检脚本**，和 `typecheck` 并列跑。

---

### 机制 1：把「静默失败」写成硬规则（进 AGENTS.md）

在 `AGENTS.md`「二、写代码时」的「静默错误必须显式处理」一节里，
**替换现有三条为下面五条**（现有三条保留，新增两条）：

现有：
```
- 函数返回 `{ ok: false }` / `boolean` → 必须检查返回值，不许丢弃
- `catch` 块里不许只有注释，失败要有通道能浮到界面
- 缓存不清 → 数据写了但列表看不见
```

新增：
```
- 读写失败 = "不知道"，绝不等同于「不存在」「空」「没变」。读范围内要保留上一次成功的值；
  覆盖前若旧内容解析失败，先备份到旁边；访问控制类的读取失败一律 fail closed（拒绝）
- 修一个 bug 必须 grep 同类模式并同一次改完（同形状的守卫、同谓词的调用方、
  同一操作的其他分支、同一接口的其他文案）。只修报告里那一个 case 视为未完成
```

**为什么进 AGENTS.md 而不是单独文档**：AGENTS.md 每次对话都随消息下发，
AI 一定看得到。放别处等于赌 AI 会去读。

**代价**：AGENTS.md 现在 82 行，加上这两条约 88 行，仍在 120 行上限内。

---

### 机制 2：自检脚本（零依赖，进 build 流程）

新建 `scripts/check-silent-failure.mjs`，扫 `apps/desktop/src/main/` 和 `shared/`，
输出违规位置。**规则只查能用正则可靠识别的四种模式**：

| # | 模式 | 检出什么 | 防住的 bug |
| --- | --- | --- | --- |
| 1 | `if (existsSync(x))` 后 3 行内直接 `return` / `continue`，且没有区分「存在且可用」 | 裸判断把「存在但不可读」当「已存在」 | 第 4 轮的三处 |
| 2 | `catch {` 或 `catch (e) {` 块内只有 `console.` / 注释 / 空 | 吞异常 | P0-A、P2-10 |
| 3 | 调用了返回 `{ ok: ... }` 的函数但整行丢弃返回值（语句结尾无赋值、无 `if`、无 `?.`） | 返回值丢弃 | P0-A、审查 P1-1 |
| 4 | `readFileSync` / `readJson` 的 try 块里同时有 `JSON.parse` | 读失败与解析失败混为一类 | 审查 P1-2 |

**输出示例**：

```
[1] apps/desktop/src/main/importer-assoc.ts:143
    existsSync 后直接 return，未区分「存在但不可读」
[2] apps/desktop/src/main/services/config.ts:301
    catch 块内只有 console.warn，失败没有出口
```

**关键设计**（前三条照抄 magpie 的 guard test，后两条是我加的）：

- **误报必须显式豁免**：写法是同一行加 `// silent-ok: <理由>`。
  「我判断过这是无害的」要留下书面理由，而不是默默通过
- **反向清理：豁免清单里的条目若已不再匹配，也报错**。
  magpie 原文：`no excuse outlives the variable it was for`（`agentenv_test.go:110-115`）。
  没有这条，豁免会越积越多，最后没人知道哪条还有效
- **Canary：断言扫描器本身还在工作**（`agentenv_test.go:102-109`）。
  magpie 种了两个已知会命中的探针（`CODEX_HOME`、`QODER_CONFIG_DIR`），
  若扫不到就报错「readsEnv 这个正则已经不匹配读法了」。
  **这是防止「检查静默失效」的检查** —— 我们这次的教训正是静默失效，
  如果自检脚本自己悄悄失灵，比没有更糟
- **总量下限**：`if (n < 200) t.Fatalf("read %d routes")`（`route_cli_named_test.go:44-46`）。
  扫到的条目数低于阈值直接失败，防止正则被改坏后「零违规 = 通过」
- **不做全量 lint**，只查这四类。范围小才不会被开发者绕过

**为什么这比「多加测试」有效**：这四类都是**写代码时就能判定**的，
不需要构造真实故障场景。而测试只能覆盖你想到的场景。

**magpie 把这条原理写成了规则**（`LESSONS.md` Verification 节最后一条）：

> When a rule keeps being missed, put its check where the work already runs.

它记录了自己漏掉检查的过程：一条 CLI 路由检查反复被跳过，因为改 GUI 的人不跑 `internal/cli` 的测试。
于是它把检查**搬进了改 GUI 时本来就会跑的包里**——`route_cli_named_test.go` 的文件头注释写明：

> a GUI change runs this package, and a new route unnamed there left
> TestEveryRouteHasACommandOrIsNamed red on main again and again (#5946,
> #6162, #6677, #6724, #6786), each found by CI after the push.

**对我们的直接落地**：自检脚本要挂进 `pnpm typecheck` 之后（那个命令大家本来就会跑），
而不是单独一个「记得跑」的入口。

---

### 机制 3：每个修复必须交「反向证据」

改进 `AGENTS.md`「三、说完成时」，把现有的：

```
**报告成功必须可证伪。** `ok === true` 的含义是「我逐项检查过都做到了」，不是「我没遇到异常」。
```

后面补一条具体要求：

```
**修 bug 必须交反向证据。** 报告「已修」时要给出：把修复撤掉后，哪条断言会失败、
失败输出是什么。没有这条证据的修复视为未验证。测试本身写反了也算没修。
```

**这条直接来自 magpie 的验收标准第 1 条。**

代价很低 —— 你的测试成员已经会做（对照组），只是没被要求每次都给。

---

### 机制 4：规则沉淀（LESSONS 机制的精简版）

在项目根建 `LESSONS.md`（**注意：不是 AGENTS.md，避免撑爆 120 行**），格式：

```markdown
## 静默失败

**读写失败不等于「不存在」。** 见到 2 次（导入 targetState、记忆 projectMemoryKey）
- 现象：读失败被当成「空了」，然后按「空」处理
- 规则：见 AGENTS.md 二、静默错误
- 证据：<commit 或复现脚本>

**修一个点要扫同类。** 见到 2 次（sessions 修了、assoc/mergeDir/copyCompacted 没修）
- 现象：只修报告里那一个 case，其余复制品留到下一轮
```

**沉淀规则**：
- 同一模式**被看到 3 次以上**，就升级进 `AGENTS.md` 或自检脚本
- 连续 10 次任务都没用上的条款删掉（AGENTS.md 已有这条维护规则）

**为什么值得做**：你这次四轮 bug 里有 3 次是「同一个病在别处复发」
（`targetState` ↔ `existsSync`；`invalidateIndex` ↔ 未来任何缓存失效）。
写下来的规则能在下一次派任务时直接引用，不用重新发现。

### 机制 5：错误码 → 文案的机械校验（零依赖，约 30 行）

第四轮那个 bug（新错误码渲染层没跟文案、界面显示 `settings.import.reason.targetUnreadable`）
**不需要 eslint 也能防住**。

Signal Desktop 的做法是现成模板：它把「文案完整性」做成独立检查器
`build/intl-linter/linter.node.ts`，9 条规则，`assert()` 失败即非零退出，
在 `pnpm test` 里跑（`test-lint-intl`）。

**我们只需要一条**：遍历主进程里所有 reason / error code 的字面量集合，
断言渲染层 `FAILURE_REASON_KEY` 与 `messages.ts` 里都有对应 key。

```
约定：主进程新增错误码时，在 shared 里导出该码
自检：code 集合 - (FAILURE_REASON_KEY ∪ messages key) 必须为空
```

**这条比 eslint 的 `switch-exhaustiveness-check` 更省事**：不用装 eslint、
不用改现有写法，只要一进 CI 就能拦住「新加码没文案」这一类。

**代价**：约 30 行脚本 + 一条 `pnpm` script。

### 机制 6：写盘时带「我读到的那份」的指纹（VS Code 的做法）

第三轮那个 bug（读失败被当成「坏了」然后覆盖正常会话）除了靠 `unreadable` 态之外，
还有一个更硬的防线 —— VS Code 的 `etag` 乐观并发控制：

`src/vs/platform/files/common/files.ts` 的 `IWriteFileOptions`：

```ts
/** The etag of the file. This can be used to prevent dirty writes. */
readonly etag?: string
```

etag 不匹配时抛 `FILE_MODIFIED_SINCE` 而不是覆盖。

**对导入的落地**：`copyFileSync(from, to)` 覆盖前，先记下目标文件的
`(mtime, size)`，复制后核对；或更简单 —— 覆盖前把目标文件挪到
`to.bak-<timestamp>`（`AGENTS.md` 里「覆盖前若旧内容解析失败，先备份到旁边」已经是这条的简化版）。

**这条列为可选**：导入是「一次性搬数据」场景，备份比 etag 更符合语义。

---

## 三、另外两件立刻能省时间的事

### 3.1 小步提交（这次最大的时间损失）

现状：24 个文件 / 1744 行未提交，放了很久。后果：

- **无法 `git bisect`** —— 出问题只能整体回退
- 四轮审查都对着同一坨 diff，**每轮都要重新读全部 24 个文件**
- 审查者无法区分「这轮改的」和「上轮改的」

**Google 官方给的尺寸判据**（`eng-practices/review/developer/small-cls.html` 原文）：

> 100 lines is usually a reasonable size for a CL, and 1000 lines is usually too large.
> The number of files that a change is spread across also affects its "size."
> A 200-line change in one file might be okay, but spread across 50 files it
> would usually be too large.

**VS Code 最近 100 个已合并 PR 的实测**（调研子智能体抓 GitHub Search API）：

| 指标 | 值 |
| --- | --- |
| 创建 → 合并中位数 | **1.2 小时** |
| < 24 小时 | 85% |
| 改动行数中位数 | **193.5 行** |
| 改动文件中位数 | **5.5 个** |

**我们的 1744 行 / 24 文件，是 Google「too large」阈值的 1.7 倍行数、约 12 倍文件数。**
Google 直接说明了后果：

> With large changes, reviewers and authors tend to get frustrated by large
> volumes of detailed commentary shifting back and forth—**sometimes to the
> point where important points get missed or dropped**.

**这解释了四轮循环，而且不是「审查不认真」**：1700 行里「缓存失效函数清了不该清的缓存」这种跨文件时序问题，没有人能在一次里同时盯住。

**具体建议**：
- 导入功能**通过验收立刻提交**，剩下的 P2 单独提交
- 多任务并行功能按架构的 P0/P1/P2/P3 四段，**每段完成就提交**
- 提交 body 必定包含 `验证：<命令> + <结果>`
- **以后的单次改动上限：≤200 行 / ≤6 文件**，超了先拆（Google 的四种拆法：Stacking / by Files / Horizontally / Vertically）

### 3.2 让审查角色能自己修机械问题

现在：审查只报 → 我派主进程改 → 再审查。每轮多一次往返。

magpie 的 `check` agent：

> **Self-fix** — when an issue is mechanical and small, fix it directly
> - If mechanical (lint nit, missing type, wrong import, dead branch) → fix in-place
> - If a design/judgment issue → record and report, do not silently rewrite

**建议**：给「审查」加同样的授权。按这次经验，3 个 P1 里至少 2 个
（返回值没取、类型没加）属于机械性问题，可以省掉一整轮往返。

### 3.3 给审查一个终止条件（这条最容易被忽略）

调研挖到 Anthropic 官方文档的一句话，直接命中我们「四轮停不下来」：

> **Don't drop the skip style part of that prompt.** A reviewer that's asked
> to find problems will always find something. If you fix every finding, you
> end up with extra abstraction layers and tests for cases that can't happen.

**一个被要求「找问题」的审查者，永远能找出问题。** 所以「AI 不再发现问题」这个终止条件永远不成立。

**正确的终止条件**：`SPEC.md` / 验收清单里的 N 条要求**逐条有对应的断言且全绿**。不是「没发现问题」，是「清单翻完了、每条都验过了」。

**落地**：派审查任务时，附上验收清单，要求按清单逐条核验，并显式加一句「跳过风格问题，只报影响正确性的缺口」。

---

## 四、投入产出比排序

| # | 做法 | 投入 | 预计省下 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | **同类扫描**（AGENTS.md，已加） | 5 分钟 | **1 整轮审查** | magpie 因只修一个 case 需要二次发版 6 次以上 |
| 2 | **反向证据**（AGENTS.md，已加） | 5 分钟 | 「修了但没修对」的往返 | magpie 验收标准第 1 条 |
| 3 | **静默失败规则补全**（AGENTS.md，已加） | 5 分钟 | 消掉 11 个 bug 里 7 个的产生条件 | magpie「failed read means unknown」 |
| 4 | **审查给终止条件**（改派任务模板） | 2 小时 | 解决「四轮停不下来」 | Anthropic「reviewer 总能找到问题」 |
| 5 | **错误码→文案校验**（约 30 行脚本） | 2 小时 | 消灭「界面显示原始码」整类 | Signal 的 intl-linter |
| 6 | **单次改动 ≤200 行 / ≤6 文件** | 0（改习惯） | 每轮审查阅读量 + 可回退粒度 | Google small-cls + VS Code 实测 |
| 7 | **自检脚本**（约 150 行 + 豁免机制） | 半天 | 从「审查发现」变「写时就报」 | magpie guard test |
| 8 | **审查可自修机械问题** | 0（改授权） | 每轮少一次派任务往返 | magpie check agent |

**前三条已经落地（`AGENTS.md` 86 行）。第 4、6 条是零成本改习惯，建议立刻生效。**

---

## 五、我建议的执行顺序

1. ~~把三条规则加进 `AGENTS.md`~~ —— **已完成**（86 行）
2. **现在**：包一包「反直觉的证据」——调研给的两条数据（METR 慢 19%、
   Google 覆盖率是天花板不是地板）值得你知道，但它们不改变做法，只解释现象
3. **导入提交前**：要求主进程补交「三处 `existsSync` 修完后的反向证据」
4. **导入提交后**：写「错误码 → 文案」校验（机制 5，30 行，收益最确定）；
   再写自检脚本（机制 2），先只在 `importer-*.ts` 上跑，确认无误报再扩大
5. **并行功能开工前**：派任务模板里固定三句 ——
   附验收清单逐条核验、跳过风格问题、交付附命令与输出
6. **持续**：`LESSONS.md` 记录模式；同一模式见到 3 次就升级成硬规则

**一条经验法则**（写在派任务模板最前面）：

> 写清单后自问「哪条命令失败能证明这条没做到？」答不出来的条目
> 就是文字描述，不是验收标准。

这条比任何框架都好用 —— 调研查明 Google 自己「does not use specification
languages very much」，它靠的就是「验收条件必须可执行」这一条纪律。

---

## 六、需要更正的两处（调研推翻了我的初判）

初版方案里我写过两条，调研子智能体查证后**不成立**，这里如实更正。

### 更正一：「引入 `Result<T,E>` 类型库是大项目标配」——不成立

我一开始倾向于建议用 neverthrow 之类的库。实测各项目 `package.json`：

| 项目 | neverthrow | fp-ts | oxide.ts | effect |
| --- | --- | --- | --- | --- |
| microsoft/vscode | 无 | 无 | 无 | 无 |
| logseq / joplin / excalidraw | 无 | 无 | 无 | 无 |
| bitwarden/clients / n8n / hoppscotch | 无 | 无 | 无 | 无 |
| continue / cline | 无 | 无 | 无 | 无 |

**没有一个主流 Electron/Web 项目走这条路。** neverthrow 的 15,400 个 dependents
多数是中小型 SDK，不是 24 文件规模的桌面应用模块。

它们实际用的是**集中错误码 + 集中映射 + 全局兜底通道**（VS Code 的
`FileOperationResult` 11 个成员的 `const enum` + 唯一的映射函数
`toFileOperationResult()`，`default` 落到 `FILE_OTHER_ERROR` 保证不漏网）。

**对我们的结论**：不引库。保持现有 `{ ok, reason }` 形状，把力气花在
「错误码两端一致」（机制 5）和「失败有出口」（机制 1）上。

### 更正二：「靠 eslint 的 `no-empty` 防住空 catch」——不成立

ESLint 官方文档明文：

> This rule ignores block statements which contain a comment (for example,
> in an empty catch or finally block of a try statement to indicate that
> execution should continue regardless of errors).

也就是说 `catch { /* ignore */ }` **天然过关**。加上 `allowEmptyCatch: true` 更宽松。

**所以「吞异常」这件事必须自己写规则**（机制 2 的自检脚本），
或者用 VS Code 那种「结构性约定」：禁止在 I/O 调用点用 try/catch，强制走错误码。

### 顺带一条：Go 生态有现成门禁，TS 没有

调研指出 `errcheck` 在 golangci-lint 里是 **`WithEnabledByDefault()`**，
`golangci-lint run` 一跑就挂，判定规则正是「静默忽略」。

配套还有 `nilerr`（检查了 error 不为 nil 却 return nil）、
`nilnil`（同时返回 nil error 和无效值）—— 后两个精确对应我们的
「读失败被当成文件坏了」和「失败却返回 `{ok:true}`」。

**TS 没有等价物，这就是为什么必须自己写自检脚本**（机制 2 + 机制 5）。

---

## 七、一句反直觉的话

**这个仓库的 bug 不是因为测试少。** 254 条断言、真机 Electron 验证、9 个回归脚本 ——
测试密度已经超过多数开源项目。

Google 官方对「覆盖率」的说法正好印证：

> code coverage only measures that a line was invoked, **not what happened as a
> result**. ... what happens is that instead of treating 80% like a floor,
> engineers treat it like a **ceiling**.

**我们的 bug 全是「错误路径没提示」，100% 行覆盖下 `console.warn` 依然只算一行被覆盖。**

问题在于：**每道关卡都在事后找 bug，没有一道在事前防住「静默失败」这个模式。**

magpie 一天 220 次提交不死，靠的不是测试更多，而是把「同一个模式不要犯第二次」
变成了机械检查，并且把规则从教训里一步步沉淀下来。

### 最后一条，来自 DORA 和 METR

调研挖到两个和直觉相反的数据，值得记着：

- **METR 随机对照试验**：16 名资深 OSS 开发者、246 个真实 issue，
  用 AI 工具后**慢 19%**，而他们自认**快了 20%**。且 AI 组与非 AI 组
  PR 质量相当（`metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/`）。
  注：该页已声明结果过时，2026 版数值未取到，不要引用具体数字。
- **DORA 2024**：AI 采用显著提升个人生产力与工作满意度，但**负面影响交付稳定性与吞吐量**，
  并提醒「small batch sizes and robust testing remain crucial」
  （`dora.dev/research/2024/dora-report/`）。

**合起来解释了你这次的体感**：AI 让「写代码」变快，但把「确认它真的成了」的成本
留给了人。四轮审查循环就是这个成本的具体形态。

DORA 点出的解药和小步提交是同一件事。

