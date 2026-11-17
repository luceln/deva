# magpie 的分阶段规则 × 我们的 8 个成员

> 回答「除了开发规则，需求/审查/设计等我们 8 个成员对应的任务有没有对应规则」。
> 全部有出处：`LESSONS.md`（105KB，8 节）、`docs/code-standards.md`（7 节）、
> `docs/contributors.md`、`AGENTS.md`、`.trellis` 那套不属于 magpie 除外。

## 先说结论

magpie 全自动（agent 写、审、合并、发布，一天 158 次提交），但**规则不是只有编码**。
它的规则按**任务阶段**分节，每节形态一致：

> **一句话规则** → 为什么 → 证据（commit hash / issue 号 / 日期）→ `Seen N×`

`Seen` 是**在不同日子被复现的次数**，到 3 次就升级进 `docs/code-standards.md`（硬规则）。

它的 8 个章节正好能对上我们 8 个成员的大部分职责：

| magpie 章节 | 对应我们的成员 |
| --- | --- |
| `## Reading the report` | **需求** |
| `## Fix the class, not the sample` | **审查**（早期阶段） |
| `## The user's own files and settings` | **实现**（数据安全） |
| `## Verification` | **测试** |
| `## Concurrency and tests` | **测试**（并发专项） |
| `## Red tests and releases` | **测试 / 验收** |
| `## Merging and closing` | **验收** |
| `## Moved to the code standards` | 规则沉淀（跨阶段） |

`code-standards.md` 的 `## GUI` 对 **设计**，
`## Reviewing a PR` 对 **审查**，
`docs/contributors.md` 对 **审查的安全前置扫描**。

---

## 一、需求 ← `## Reading the report`

这一节解决的是「读需求读歪了」，四条规则：

### R1. 用报告人的确切场景复现，不要用你顺手造的场景

> **Reproduce the reporter's exact case, on the surface they use, before you
> call it fixed.** Use their provider, plan, agent and layout, and their GUI,
> TUI or CLI. Check their goal (it drags, the title shows, the reason is
> readable), not a step on the way to it.

证据：`#834` 回来了 4 次（v0.1.920 → .925 → .931 → .938），每轮只修了截图里那一个 agent。
另一例：`4788cf2b` 把错误放进了 GUI，而报告人用的是 WSL 里的 TUI。

### R2. 夹具用报告人的原始字节，不要用你编的相似样本

> **Build fixtures from the reporter's literal bytes, not a similar sample
> you made up.**

证据：`878a8489` 用一个自己发明的 `<tool_call>{json}` "证明"了 Trae 的案子，
而截图里根本没有 JSON。

### R3. 读完整条线索到最后一句话，再动手

> Read the whole thread, to its last comment, before starting.

证据：`def3a41e3` 基于一个报告人已经说了「先别做」的需求开工，被 `2c30e5cee` 回滚。

### R4. 修错误「说的那件事」，不只是改措辞

> **Fix what the error is about, not only how it is worded.**

证据：用户报「GLM 直接 429 了」，commit 只是把 429 的标签改成「余额不足」，
**而真正的问题是没人告诉用户这个 key 该用在 Coding Plan 端点**。改了标签，请求还是不通。

### 对我们的直接对应

我们这次正好踩了 R3 的反面：需求方在清单里留了 7 条「待澄清」，
其中 A7 的陷阱（「base 取哪个目录的 HEAD」）就是它自己标出来的。
架构后来发现的 5 个缺口，有一半源于这个歧义没在需求阶段定死。

**给「需求」的任务模板该加三句**：
1. 读完全部历史线索到最后一句话，不要只看标题
2. 每一条断言自问「哪条命令失败能证明它没做到」，答不出来的改成可执行
3. 自己标出的「待澄清」必须列给用户拍板，不许留到实现阶段

---

## 二、审查 ← `## Reviewing a PR` + `docs/contributors.md`

这是**我们最缺的一节**。magpie 的审查清单有 12 条，其中 4 条直接能治我们的病。

### V1. 跑起来，不要只读 diff

> **Run it.** Pull the head, merge it onto current `main` (resolving conflicts
> if needed) and run the acceptance checks. **Reading the diff alone isn't a review.**

### V2. 故意破坏它

> **Break it on purpose.** Revert the fix, or break the code it guards in
> several ways, and check that the new tests catch each break
> (`#901` broke `backup.go` four ways). A reviewer may add review tests of their own.

**这条就是「反向证据」的审查端。** 和 `AGENTS.md` 里新加的「修 bug 必须交反向证据」是一对：
实现方交证据，审查方**自己动手破坏验证证据是真的**。

### V3. 分类要窄

> **Classify narrowly.** A mark or error class covers only the case it
> describes: `#873` counted every failure on a turn as "turned away".

**这条精确对应我们的 `skipped` 被复用**：验收第二轮发现 `skipped` 同时表示
「已有、保留本地」和「加密不可用、没导进来」，用户分不清。这就是分类太宽。

### V4. 预览/试运行不得有副作用

> **A preview writes nothing.** A dry run, plan or preview has no side effects (`#827`).

### V5. 不推翻已定的产品决策

> **Don't reverse deliberate decisions.** The scroll guard, the button cursor and
> other product decisions are the maintainer's to change.

### V6. 检查的是 vendor 的行为，不是 PR 自己的说法

> **Check the vendor, not the PR's account of it.** Read the upstream source for
> a vendor's behavior (`#870` read Codex's `uses_openai_actor_authorization`).

### V7. 保持 PR 只做它目标内的事

> **Keep the PR to its goal.** Unrelated tests and refactors go in a PR of their own.

### 安全前置扫描（`docs/contributors.md`，「Look for harm first」）

这条很值得我们抄 —— **在审查「做了什么」之前，先看「会不会害人」**。
任一命中就停下来等维护者：

- 改了 `.github/`、发布脚本、Dockerfile
- 新增网络地址、上传、遥测，或把凭据/token/cookie/文件发到它原来不去的地方
- 读写目标不需要的凭据文件、keychain、agent 配置
- 新增依赖、`replace`、npm install script、二进制、压缩或编码块、运行时拼出来的代码
- 新增中转/代理/推广地址

**对 DevaPlus 的直接对应**：导入功能正好碰「读写别人（原版）的配置和密钥」。
这条规则要求审查时**先声明「我读过哪些原版的敏感文件、为什么需要」**，
而不是只在 diff 里看逻辑。

---

## 三、设计 ← `code-standards.md` 的 `## GUI`

这一节短但硬，四条全是「不许」：

> - Every string the user sees goes through `t()` and gets its translations in `i18n.js`.
>   Tests run in Chinese and English.
> - Use no native `<select>`. Dropdowns use the app's own menu (`openProtoMenu`).
> - A click never scrolls the page (`scrollOnPurpose`).
> - Don't use colored left-border stripes. Mark state with a dot or a swatch.

还有验收标准第 4 条：

> **GUI tests in both engines.** ... The suite must also pass in Chinese,
> English, and `gui-zh-tw`/`gui-ja`/`gui-de` (every string has its
> Traditional Chinese, Japanese and German, with the same placeholders).
> CI doesn't run this suite, so it is run locally.

**对我们的对应**：我们的「设计」成员上次裁定了组头字号、折叠热区、行内信息维度，
这些都是对的，但**没有一条能被机械检查**。magpie 的做法是：设计裁决必须落成
「能用 grep 或脚本验的禁止项」，否则下一轮实现又会漂回去。

**给「设计」的任务模板该加一句**：裁决要给「怎么验」，不能只说「应该改成 12px」。

---

## 四、实现（主进程 / 界面）← `## What a change contains`

7 条硬规则，我在 `AGENTS.md` 里已经加了其中 2 条，剩下 5 条能对上我们的其他问题：

| magpie 规则 | 治我们哪个 bug |
| --- | --- |
| **A failed read, parse or hash means "unknown"** | `targetState` 读失败当坏了 ✅已加 |
| **A fix reaches every sibling of the bug** | 三处 `existsSync` 复制品 ✅已加 |
| **A change holds on the whole path** | 导入「报告 ok 但磁盘没写」 |
| **A change re-derives everything built on what it changes** | 改了复制 mtime → 清扫删空 |
| **Never let the default override a value the user set** | 批量替换模型时覆盖用户手选的 |
| **Nothing that can block runs under a lock its reader needs** | 并发/导出锁 |

### 「A change holds on the whole path」值得单独说

> Follow it from the user's input to the end result, through the callers, the
> state it changes and the side effects. **One correct function doesn't make
> the whole operation correct.** For example, an agent's model picks are saved
> under one id and read under another (#926). An update button doesn't update
> the binary that actually runs (#930).

**这正是我们 P0-A 的形状**：`mergeProviders()` 返回 `{failed}` 写对了，
但调用方丢掉了返回值 —— 单个函数对，整个操作错。

---

## 五、验收 ← `## Acceptance criteria` 6 条 + `## Merging and closing`

magpie 的验收是**6 条必须逐条声明「跑了没有、打印了什么」**，没跑的要写「未跑」，不许省略。

1. **撤掉改动后会失败的测试**。必须给出真实的 `FAIL` 和行为名；编译错误或跳过的测试不算。然后恢复改动、确认通过。
2. **沙箱里跑测试**。临时 HOME，Go 缓存钉住，**绝不读写真实的 agent 配置或 `~/.config/magpie`**。
3. **构建与全量套件**。`gofmt -l` 无输出、`go vet ./...`（含交叉编译的 linux/windows）、`go build`、`go test -tags nogui ./...`。要跑 `./...`，不是「你以为碰到的包」——仓库的守卫测试住在你不碰的包里。
4. **GUI 两种引擎 + 每种语言**（Chromium 与 WebKit，中英日德，占位符一致）。
5. **尽可能真机用一次**。「没试过真东西的东西，不建立在它之上，也不告诉用户它能用」。
6. **UI 规则**（`t()`、不用原生 `<select>`、点击不滚动、不用彩色左边条）。

### 验收是我们最该抄的一节

第 5 条我们做到了（测试成员真机跑了 Electron，40 次写入不丢），
**但第 3 条的「跑 `./...` 而不是你以为碰到的包」我们是漏的** ——
我们每次让成员跑 `driver.cjs` / `accept-driver.cjs`，而**守卫类的检查可能住在别的脚本里**。

### `## Merging and closing` 里三条对我们有用

**M1. 自己新写的测试红了，绝不合**

> **Never merge a PR whose own new test fails, or with known problems a review listed.**

**M2. 一个 issue 说了两个问题，两个都修完才关**

> **An issue that names two problems is closed when both are fixed.**
> `#2449` 的标题说了两个问题，修了第一个就关了，第二个两周后在 CI 上复发、没人认领。

**对我们直接对应**：我们的验收清单有 55 条断言（A1~A55）。
按这条规则，**「大部分通过」不许当交付**，必须逐条过，没过的显式列出并认领。

**M3. 保持 issue 打开，直到报告人的场景真的能用**

> **Keep the issue open until the reporter's case works. Reopen when they say it doesn't.**

---

## 六、测试 ← `## Verification` + `## Concurrency and tests`

`## Verification` 里有一条我原方案没提，但**直指我们「测试通过但结论不对」**：

> **A test that fails on `main` is a bug to fix now.**
> "Fails the same on origin/main" is not a baseline, and neither is
> "fails under the full run, passes alone". Fix it at its cause, or open an
> issue naming the cause, in a commit of its own, before shipping on top of it.

**我们的对应**：测试成员报告过「主进程说 driver.cjs 是 181 条，我实际跑出来 133 条」。
按这条，**数字对不上就是问题，要查清是口径不同还是断言被改**，不能「都是 0 FAIL 所以不影响结论」。

`## Concurrency and tests` 里两条：

**T1. 复现时序抖动靠注入延迟，不要靠重跑**

> Reproduce a timing flake by injecting the delay, not by rerunning until it fails.

**T2. 等待状态或计数，绝不等一个时长**

> **Wait for the state, or count what the test is about, never a duration.**
> 10-14 一天有五个测试因为固定等待在 CI 上红了。

**这条直接对应我们 P0-2 的 checkpoint 测试**：测试成员用的就是「把 mtime 手工改回 60 天前」
（注入条件），而不是反复重跑等它偶发 —— 方法正确。

---

## 七、架构 ← `## What a change contains` 的「整条路径」+ 并发规则

架构不是独立章节，它的规则散在两处：

**A1. `A change holds on the whole path`** —— 上面已引。

**A2. `Nothing that can block runs under a lock its reader needs`**

> Never send on a channel or call anything that can block while holding a lock
> the receiver takes first. Set shared state before the handoff that lets
> another goroutine look at it, and **a struct copied by value that holds a map
> is not a copy**.

**A3. `Work added to a path every request or poll takes is costed at that rate`**

> `644f4316f` 的 Codex 模型读取被挂在每 15 秒一次的 Sessions 轮询里。
> 改成只在调用/价格/身份变化时重读。

**这条对我们的并行功能直接有用**：架构定的 `worktree:list` 要算磁盘占用，
而遍历目录是 IO 密集 —— 它在规格 §T1.4b 里已经写了「缓存 + 后台刷新，首次 `null` 显示统计中」，
正是这条规则的落地。

---

## 八、8 个成员对应的规则，一览

| 成员 | magpie 对应章节 | 我们最该立刻补的一条 |
| --- | --- | --- |
| **需求** | `## Reading the report` | 读完全部线索到最后一句话；自己标的「待澄清」必须拍板不许带进实现 |
| **架构** | `What a change contains`（整条路径）+ 并发 + 高频路径成本 | 高频路径的每次调用都要按那个频率计成本 |
| **设计** | `## GUI`（4 条禁止项） | 设计裁决必须给「怎么验」，不能只说「应该改成 12px」 |
| **界面** | `What a change contains` + `## GUI` | 每个错误码两端（主进程定义 / 渲染层文案）同时改 |
| **主进程** | `What a change contains`（7 条） | 「整条路径」：一个函数对不等于整个操作对 |
| **审查** | `## Reviewing a PR`（12 条）+ harm scan | **自己动手破坏，验证反向证据是真的** |
| **测试** | `## Verification` + `## Concurrency and tests` | 「失败在 main 上也是 bug」；数字对不上要查清不是忽略 |
| **验收** | `## Acceptance criteria` 6 条 + `## Merging and closing` | 55 条断言逐条过，不许「大部分通过」当交付 |

---

## 九、一句话回答你的问题

**magpie 有分阶段规则，而且比编码规则更细。** 它的规则按「任务阶段」组织，
不是因为它是全自动才这样，而是因为**它踩过的坑分布在每个阶段**
（读需求读歪、审查只看 diff、验收「大部分通过」就发版）。

关键差别在形态：**每条规则都带 `Seen N×` 计数和证据**。
没有计数和证据的规则会变成口号；有了它，规则能自己判断该升级还是该删除。

**我们的 8 个成员各自的规则，现在只有「主进程 / 界面」这两个有硬约束（`AGENTS.md`）。**
其余六个靠的是成员自己的判断和我在任务里现写的要求 ——
这就是为什么每轮都要重新嘱咐一遍「要交反向证据」「要跑真实场景」。

**建议下一步**：把上面「最该立刻补的一条」逐条写进各自的派任务模板
（不是 `AGENTS.md`，因为它只放跨阶段硬约束）。
