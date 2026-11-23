# LESSONS.md

> 教训 → 规则 → **处置**。每条只有四样东西：一句话规则、为什么、证据、处置。
>
> ## 为什么改掉了 Seen 计数和「3× 才升级」

>
> 原来照搬 `yetone/magpie`（MIT）的机制：每条记 `Seen N×`（不同日子复现的次数），到 3× 升级进
> `AGENTS.md`。它成立的前提是 **magpie 每晚跑一次自动 review**——220 次提交/天，一晚上够攒出计数。
>
> 我们不成立：一天 0~2 次提交，四轮审查才攒出一个 3×。实测代价是——**S3「修一个 bug 扫同类」
> 攒到 3× 才升级，升级之后又复发两次**（第 9 处 `lexists`、第 10 处 `isFile`）。也就是说「等满 3 次」
> 让我们在**已经出过 2 次同类问题之后**还继续等。那是纯损失。
>
> 现在的做法：**出现即处置**。发现一次就问「这条能不能机械化」：
>
> | 处置 | 含义 | 落到哪 |
> | --- | --- | --- |
> | **建脚本** | 形状可判定 | `scan-same-class.cjs`（形状）+ `break-scan.cjs` / `break-allow.cjs`（反证） |
> | **改规则** | 每条任务都适用，且一句话说完 | `AGENTS.md` |
> | **不管** | 一次性、或已写进代码注释 | 什么都不做，本条从本文删掉 |
>
> **判断力优先搬到脚本里。** 能写成脚本的，绝不留在文字里——文字得有人记得读，脚本每次跑都会说话。

**审查到哪了：** `4659df8`（2026-11-17，同类扫描去掉 9 条从未参与判定的豁免）
**最近一次处置依据：** 2026-11-17 导入功能五轮修复循环 + `break-allow.cjs` 实测

---

## 一、已经机械化（不再作为文字规则）

**这些不再写规则，因为脚本每次跑都会检查。** 留在这里只为说明「哪条教训长成了哪个脚本」——
照着文字自查是重复劳动，跑脚本才是。

**M1. 静默失败：读失败 / 写失败不许伪装成「没有」「成功」「skipped」。**
→ **`scan-same-class.cjs`**：`BARE`（裸探测后直接 return/continue/记 skipped）、`SWALLOW`
（catch 里返回空值且不记失败）、`DISCARD`（用返回值表达失败的函数被当语句调用）、`SRC`（源侧目录列举）。
退出码非零即有待确认项。

**M2. 「已经存在」不许用裸 `existsSync`，「读不出来」不等于「不存在」。**
→ 同上，`BARE` 形状。产品侧统一走 `inspectTarget()` / `readSourceDir()` 等三态或四态读取器；
扫描器的 `GUARD` 正则认得这些名字。

**M3. 修一个 bug 必须扫同类，不许只修报告里那一个 case。**
→ **`scan-same-class.cjs`** 就是这条的机械形态：它不看你改了哪些 diff，只看「源码里还有没有同形状的」。
→ **`break-scan.cjs`** 证明它抓得到（拆守卫 → 必须变红），而不是自说自话。
→ 但注意：**扫描器只覆盖已知形状**，新形状（像 `isFile()` 把「不是文件」和「读不出」压成一种）仍需
人手加进去。所以下面 R1 保留。

**M4. 豁免（ALLOW）必须可证伪，不许只写一句理由。**
→ **`break-allow.cjs`**：判据 A（删掉这条豁免，扫描还绿 ⇒ 冗余，直接删）+ 判据 B（改坏它守的东西，
扫描必须红 ⇒ 理由被验证过）。**实测 13 条豁免里 10 条冗余、0 条可证伪**，现已删到 4 条。
→ 这条来自 magpie 的安全条款（`LESSONS.md:186-201`「Test the exemption with the real secret that
looks most like what it lets through」），我们把它变成了两个判据。

**M5. 改写源码片段锚定的验证脚本，样本会过期。**
→ **`break-scan.cjs`** 的 `SampleStale` + SKIP 汇总：样本找不到原文时记 SKIP 并**继续跑后面的项**，
不是 `throw` 崩掉整个脚本（崩溃 = 后面全没跑，外面只看到堆栈，正是「不报错但没生效」）。
→ 跳过数非零以非 0 退出码暴露；`--strict` 下跳过即失败。

---

## 二、还没机械化的（这些是真的需要人看）

每条给出「为什么这条没法机械化」——答不出来就说明它该进脚本，而不是留在本文。

**R1. 新增一种静默形态时，必须同时加进扫描器的形状表和破坏样本。**
为什么没法机械化：**发现新形状这件事本身不可判定**。扫描器只能查它认识的形状，
「这次这个 bug 长得不像以前任何一种」只能由人识别。
- 证据：第 10 处 `importer-personas.ts` 的 `statSync(from).isFile()`——把「不是普通文件」和「读不出来」
  压成一种，记 `skipped` 而非 `failed`。扫描器的四类形状（BARE/SWALLOW/DISCARD/SRC）都不覆盖 `isFile()`：
  `grep -c "isFile" .deva/qa/scan-same-class.cjs` 当时为 0。修好后产品侧统一走 `inspectSourceFile()`。
- 处置：**建脚本**（已在 `CANARY` 里钉住四态分支）+ 这条文字保留，因为它说的是「怎么把新形状**加进去**」，
  不是「去查有没有」。
- 落到哪：`AGENTS.md` 二、静默错误最后一条。

**R2. 改了一个值 / 一段语义，必须重算所有建立在它上面的东西。**
为什么没法机械化：**依赖关系不在代码里显式存在**。`copyFileSync` 保留源 mtime，
「启动清扫按 mtime 判年龄」是另一个文件里的常量，没有任何类型或断言把两者绑在一起。
- 证据：R2 `X1b`——复制保留源 mtime + 四处清扫按 mtime 判老（checkpoints 保留 30 天），
  源数据放超期后导入，首次启动就删空 2219 个备份；`copyFileFresh()` 复制后 `utimesSync` 刷当前时间修好。
  R2 `X3`——导入收尾调 `invalidateIndex()` 清了 `sessionCache`，正在跑那一轮的 `save()` 从此静默 return，
  产出直接不进盘；`invalidateIndexOnly()` 只清索引修好。
- 处置：**改规则**。清单固定为六项：清扫 / 保留期 / 缓存 / 列表索引 / 幂等判据 / 并发锁。
- 落到哪：`AGENTS.md` 二、静默错误。

**R3. 一个标记 / 错误码只能表示它字面描述的那一件事。**
为什么没法机械化：**语义宽度不可判定**。脚本能查「这个键有没有文案」，查不出
「`skipped` 这个词是不是同时装了两件事」。
- 证据：`skipped` 曾经同时表示「已有、保留本地」和「加密不可用、一个都没导进来」，用户无法区分
  （`acc/final-verify.txt:38`）；也装过真失败（`{"ok":true,"skipped":[...]}`）。现拆为
  `copied / skipped / ignored / noEncryption / invalid / failed` 六桶。
- 处置：**改规则**。新增任何 code / 桶 / 计数前，先写一句话「它描述的**唯一**情况是什么」；
  一个词要装两件事 → 拆两个；写不出那句话 → 它还是杂项桶。
- 落到哪：`AGENTS.md` 二。

**R4. 契约两端同一次改完：主进程新增的错误码，渲染层的文案键必须在同一个提交里存在。**
为什么没法机械化：**它可以机械化，只是还没有脚本**。这是本文里唯一一条「明知该进脚本但还没建」的。
- 证据：界面曾直接显示 `settings.import.reason.xxx` 原文。现在码集合（`FAILURE_REASON_KEY` 13 个）
  与两个语言字典（`messages.ts` 的 `reason.*`）已对齐，但**没有任何检查**：
  `.deva/qa/i18n-check.ts` 只反查 `ImportPane` 里出现过的 key，主进程新增第 14 个码它照样全绿。
- 处置：**建脚本（待办）**。断言 `码集合 - (FAILURE_REASON_KEY ∪ messages.zh ∪ messages.en) == 0`，非空即非零退出。
- 状态：**未建**。建好后本条从本文移进第一节。

**R5. 测试要等状态或等计数，绝不等一个时长。**
为什么没法机械化：能查到 `setTimeout(`，但**查不出它在等什么**。
- 证据：`test-main.ts` 有 `setTimeout(r2, 500)` 注释写「等子进程释放」——等时长不等状态，机器一慢就偶发绿。
  正例是 `verify-mtime.ts`：把 mtime 手工改回 60 天前**注入条件**，不靠反复重跑来撞。
- 处置：**改规则**。等的是 `state === 'done'` / `count === N` / 锁文件消失；要等超时就给可注入的 clock。
- 落到哪：`AGENTS.md`（与测试成员章程同步）。

**R6. 测试绝不许读写真实 `~/.deva`。**
为什么没法机械化：脚本能查环境变量，查不出「这个路径解析之后是不是真实目录」。
- 证据：`DEVA_HOME` 指向 `~/.deva` 时，导入器会删掉**原版**的 `data/chats/_index.json` 并把 `import.lock`
  写进原版。已被 `same-home` 闸门 + `G6`/`G7` 两条断言（原版零改动）挡住——**这条现在靠断言而非文字**。
- 处置：**建脚本（已完成）**。`G6`/`G7` 就是它的机械形态，本条降级为「知道有这回事」。
- 备注：这条是 M 类（已机械化）的候选，但断言在 `repro-accept.ts` 里而非独立脚本，先留在此处。

---

## 三、引用与裁决的卫生（magpie 的三条，我们原来没有）

**H1. 文档里的引用必须核对到源码，链接必须真的解析得开。**（对应 magpie `Docs match the source`）
为什么没法机械化：判断「这句话说的还是不是当前代码」需要读懂语义；能机械查的只有链接是否 404。
- 证据（本仓库自己的反例）：`notes/proposed/2026-11-18-rules-by-phase.md` 说「A7 的陷阱就是它自己标出来的」，
  而 `notes/archived/2026-11-18-worktree-parallel-scope-v3.md` 明确写 A7 是「**已拍板并改写场景**」——引用没核对，结论说反了。
  另一例：`AGENTS.md` 曾引用 `MEMBERS.md` 的行号，那份文件一改行号全漂。
- 处置：**改规则**。写「文件里的某处说了 X」之前，先把那处读一遍；引用优先写**函数名 / 小节名**，不写行号。
- 落到哪：`AGENTS.md` 五、维护这个文件。

**H2. 不许推翻已经拍板的设计决定；要翻，先问拍板的人。**（对应 magpie `Don't reverse deliberate decisions`）
为什么没法机械化：「哪些是拍板过的」不在代码里，在决议记录里。
- 证据：`.deva/design/rail-grouping.html` 裁定组头字号 / 折叠热区 / 行内信息维度，理由都写了；
  这些裁决此前**只活在 HTML 稿里**，产品代码里连类名都还没有，实现方随手改掉没人拦。
- 处置：**改规则** + 要求裁决带「怎么验」一列（见 H3）。
- 落到哪：`AGENTS.md` 二（设计相关）。

**H3. 设计裁决必须落成能用 grep 或断言验的禁止项；给不出验证方式的，标为「审美判断」，不算裁决。**
为什么没法机械化：裁决本身不是代码。但它**要求**必须有可机械化的那一半，所以这条是 H2 的执行细则。
- 证据：同上。对照 magpie 的 GUI 四条全是禁止项（走 `t()`、不用原生 `<select>`、点击不滚动、不用彩色左边条）。
- 处置：**改规则**。
- 落到哪：`MEMBERS.md` 的「设计」节（章程层，不占 `AGENTS.md` 的行数）。

**H4. 给函数名、别给行号。**（对应 magpie `Name functions instead of giving line numbers`）
为什么没法机械化：写文档时的选择。
- 证据：**本文自己就是反例**——上一版通篇 `importer-personas.ts:97`、`chat-store.ts:388-391` 这类行号，
  而本轮产品代码一改，这些行号全部失效。现在本文只保留「函数名 + 文件」，行号只在证据引用**当时的
  commit** 时出现。
- 处置：**改规则** + 本文已按此重写。
- 落到哪：`AGENTS.md` 五、维护这个文件。

**H5. 一次改动一个目标，能独立 revert。**（对应 magpie `One commit, one goal`）
为什么没法机械化：`git diff --stat` 能查规模（≤200 行 / ≤6 文件），查不出「这坨改动里混了两件事」。
- 证据：导入功能攒 3 天 2512 行、24 文件，四轮审查全对着同一坨 diff；`P2` 修完之后和 `P0` 混在一起，
  没法单独回退。
- 处置：**改规则**（规模上限可脚本查，混不混事只能人看）。
- 落到哪：`AGENTS.md` 四、提交时。

---

## 四、已处置（曾经是条目，现在已由脚本或代码注释承担）

删掉不等于不重要，等于**已经有人替你做这件事了**。

| 原条目 | 处置 | 现在由谁承担 |
| --- | --- | --- |
| 验收终止条件 = 清单翻完（原 T1） | 改规则 | `MEMBERS.md`「验收」节：`N/M 通过` + 每条一行 + 证据 |
| 断言总数对不上必须解释（原 T2） | 建脚本 | `driver.cjs` 末尾打印 `合计 N 条 / PASS n / FAIL m`；SKIP 单独列 |
| 守卫要跑全部入口（原 T3） | 建脚本 | CI（`.github/workflows/ci.yml`）固定跑 typecheck + build + scan + driver |
| 高频路径按频率计成本（原 O1） | 不管 | 已写进 `notes/implemented/2026-11-18-worktree-parallel-spec.md` §T1.4b 的设计里 |
| 需求待澄清必须拍板并标落位（原 O3） | 不管 | `notes/archived/2026-11-18-worktree-parallel-scope-v3.md` 第四节已把它做成固定格式 |

**已删除**（内容已被覆盖或从未复现）：`O2`（一次只做一件事 → 并入 H5）、
`D2`（i18n key 同步 → 并入 R4，等 R4 的脚本建好就有机械形态）、
`B3`（契约两端 → 并入 R4）、`T5`（不碰真实 `~/.deva` → 并入 R6）。

---

## 附：magpie 原机制的原文（保留出处，便于日后比对）

> magpie's code is written, reviewed, merged and released by agents. Each night the day's commits
> are reviewed for what had to be fixed again, what shouldn't have merged and what was verified too
> thinly. What we learned is kept here. Each lesson is a rule, then why, then the evidence.
> "Seen" counts the days a review found it. A lesson seen on 3 or more separate days moves into
> docs/code-standards.md.

我们**保留了**它的条目形态（规则 → 为什么 → 证据 → 处置）和「证据必须带 commit / 文件出处」，
**去掉了**计数与门槛——因为门槛的前提（每晚自动 review）在我们这里不存在。