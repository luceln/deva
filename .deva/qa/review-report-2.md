# 审查复核：canary 更新 + 四条修复 + 两个新场景

> 审查方交付。产品代码零改动，脚本在 `.deva/qa/`（gitignore）。

## 一、canary 更新后的输出（全绿 + BARE 0 保住）

```
$ node .deva/qa/scan-same-class.cjs
汇总：BARE 0 / SWALLOW 0 / DISCARD 0 / CHECK 0 / GUARDED 24 / SRC 10

CANARY 自检：
  PASS importer-personas.ts:124 判成 GUARDED
  PASS importer-personas.ts:198 存在（锚点：头像四态）
  PASS importer-target.ts:62   判成 GUARDED
  PASS importer-sessions.ts:155 判成 GUARDED
  PASS importer-config.ts:205  判成 GUARDED
  PASS importer-config.ts:63   判成 GUARDED
  PASS importer-memory.ts:65   判成 GUARDED
  PASS importer-assoc.ts:183   判成 GUARDED
  PASS importer-memory.ts:159  存在（锚点：unreadable 必须转成 failed）

同类扫描通过：目标侧没有裸判断、没有静默吞读失败、没有丢弃返回值；豁免无过期项。
退出码=0
```

`break-scan.cjs` 7/7：

```
PASS 基线：当前树通过（四条已修，BARE 0）
PASS A1：mergeDir 回裸 existsSync → 变红
PASS A2：copySecrets 改回读失败当没有 → 变红
PASS A3：去掉 readMemoryFile 的失败通道 → 变红（DISCARD）
PASS B1：头像拆回裸 existsSync → 又变红
PASS B2：角色本体塞回 existsSync 真分支 → 又变红
PASS B3：readJson 拆回读失败当没有 → 又变红
PASS B4：readMemoryFile 拆回读失败当没有 → 又变红
```

**新加的 canary 类型 `EXISTS`**：只断言片段还在、不断言被判成什么类别。上一版有两条 canary 挂在 `const probe = inspectTarget(to)` 上——那行不含任何 fs 函数，扫描永远不会产出这一行，canary 自己报 NOT-DETECTED。**清单挂在扫不到的行上等于没挂**，这是我上轮犯过的同一个错（那次是 `inspectTarget` 在 assoc 里）。

顺带把 `inspectTarget / inspectDirTarget / lexists` 的调用点也登记成一类被扫描的行（现在 `GUARDED 24` 里有 11 条是守卫调用点），这样 canary 能直接钉在守卫上，也能一眼看出「这个文件接了几处守卫」。

## 二、我那个前提被推翻——确认你是对的

我自己实测了（不是听你说）：

| 情形 | `existsSync` | 撤掉守卫后 `copyFileSync` |
|---|---|---|
| 文件被 EBUSY 独占 | **true** | 抛 EBUSY（实测 `readFileSync` 也抛 EBUSY），**不覆盖** |
| 目录占位 | true | 抛 EPERM |
| 只读文件（`attrib +R`） | true | **成功覆盖** |
| 断链 junction | **false** | 抛 EPERM，**不覆盖** |
| 有效 junction | true | 抛 EPERM |

**本机构造不出「`existsSync` false 且原内容被覆盖」**，你的表准确。我原话「EBUSY 时 `existsSync` 返 false → 覆盖」是错的：EBUSY 时它是 true，走的是真分支。

canary 的 `why` 已按实测改写，现在的口径是两条：

1. **可移植性（本机无法验）**：POSIX 上 `existsSync` 跟随符号链接、断链返 false，而 `copyFileSync` 写断链 symlink 会沿链接写到目标并不抛错——那才是真正的写穿。本机 `symlinkSync` 一律 EPERM（无开发者模式），这条只能靠代码正确性保证。
2. **报告质量（本机能验，有反向证据）**：断链占位时旧代码走假分支 → `copyFileSync` 抛 EPERM → 外层 catch 记**原始英文系统消息**；新代码判 `blocked` → 记 `target-blocked`，界面有中文文案。`guardpath` 场景的第一条断言就是这个（`PASS 守卫位置：断链占位 → 记 target-blocked（不是外层 catch 抓来的原始 EPERM 消息）`）。

## 三、四条修复的独立复核

### ① 角色本体（`importer-personas.ts:107-128`）——修对了

四态判定**在复制之前**，不再被 `existsSync` 门住。`blocked` / `unreadable` / `usable` 各自 `continue`，只有 `absent` 落到 `copyFileSync`。注释还纠正了上一轮写在那里的错误结论（「裸 existsSync 在这里的误区比附件小」），这点我认可——那句话的前提就是我刚被推翻的那个。

### ② 头像（`importer-personas.ts:197-203`）——修对了

同形四态，`usable` 才不覆盖。失败经 `<id>#avatar` 单独成条，`known` 判断把 `target-blocked` / `target-unreadable` 原样传出，其余归 `avatar-copy-failed`。

### ③ `readJson` 三态（`importer-config.ts:55-70`）——修对了

`absent` / `ok` / `unreadable`，`mergeProviders` 在 `unreadable` 时返回带 `failed` 的空统计。这条是本轮最值钱的修复：服务商是导入里最值钱的一项，静默归零等于白导一次还查不出原因。

### ④ `readProjectRoot` 合并进 `readEntries`（`readMemoryFile`）——**我同意，且确认不引入新问题**

你问的是「这个合并会不会引入新问题」。我逐条核了：

- **原来两次读的窗口**：`readEntries` 读一次拿 entries，`readProjectRoot` 再读一次拿 root。两次之间内容被改（另一进程在写）会出现「entries 是 N 条的、root 来自另一版」。现在一次读、一并返回，窗口消失。**这是改进。**
- **`absent` 语义没变**：ENOENT → `{kind:'absent'}`，调用方 `continue`，与原来 `[]` + `if (!entries.length) continue` 等价。
- **新增的分支**：`unreadable` → 调用方 `projects.failed.push({ id: key, reason })`，比原来静默 `continue` 好。
- **`missing-root` 保留了**：`!read.root` 仍报 `missing-root`（那是「文件里真没写 root」，不是读失败），两种原因分开，符合 `Classify narrowly`。
- **一处细节没问题**：`if (read.kind === 'absent' || !read.entries.length) continue` 在 `unreadable` 之后，顺序对——不会把读失败当成空。

**唯一值得说的**：`importMemories` 里全局那条（`:140-144`）与项目那条（`:156-161`）现在是两份几乎相同的「unreadable → failed」代码。不是 bug，但如果以后要加第三种读取，会成为第三份复制。合并成一个 `failIfUnreadable(read, stat, id)` 之类的辅助会更稳。属 P3 建议，不必现在改。

### ⑤「角色本体失败后不报头像问题」——**我同意这个决定**

理由我认同并补一条：两条失败指向**同一个对象、同一个根因**（角色目录读不出来），而界面是按 `#read` / `#avatar` 分行的。若都报，用户看到「locked 读不出」「locked 头像失败」两条，会以为头像有独立问题、跑去修头像——那是不存在的问题。`guardpath` 用断言固定了这条（`PASS 守卫位置：本体已失败时不重复报头像失败`）。

**但要提醒一个前提**：这条只在「本体失败**导致**头像不会被尝试」时成立。现在代码靠 `continue` 保证（`unreadable`/`blocked` 直接跳过本角色剩余逻辑）。若以后有人把 `continue` 改成不 `continue`（比如想「头像独立于本体」），这条断言就会红——这是好事，它正好守住了那个隐含依赖。

## 四、`guardpath` / `srcread` 断言够不够严

### `guardpath`（11 条，全 PASS）——够严，但有一处我实测过的弱点

**够严的部分**：它用**断链 junction** 造出了「`existsSync` 返 false 而位置被占」这个唯一能区分守卫位置的情形（`:801` 专断言 `fs.existsSync(dstMd) === false`），然后断言失败原因是 `target-blocked` 而**不是**外层 catch 的 EPERM 原文。这条是真正的行为区分，撤掉守卫必红——`break-scan` 的 B1/B2 已验证。

**弱点**：「本体已失败时不重复报头像失败」这条（`:853-857`）我尝试破坏过——把 `continue` 去掉，场景**没红**。原因是那一步里头像也被独占，`copyAvatar` 的 `unreadable` 分支返回 `'target-unreadable'`，但角色本体已失败时 `copyAvatar` 本来就没被告知要跳过……我进一步查时源码正在改（引入 `readSourceDir`），场景跑到一半 `ReferenceError`。**所以这条断言我没能拿到干净的反向证据，如实报告：未验。** 你自己或测试那边值得补一次。

### `srcread`（8 条）——**现在有 6 条失效，原因不是产品回归**

```
FAIL P1-4：源 config.json 坏 → 报 source-config-corrupt       实际=[]
FAIL P1-4：整轮 ok=false                                        ok=undefined
FAIL P1-4：源 config.json 读不出 → 报 source-config-unreadable  实际=[]
FAIL P1-3：源全局 memory.json 坏 → 报 source-memory-corrupt     实际=[]
FAIL P1-3：整轮 ok=false                                        ok=undefined
FAIL P1-3：项目 memory.json 坏 → 报 source-memory-corrupt       []
PASS 对照组：源 config/memory 都不存在 → providers 无失败
PASS 对照组：源文件都不存在 → memories 无失败
```

`ok=undefined` 是关键线索：`runImport` 返回的是 `{error}` 而不是 report。实测拿到原文：

```
{"error":"原版的这部分数据读不出来（config.json）：请检查权限或关掉占用它的程序后重试；
          现在导入会静默丢掉这部分。"}
```

**这是主进程这轮新加的闸门级 fail-closed**（`importer-gate.ts:272-282`，`code: 'source-partially-unreadable'`）。它比场景要验的那一层**更早**拦住了：源 config.json 读不出来时，闸门直接拒绝整轮，`mergeProviders` / `importMemories` 根本不会执行。

**这是好事，不是回归**——fail closed 在导入场景完全正确（一次性导入，缺的那块永远缺）。但 `srcread` 的 6 条断言现在**验不到它想验的东西**了。三种处置，选一：

1. **改场景**：绕过闸门直接调 `mergeProviders(srcHome)` / `importMemories(srcHome)`，验第三态；另加一条断言验闸门拦截本身（`code === 'source-partially-unreadable'`）。**我推荐这个**——两条路径都该有覆盖。
2. 把 `srcread` 的期望改成「闸门拒绝」，放弃测下游三态（那三态就没测试了，不好）。
3. 删掉 `srcread`（更差）。

我倾向 1，但**这个场景要不要改、怎么改由你决定**，我只报事实。

### 其余 13 个场景我全跑了一遍

`unread 9 / skipsess 4 / memread 11 / readabsent 6 / assocblk 3 / assocprt 7 / compbad 4 / p0turn 4 / p0ckpt 2 / writefail 2 / reason2 4 / skipsec 5 / stalem 7` —— **全部 OK，fail=0**。闸门改动没有波及它们。

## 五、你问的第 3 点：我的方法里还有哪些没验过的前提

这是本轮最该答的。我把自己的检查手段逐条过了一遍，**凡是「我以为我知道、但没实测」的都列出来**：

### A. 已经验过、结论明确的

| 前提 | 验证方式 | 结论 |
|---|---|---|
| `existsSync` 返 false 时会被覆盖 | 本机实测 5 种占位 | **错**（EBUSY 时是 true） |
| 破坏脚本「替换原文找不到」会抛 | 有 `throw`，多次实际触发过 | 对 |
| 扫描能抓到裸 `existsSync` | `break-scan` A1/B1/B2 | 对 |
| 扫描修好后会变绿 | `break-scan` B3/B4 + 当前树退出码 0 | 对 |
| canary 在源码重构时报错而非通过 | 这轮 5 条 FAIL 就是它工作的证据 | 对 |
| 豁免清单会过期并报 STALE | 这轮删掉了 `existsSync(sourceHome)` 那条 | 对 |

### B. **没验过的**（我判断有风险，按风险排）

1. **`grep` 到某行就代表它在运行时生效** —— 本轮最贵的教训。`importer-personas.ts:98` 的 `inspectTarget` 在 `existsSync` 真分支里，grep 到了、断言它「已修」，**运行时危险路径根本不经过它**。我当时没跑场景就下了结论。现在这类判断我都要求有 `guardpath` 那种「两态可区分」的证据。

2. **我的正则/启发式判据「认得出的形态」是完备的** —— 这轮被打脸 5 次：
   - 只认字面量 `'secrets.json'`，漏掉别名变量 `file`；
   - 只认 `x.kind === 'unreadable'`，漏掉字符串联合 `x === 'unreadable'`；
   - 只认直接在 catch 里的 `failed.push`，漏掉「调用方才有通道」；
   - 只认 `failed.push`，漏掉「判断了但没上报」；
   - 只认 `return 空值`，漏掉 `catch { /* 只有注释 */ }`。**每一个都是「脚本说通过，而真 bug 在」**。这就是 canary 存在的理由，但 canary 只覆盖我**想到**的位置——没想到的形态仍然会静默通过。

3. **`break-scan` 的破坏「真的改到了代码」** —— 这轮 CRLF 问题：脚本模板写 LF、源码是 CRLF，`includes` 永远 false，`sub` 抛错（还好我写了抛）。但如果哪天我不写 `throw`、或者替换成功但改的是等价无影响的代码，破坏就变成了**假验证**。现在有了换行归一化 + 找不到就抛，但这仍是启发式。

4. **`callerChannels`（调用方有没有失败通道）是启发式** —— 按「赋值 + `if (!v)` + 附近 `failed.push`」判。它已经误判过两次（`readProjectRoot` 的 push 被算到 `readEntries` 头上、反过来也有）。**它只在该文件内、只看 26 行**。跨文件、跨函数、或用 `try/catch` 上报的形态一律看不到。

5. **场景数量 = 覆盖度** —— 我跑 15 个场景全绿就往上报。但「全绿」只说明「我想到的场景没炸」。特别是 `summarize`（闸门预览统计）那条路径，我只判断了「读失败记 0 只影响预览数字」，**没跑过任何一个「源目录读不出时点开导入面板」的场景**。用户看到的可能是「原版有 0 个会话」+ 按钮可点，而实际有 391 个——只是导入时会被新的 `source-partially-unreadable` 拦住。**这条我没验。**

6. **`skipsec` / 加密不可用那条链条** —— 它依赖 electron 桩的 `safeStorage`。真机上 DPAPI 的行为（尤其换 Windows 账户后密文解不开）**本机无法验**，我只能靠代码读。这类「桩比真实现宽松」的地方，我没系统列过清单。

7. **`AGENTS.md`「读写失败 = 不知道」这条在 `readdirSync` 层面到底覆盖到哪里** —— 主进程这轮新建 `readSourceDir` 声称覆盖 7 处。我核了当前实况：`readSourceDir` 出现在 assoc(2) / memory(1) / personas(1) / sessions(1) / skills(1)。剩下 `importer-personas.ts:182`（头像目录）在 `copyAvatar` 的 try 里、外层 catch 有返回通道；`importer-gate.ts:88/115`（预览统计）我登记为可接受。**但我没有独立手段证明「再没有第 8 处」**——这只能靠人再 grep 一遍，而 grep 本身就是我第 1 条说的不可靠手段。

### C. 结论与建议

我的方法论里有三类系统性弱点，与具体检查项无关：

- **「静态匹配认出的形态」< 「运行时可能出现的形态」**。静态扫描只能证明「我知道的那些形状不在了」，不能证明「没有别的形状」。所以它必须与场景测试配对，且场景要有**区分能力**（两态能分出不同结果），不能只是「跑通」。
- **「我的验证手段」本身需要反向证据**。这轮我在 break-scan 里加的双向断言（A 抓得到 + B 复发也抓得到）就是这条的落实。**建议推广成规范**：任何自动检查（lint/扫描/断言集）都要配一个「把被检查对象改坏，它必须红」的证据，否则视为未验证。
- **「本机验不了的」要单独标注，不能混进「已验」**。POSIX 符号链接、真机 DPAPI、GUI 渲染都属于这一类。我以后报告里会把「本机实测 / 代码推断 / 无法验证」三档分开写，不再用「查过没问题」一言以蔽之——那句话在本轮已经骗过我一次（`existsSync` 那条）。

## 六、状态

- `npm run typecheck`（node+web）通过。
- `scan-same-class.cjs` 退出码 0，`BARE 0` 保住，canary 9/9 PASS，无 STALE。
- `break-scan.cjs` 7/7 全按预期。
- 15 个场景中 14 个全绿；`srcread` 因**新闸门**提前拦截而有 6 条失效（非回归，处置见第四节）。
- 待办（需要人决定/动手）：`srcread` 场景改法（推荐绕过闸门直调下游 + 新加闸门拦截断言）；`importMemories` 两处 `unreadable → failed` 可考虑抽公共函数（P3）。

## 七、补记：这轮新增的两条判据经验（写进脚本注���）

审查过程中主进程仍在改代码，我的脚本被连续打脸 6 次后才稳定。两次是**判据过松**（比漏检更危险，因为它让破坏验证集体失灵）：

1. **`inTry` 豁免对 `existsSync` 不成立**。我一度写「读在 try 里就判 GUARDED」，结果 A1/B1/B2 三项破坏验证全绿——因为 `mergeDir` / `importPersonas` 的 try 里确实有 `failures.push`，注入的裸 `existsSync` 被一并放过。根因：**`existsSync` 在目标被占/打不开/断链时返回 false 而不抛异常**，try/catch 根本不会被触发，代码直接落到 `copyFileSync`。try/catch 只对「会抛的读」（`statSync`/`readFileSync`）有效。两类必须区别对待，现在 `existsSync` 无条件 BARE。

2. **`inTry` 本身也要收窄**：必须那个 catch 自己会**记录失败**（`failed.push` 或 `return` 一个非空 reason 交给调用方），否则 try 只是把异常吞成返回值，仍然静默。

第 1 条的发现路径值得记：**是破坏验证告诉我判据坏了，不是我读代码看出来的**。如果只有「当前树通过」这一个信号，我会把一套漏检的判据当成可用的。这正是双向破坏验证（A 抓得到 / B 复发也抓得到）存在的理由。
