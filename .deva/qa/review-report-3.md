# 导入功能代码审查报告（第三轮）

> 审查对象：`apps/desktop/src/main/importer*.ts` + `services/{config,secrets,chat-store}.ts` 相关路径
> 产品代码改动：**零**（本轮只改 / 新增 `.deva/qa/` 下的审查脚本）
> 脚本：`.deva/qa/{scan-same-class,break-scan,break-guardpath,break-verify}.cjs`、`repro-accept.ts`（17 场景）

---

## 一、已验证

### 1.1 场景总表（全部实跑，非引用）

`node .deva/qa/repro-accept.cjs` → **17 场景 / 122 条断言 / 0 失败 / 退出码 0**

| 场景 | 条数 | 验什么 |
| --- | --- | --- |
| p0turn | 4 | 导入收尾不清 sessionCache（否则该轮产出静默丢盘） |
| p0ckpt | 2 | 复制后 utimesSync 到当前时间（否则超保留期被清扫删空） |
| skipsess | 4 | 已存在的会话跳过、不覆盖 |
| skipsec | 5 | 密钥密文原样搬运（**仅字节搬运，见 §二.1**） |
| unread | 9 | 目标四态 `absent/usable/blocked/unreadable` |
| stalem | 7 | 项目记忆 root 缺失单独报 `missing-root` |
| writefail | 2 | 写失败有通道 |
| reason2 | 4 | 失败 reason 分类正确 |
| assocblk | 3 | 附件目标 blocked |
| assocprt | 7 | 附件 partial（源有、目标占） |
| compbad | 4 | compacted 内容坏 |
| memread | 11 | 记忆读失败三态 |
| readabsent | 6 | 「真的不存在」不被误报为失败 |
| guardpath | 13 | 角色本体/头像守卫位置（含新补的反向证据） |
| **srcread** | **17** | 源内容文件第三态（下游直调 + 闸门两层 + 反向） |
| **srcdir** | **16** | **8 个源目录逐个换同名文件**（行为验证，替代 grep） |
| **gatepartial** | **8** | 闸门 fail-closed + 「真的空」对照 + 反向可区分 |

### 1.2 `srcread` 两层结构（按要求的改法）

闸门 fail-closed 后 `runImport` 永远走不到下游，所以拆成两层：

**下游层（绕过闸门直调）**
- `mergeProviders(srcHome)`：config 内容坏 → `source-config-corrupt`、`copied: []`；config 独占 → `source-config-unreadable`、`copied: []`
- `importMemories(srcHome)`：全局 memory 坏 → `source-memory-corrupt`；项目 memory 坏 → 该 key 报 `source-memory-corrupt`
- **项目记忆成功路径**（以前零覆盖）：好的项目记忆必须真的 `added.length === 1`
  —— 这条是区分「报错通道通」与「整段逻辑没跑」的关键，见 §3.1

**闸门层**
- memory.json 被独占 → `ok:false` / `code:'source-partially-unreadable'` / 文案点名 memory.json / `runImport` 返回 `{error}` 而非报告
- **反向**：memory.json **内容坏**时必须**放行**（`ok:true`），由导入器逐条上报 `source-memory-corrupt`
  —— 与上一条成对，避免把「闸门恒拒绝」当成对

### 1.3 `srcdir`：8 个源目录的完整行为验证表（不依赖 grep）

方法：把每个源目录**逐个换成同名文件**（`readdirSync` 抛 ENOTDIR），断言 ①闸门 `{error}` ②底层函数 `failed` 里有对应条目。

| # | 源目录 | 失败 id | 底层函数 | 闸门 | 底层上报 |
| --- | --- | --- | --- | --- | --- |
| 1 | `data/chats` | `<data/chats>` | importSessions | PASS | PASS |
| 2 | `personas` | `<personas>` | importPersonas | PASS | PASS |
| 3 | `skills` | `<skills>` | importSkills | PASS | PASS |
| 4 | `data/media` | `<data/media>` | copyAssoc | PASS | PASS |
| 5 | `data/checkpoints` | `<checkpoints>` | copyAssoc | PASS | PASS |
| 6 | **`data/subagents`** | `<subagents>` | copyAssoc | PASS | PASS |
| 7 | `projects` | `<projects>` | importMemories | PASS | PASS |
| 8 | `data/tool-results` | `<toolResults>` | copyAssoc | PASS | PASS |

**结论：没有第 8 处静默点（原 7 处 + 新增 subagents 共 8 个目录，全部守住）。**
`data/subagents` 是本轮补进表的：它与 checkpoints 共用 `mergeDir`，但共用函数只保证逻辑一致，
不保证调用点没漏——所以必须单独占一次。

名单来源不是 grep `readdirSync`，而是 `importer-gate.ts` `summarize()` 的字段表（12 项）——
它是「闸门会看的源」的完整定义。这是本条能替代 grep 的原因：**用行为验证 + 用定义表枚举，两个都不依赖模式匹配**。

### 1.4 `guardpath` 的反向证据（本轮补齐）

新增两条按轮判定（不能把两轮并起来看——并起来必然两条都有，我第一版就这么写错了）：

- ② 本体+头像都被独占那轮：`failed` 只有 `locked#read`、**没有** `locked#avatar`
- ③ 只有头像被独占那轮：只有 `locked#avatar`、**没有** `locked#read`

**反向证据**（`.deva/qa/break-guardpath.cjs`，2/2）：
```
PASS 基线：guardpath 13 条全过
PASS 破坏 1：去掉 unreadable 的提前返回 → ② 「只有 #read」那条变红
     FAIL ② ... :: ["locked"]
PASS 破坏 2：头像永不尝试 → ③ 「只有 #avatar」那条变红（证明它不是恒真）
     FAIL ③ ... :: []
```

**同时得到一个要如实说的发现**：那条 `continue` 在本场景里其实是**冗余的**。
去掉它之后，紧随的 `copyFileSync` 会抛 EBUSY、被外层 catch 记成一条 `locked`（原始消息），
头像仍然没被尝试——所以「没有 #avatar」照样成立。真正被断言保护住的是
**`unreadable` 分支整体存在**（没有它就会落到 absent → copy → copyAvatar）。
那条 `continue` 守的是「目标可写但读不出」这种少见组合，本机构造不出来。

### 1.5 三个系统性弱点的落地

**① 静态匹配的边界 → 已让它在输出里可见**
`scan-same-class.cjs` **每次运行都打印**（不论通过与否）：
```
边界：本扫描只覆盖已知形状（BARE/SWALLOW/DISCARD/源侧四类），无法证明「没有别的形状」。行为验证见 repro-accept 的场景表（srcdir / srcread / guardpath）。
```

**② 破坏验证本身的验证 → 已加，并当场抓出两个真问题**
`break-scan.cjs` 的 `sub()` 现在做三道检查（写回后内容与原文不同 / 新片段在 / **旧片段不在**），
外加 `selfCheckSub()` 对这三道检查做反证（4 条自检全 PASS）。`{ keepOld: true }` 仅用于插入型破坏。

它当场抓出的两个问题：
- A1 原写法是「插入新代码但保留原守卫」，被第 3 道检查拦下 → 两套逻辑会同时生效，破坏出来的结果没有解释力
- **A3 三轮抓不到东西的真根因**：`EXIST_FNS` 里包含 `readMemoryFile`/`readJson`/`readSourceDir`，
  所以 `const read = readMemoryFile(file)` 先命中 `if (fn)` 分支、在 513 行无条件 `return`，
  **永远走不到 DISCARD 段**——DISCARD 判据对这三个函数形同虚设。
  已修（三态读取器的**赋值形态**先交给 DISCARD 判定），现在 A3 能红。

**③ 报告结构 → 就是本文这三栏**

### 1.6 扫描器当前状态

```
汇总：BARE 0 / SWALLOW 0 / DISCARD 0 / CHECK 1 / GUARDED 41 / SRC 0
canary 17/17 PASS，退出码 0
```
`CHECK 1` 是 `importer-assoc.ts:129` 的 `statSync(from).size` 写后校验（有 catch 通道，非待确认项）。
源侧识别统计为「21 处（其中已守卫 20 处）」，差的正是这一条 `CHECK`——它不是豁免，是被 `kind` 分类成
「需要人看一眼」而不是「已守卫」，所以不计入已守卫数。顺带清掉一条 STALE 豁免
（`importer-gate.ts` 旧 `countInJson` 写法，三态化后已不存在）。

---

## 二、未能验证

| # | 内容 | 原因 |
| --- | --- | --- |
| 1 | `skipsec` 的密钥在**真机换账户/换机器**后能否解开 | 桩的 `safeStorage` 是 `enc:<明文>` base64，永不抛。真机 DPAPI 绑账户，换账户必解不开。本机无法模拟。**且已核实**：`services/secrets.ts:76-80` 的 `getSecret` 是 `catch { return null }`——真机解不开时抛 → 被吞 → 与「没配过」同形（详见 `stub-trust-boundary.md` 第 3 条） |
| 2 | POSIX 断链 symlink 的写穿行为 | 本机是 Windows。Windows junction 断链时 `existsSync` 返回 false 且 `copyFileSync` 抛 EPERM（不覆盖）；POSIX 断链 symlink 会写穿到链接目标。**本机造不出「false 且被覆盖」** |
| 3 | 真实 Electron 启动时序 / GUI 行为 | 桩的 `whenReady` 立即 resolve、窗口是空 class。导入在真实启动链路里的行为只有 `realmachine/` 那套真机脚本能验，本轮未跑 |
| 4 | 导入报告的 IPC 序列化 | 本批 122 条断言**全是直调函数**，没有一条经过真实 `ipcRenderer.invoke` 往返。报告里塞不可序列化对象会真机抛、测试全绿 |
| 5 | `showOpenDialog` 返回坏源目录的入口 | 桩恒返回 `{canceled: true}`。`srcdir`/`srcread` 是直接改写 `SRC` 常量绕过入口的，**「用户选了一个读不出来的目录」这个入口从来没被真正走过** |
| 6 | 目标被其他进程长期占用（EBUSY）下的并发导入 | 只能靠 `holdExclusive` 短时占用。两次导入并发、导入中途被清扫线程介入等时序未验 |
| 7 | 大文件 / 磁盘满（ENOSPC）中途失败 | 未造 ENOSPC。写一半的文件在下次导入时的行为（属目标四态 `blocked` 分支）未在真实磁盘满条件下验 |

---

## 三、已知盲区

| # | 盲区 | 后果 |
| --- | --- | --- |
| 1 | **`scan-same-class.cjs` 只能证明「已知形状不在了」** | 没写进判据的形状它看不见。本轮就漏过 6 种：别名变量、字符串联合、调用方才有的通道、判断了但没上报、`catch{/*只有注释*/}`、跨行块注释 `silent-ok`。**所以绿 exit 0 不等于这一类 bug 不存在**，必须配合 `srcdir`/`srcread` 的行为表看 |
| 2 | **`callerChannels` / `silentOk` / DISCARD 的块体配对都是启发式** | 已误判过至少 3 次（`readEntries` 被 `missing-root` 误判为有通道、sessions 的 `} else if` 块体被截断、A3 的 `EXIST_FNS` 顺序陷阱）。它们判「有通道」时可信度高于判「没通道」 |
| 3 | **判据过松比漏检更危险** | 我一度写「读在 try 里就判 GUARDED」，导致 A1/B1/B2 三项破坏验证集体变绿——因为 `mergeDir`/`importPersonas` 的 try 里确实有 `failures.push`，注入的裸 `existsSync` 被一并放过。根因：`existsSync` 在目标被占时**返 false 而不抛**，try/catch 根本不触发。**发现路径是破坏验证，不是读代码** |
| 4 | **只有正向信号时无法发现自己漏检** | 如果只有「当前树通过」这一个信号，我会把一套漏检的判据当成可用的。A3 就是这样连续三轮假绿的——直到我加「破坏是否真的改到代码」的自检 + 逐个探针才挖出 `EXIST_FNS` 顺序陷阱 |
| 5 | 桩的 12 处宽松（见 `stub-trust-boundary.md`） | 定义所有主进程测试的信任边界。最高风险是 safeStorage 的 3 条与「对话框恒 canceled」1 条 |
| 6 | `summarize` 的预览统计仍允许「读失败记 0」 | 已登记为**可接受**取舍（只影响按钮旁「将导入 N 个」的数字，不参与写入）。但这个取舍依赖闸门 `unreadable` 拦住整轮——若哪天闸门被放宽，预览就会退回「0 个 + 按钮可点」 |
| 7 | 「第 9 处静默点」无法证明不存在 | 本轮把名单对齐到 `summarize()` 的 12 个字段、8 个目录全部行为验证。但这是「按定义表枚举」——如果某个源既不在 summarize 里、也不在我的目录表里（比如将来新增的数据类别），两边都看不见 |

---

## 四、需要主进程决定的两件事

1. **`withTypes` 漏传已修好，但没有任何场景会再抓到它。**
   我审查中发现 `importer-memory.ts:154` 的 `readSourceDir(join(srcHome,'projects'))` 缺 `withTypes`，
   导致 `projectDirs` 恒为空、**项目记忆整段逻辑从未执行**；我加的两条断言（项目记忆坏要报、好的要导进来）
   判到了 FAIL。随后主进程已改为 `readSourceDir(..., true)`，`srcread` 现在 17 条全过。
   建议把这两条断言保留为常驻回归——**它们是唯一能发现这个 bug 的场景**（`srcdir` 抓不到：
   `projects` 换成文件时 `readSourceDir` 仍会报 unreadable，与 `withTypes` 无关）。

2. **`getSecret` 的 `catch { return null }` 建议改成三态。**
   `services/secrets.ts:76-80`：真机换账户后 DPAPI 解不开 → 抛 → 吞 → 返回 `null`，
   与「这个 provider 没配过密钥」完全同形。这是本项目判据（读失败≠没有）在 secrets 侧的**唯一缺口**，
   而恰好是本机无法验证的那一块。改法：返回 `{kind:'ok'|'absent'|'unreadable'}`，
   让调用方能区分「没配」和「配了但解不开」并给出对应文案。

> 本报告不含「查过没问题」这类表述：每条结论要么附场景/断言的实跑输出，要么进 §二/§三 说明为什么没验、后果是什么。
