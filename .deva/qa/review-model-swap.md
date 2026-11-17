# 模型切换（`5fd87a4`）只读审查：值得验什么

> 范围：`5fd87a4` 的 16 个文件（清单里列的 12 个，实际 16 个——多了 `redesign.css`、`app.css`、`store/modelSwap.ts`、`shared/chat-protocol.ts`）。
> 方式：只读代码，未运行任何脚本、未改任何文件。
> 基准：提交 body 声称的五件事。下面每一条都是**代码与那五件事之间的缝**。

---

## 一、真风险点清单（按严重程度）

### P1-1 `hasSecret` 判不出「密钥解不开」，体检会放行，用户看到的是 401

**位置**：`model-availability.ts:89` → `hasSecret(pid)`；对照 `providers/index.ts:50-67`、`secrets.ts:88-110`、`secrets.ts:142-145`

**会错在什么情况**：`readSecret` 已经改成三态（`absent` / `ok` / `unreadable`），`providers/index.ts` 也对 `unreadable` 专门报了「解不开」的 auth 错误。但可用性判定用的是 **`hasSecret`**，它只有 `Boolean(store[key])`——只看密文在不在，**不看能不能解开**。

于是：换 OS 账户 / 换机器 / Linux 缺 libsecret 时——
- `hasSecret` → `true` → `resolveAvailability` 返回 `ok: true`
- 轮前体检**放行**（提交声称的第 4 条没生效）
- 渲染层**不标红**（第 3 条也没生效）
- 请求发出去，`streamChat` 才报 `auth`「无法读取 X 的密钥：…」，
- 而这恰好是我们已经知道「换账户后必现」的那一类（见 `.deva/qa/stub-trust-boundary.md` 第 3 条）。

**后果**：本该在输入框上方红标提示「密钥解不开」，实际变成发送后一条 error。更糟的是 `recordTurnNotice('error')` 会把这条写进 `session.notices` 存盘，重启后仍在。

**怎么验**：把 `secrets.json` 里的密文改成一段无效 base64（或 `enc:` 前缀被破坏），并让 `safeStorage.isEncryptionAvailable()` 返回 true 而 `decryptString` 抛 → 调 `resolveAvailability('p:m')`：期望 `kind: 'nokey'` 或新增的 `unreadable`，**实际会返回 `{ok:true}`**。

---

### P1-2 `save` 返回 void 且吞异常，`applyModelSwap` 把「没写盘」算成「已替换」

**位置**：`model-swap.ts:123-132`；`chat-store.ts:517-531`

**会错在什么情况**：`save(id)` 是 `void`，内部 `catch { return }` 静默。`applyModelSwap` 在 `:123` 改内存态 `session.model = to`、`:124` 调 `saveProject(c.id)`、`:132` **无条件** `changed.push(...)`。

磁盘满 / 文件被占 / 权限错 → `save` 静默失败 → 内存里 `session.model` 已是 `to`（所以本次运行看起来对），**磁盘上还是旧值**。界面报「已替换 N 个」，重启后全变回去。

这正是项目刚修过 11 处的同形（`setEnabled` 从 void 改 boolean 后调用方丢弃返回值）。`config.ts:64` 的 `persist()` 已经改成返回 boolean 并有注释「导入器必须检查」，**`chat-store.save` 还没走到这一步**。

**后果**：用户以为换完了，重启后红标又全回来，且这次没有任何错误提示。这是本项目最危险的「不报错但没生效」。

**怎么验**：把目标会话文件设成只读（或在 `writeFileAtomic` 里注入抛错）→ 调 `applyModelSwap` → 期望 `changed` 里不含它、或整体 `{error}`；**实际 `changed.length === 1`**。反向：重启后重读该会话文件，`model` 仍是旧值。

---

### P1-3 配置/密钥库解析失败时判定方向错了：不是「放行」，是「全部标红」

**位置**：`model-availability.ts:75-95` 的 `try/catch`；`config.ts:47-58`、`secrets.ts:37-49`

**会错在什么情况**：`resolveAvailability` 的 `catch { return { ok: true } }` 注释说「配置读坏 → 放行」。但 `getConfig()` → `ensureLoaded()` **自己就把异常吞了**：

```ts
catch {
  // 首次运行 / 文件不存在 / 解析失败 —— 视为空配置
  config = {}
}
loaded = true
```

所以 `config.json` 内容坏（半截写入、手改坏）时，`getConfig()` 返回 `{}`、**不抛**，外层 `catch` 永远进不去。结果是 `providers = []` → 第一个 provider 就 `missing` → **全库会话标红，且体检拒绝所有发送**。

`secrets.ts:37-49` 同形（`catch → migrateLegacy()`，最终 `store = {}`），效果是「所有密钥都变成没配过」→ 全库 `nokey`。

**后果**：一次配置文件损坏 = 用户所有对话都不能发消息，且界面说「模型不可用」，用户完全找不到真正原因（该去修 `config.json`）。注释里写的「宁可放行」在代码里**从来没生效过**。

**怎么验**：把 `config.json` 写成 `{invalid` → 调 `resolveAvailability('任意:引用')` → 期望 `{ok:true}`（按注释的设计意图）；**实际 `{ok:false, kind:'missing'}`**。同一手法测 `secrets.json` → 期望放行，实际 `nokey`。

---

### P1-4 `keylessHost` 的 IPv6 判定永不生效

**位置**：`model-availability.ts:38-47`

**会错在什么情况**：代码比较 `h === '::1'`，但 `new URL('http://[::1]:11434/v1').hostname` 返回的是 **`'[::1]'`（带方括号）**。实测：

```
hostname= "[::1]"   host= "[::1]:11434"
与代码比较 u.hostname === '::1'  →  false
```

**后果**：用 `http://[::1]:11434` 配 Ollama 的用户（IPv6-only 环境很常见，或用户从 ollama 文档抄的 IPv6 地址），会被判成 `nokey` → 红标、体检拦截。提交声称的第 5 条（本机服务不要求密钥）在这一形态上失效。

**同时**：`0.0.0.0` 被当成"本机"是可疑的——它是「监听所有接口」的写法，作为**连接地址**在 Windows 上通常可用但语义不对；真正会用到的是 `host.docker.internal`（Docker Desktop 里的 Ollama，本机场景，但代码判成远端要求密钥）。

**怎么验**：`keylessHost('http://[::1]:11434/v1')` → 期望 `true`，**实际 `false`**。

---

### P2-5 「服务商禁用」与「模型禁用」被合并成两类，且界面文案完全相同

**位置**：`model-availability.ts:84`（provider 禁用 → `disabled`）vs `:87`（模型 `enabled === false` → **`missing`**）；`messages.ts:1357-1362`

**会错在什么情况**：
1. 用户只禁用了某个**模型**（服务商仍启用）→ 报 `missing`（"模型不可用"），措辞暗示"删了"，而实际是"你自己关掉的"。
2. 而真正的 `disabled`（服务商禁用）在界面上文案与 `missing` **一字不差**：
   ```
   missing:  '模型不可用，请换一个'
   disabled: '模型不可用，请换一个'
   ```
   两种 kind 在代码里分开、在用户眼里没区别。提交声称的「四类识别」实际是「**两类可见**（可换 / 缺密钥）+ 两类内部区分」。

**后果**：用户无法从界面得知"该去把服务商重新启用"（这是最省事的解法），只能被动换模型。

**怎么验**：禁用某服务商 → 打开替换对话框 → 看 `kind` 文案；再禁用某模型 → 同样看。两者文案应当可区分，实际相同。

---

### P2-6 `from` 被 trim 而 `c.ref` 是原文：脏数据会话被静默跳过

**位置**：`model-swap.ts:87-88`（`from = p.fromRef.trim()`）vs `:113`（`if (c.ref !== from)`）

**会错在什么情况**：会话里存的引用是 `" ollama:qwen3 "`（导入来的、手改配置的、旧版本留下的）。
- `resolveAvailability` 内部 `splitRef` 会 trim，所以**判它失效、标红**（正确）
- `applyModelSwap` 拿 `from = "ollama:qwen3"`（trim 后）和 `c.ref = " ollama:qwen3 "` 做 `!==` → **不相等**
- 于是它被推进 `skipped`，界面显示「跳过」，用户以为"这些是别的模型"

**后果**：标红了、也点了替换，但那条会话永远换不掉，而且界面给的解释是错的（"它用的是别的模型"，实际是同一个模型带空格）。用户只能自己去那条会话里手动换。

**怎么验**：把某会话的 `model` 字段写成 `" ollama:qwen3 "`（带空格）→ scan 应报它失效 → apply 后该会话 `model` 应变成 `to`；**实际仍在 `skipped` 里，磁盘值未变**。

---

### P2-7 体检拦截会在会话里留下持久错误记录、并顶起列表排序

**位置**：`chat-turns.ts:432-450`（抛错）→ `:695-699`（catch → `recordTurnNotice('error')`）→ `:700-723`（finally 改 `updatedAt` + `saveProject`）

**会错在什么情况**：用户点发送，模型失效被拦下：
- catch 里 `emit error` + `recordTurnNotice('error', message)` → 写进 `session.notices`（`after: history.length`）
- finally 里 `session.updatedAt = Date.now()` + `saveProject(sessionId)`

**后果**：
1. 一次失败的发送**永久**在会话里留一条 error 记录（重启后仍在）；
2. `updatedAt` 被刷新 → 左侧列表把这条对话顶到最前，用户会困惑"我没发出去，它怎么跳上去了"。

**好消息**（已核实，不必再查）：体检在 `history.push`（`:1002`）**之前**，所以不会留下一条发不出去的用户消息。这是本轮唯一让我放心的拦截设计。

**怎么验**：失效模型下发一条 → `session.notices` 里应无新增（按"根本没开始这一轮"的语义）；**实际多一条 `{kind:'error'}`**，且 `updatedAt` 变了。

---

### P2-8 替换的目标候选可能把「刚换的正被别的服务商占用」漏掉，也不会提示

**位置**：`ModelSwapDialog.tsx:71-88`

**会错在什么情况**：候选排除两类——`affected` 里出现过的 ref、`nokey` 服务商的全部模型。但 `affected` **只包含失效的**（`scanSessionsByModel` 只 push 非 ok 的）。所以：
- 一个**可用**但**同名不同服务商**的模型（`openai:gpt-4` 与 `azure:gpt-4`）：前缀不同所以 ref 不同，能正确排除/保留，这条没问题（我原本怀疑过，实测清分逻辑是对的）。
- 真正的缝：**`nokey` 只从 `affected` 反推**。若某服务商缺密钥但**没有任何会话引用它**，它不在 `affected` 里，它的模型**会出现在候选里**。用户从坏模型换到一个同样缺密钥的模型——正是注释里说要避免的那个坑，但只挡住了一半。

**后果**：改完还是不可用，用户再来一次。

**怎么验**：服务商 A（有坏会话）、服务商 B（同样缺密钥、但无会话引用）→ 打开对话框 → B 的模型应不出现在候选；**实际会出现**。

---

### P3-9 标红只覆盖「当前对话 + 成员」，左侧列表不标红

**位置**：`model-swap.ts:66-73`（`scanSessionsByModel(mainId)`）、`chat.tsx:1301-1315`（按 mainId 缓存）

**会错在什么情况**：`detectAllBrokenRefs`（`model-availability.ts:107`）看起来是为"全库扫描"准备的，但**全仓零调用**。标红只对当前打开的对话生效。

**后果**：用户要逐个点开每个对话才发现哪个坏了。提交声称的第 3 条（"输入框的模型胶囊标红"）**字面上做到了**，但用户视角的痛点是"我有多少个对话坏了"——这个数字界面上没有。

不算 bug，但属于"功能完成度与用户预期之间"的缝，值得在验收时明确「不做」还是「待做」。

---

### P3-10 并发：两次导入式并发替换没有互斥

**位置**：`model-swap.ts:107-133`（循环内 `getSession` + 改 + `save`，无锁）

**会错在什么情况**：两个窗口/两处代码同时 `applyModelSwap` 同一 mainId。因为 `getSession` 走 `loadSessionFile`（每次读盘），`session.model = to; save()` 之间没有互斥——后一次读到的可能是前一次写之前的内容，再写回去把前一次的改动抹掉。

**后果**：A 换成 X、B 换成 Y，最终只保留一个。项目里导入功能踩过同类（"一轮对话持对象引用，索引失效导致丢盘"）。

**实际风险**：低——批量替换是用户手动点、同 mainId 在同一窗口只能开一个对话框。但**跨窗口**（多窗口打开同一对话）没有防护。

**怎么验**：两路并发调 `chat:model-swap-apply` 同一 mainId、不同 `toRef` → 期望最后一次为准且两次都返回成功并说明；实际可能互相覆盖且都报成功。

---

## 二、值得写成断言的项

每条都写成「哪条命令失败能证明它没做到」。

| # | 断言 | 失败长什么样 |
| --- | --- | --- |
| 1 | `resolveAvailability('p:m')` 在有密文但解密抛错时，返回 `ok:false`（或新增 `kind:'unreadable'`） | 返回 `{ok:true}` → P1-1 没修 |
| 2 | `applyModelSwap` 对**写盘失败**的会话不得进 `changed` | `changed.length === 1` 而磁盘未变 → P1-2 没修 |
| 3 | `config.json` 内容坏时 `resolveAvailability` 返回 `ok:true`（按注释的设计意图） | 返回 `kind:'missing'` 且全库标红 → P1-3 没修 |
| 4 | `keylessHost('http://[::1]:11434/v1') === true` | 返回 `false` → P1-4 没修 |
| 5 | 禁用**模型**与禁用**服务商**得到的 `kind` 不同（`missing` vs `disabled`） | 两者都是 `missing` → P2-5 没修 |
| 6 | `i18n` 里 `kind.missing` 与 `kind.disabled` 文案不得相同 | 相同 → 用户看不出区别 |
| 7 | 会话 `model` 带首尾空格时，`applyModelSwap` 仍能改掉它（在 `changed` 里） | 落进 `skipped` → P2-6 没修 |
| 8 | 体检被拦下的一轮，`session.notices` 不得新增、`updatedAt` 不得变 | notices 多一条 / updatedAt 变 → P2-7 |
| 9 | 失效发送后 `session.messages` 长度不变（拦截必须早于 `history.push`） | 多一条 user 消息 → 拦截位置被挪到了 push 之后 |
| 10 | `nokey` 服务商即使**无会话引用**，其模型也不出现在替换候选里 | 出现 → P2-8 没修 |
| 11 | 替换目标本身失效时必须整批拒绝、一个都不改（已实现，`model-swap.ts:98-103`） | 改了任意一个 → 回归 |
| 12 | 空引用（`model === ''`）既不被替换、也不进 `skipped`（`model-swap.ts:110`） | 进了 `skipped` → 界面「跳过 N 个」被污染 |
| 13 | 定时任务遇到失效模型时**不拦截**、走 `resolveModelRefOrNull ?? resolveDefaultModel()` 两段回落 | 被体检拦下 → 提交声称的第 4 条后半句失效 |

---

## 三、看着可疑但实际没问题（下一轮不必重复查）

| 疑点 | 为什么排除 |
| --- | --- |
| `splitRef`（availability）与 `resolveRefStrict`（model-resolve）两处切分会不会不一致 | 逐形态比对过 9 个输入（含 `a:b:c`、`ollama:qwen3:8b`、首尾空格、空段）：**结论完全一致**。差别只在 `idx <= 0`（strict）vs `idx < 0`（availability），对首段为空的输入两者都判 null，无行为差异 |
| 「服务商被删」会不会被报成「缺密钥」 | 不会。判定顺序是 provider 存在 → `enabled` → model 存在 → 密钥，provider 缺失在 `:82` 就 return，走不到密钥判定 |
| 模型被删 vs 服务商被禁用，哪个先判 | 服务商 `enabled` 先判（`:84`），再判模型（`:87`）。顺序合理：服务商禁用了，模型存不存在都不重要 |
| `applyModelSwap` 会不会半截替换 | 目标校验（`:98`）在所有写操作之前，目标不可用则整批 return，一个都不改。**这条实现是对的** |
| 体检会不会留下发不出去的消息 | 不会。体检在 `:432`，`history.push` 在 `:1002`，拦截发生在写历史之前 |
| 体检抛错后 busy 标记会不会卡死 | 不会。`busySessions.delete` 在 `:720` 的 `finally` 里，抛错也会执行 |
| `syncTaskModel` 的 `return` 在循环内、只处理第一个任务 | 是既有写法（不在本次 diff），且 `findTaskBySession` 同形（`tasks.ts:115-117`）——一个 session 只绑一个任务由上游保证 |
| `members` 名单反查在 Composer 与 ChatFirstShell 两边口径会不会漂移 | 不会。两处都是 `s.members?.some(m => m.sessionId === currentSessionId)`，`ChatFirstShell:275-280` 与 `Composer:1039-1042` 一致 |
| `providers` 作为 effect 依赖会不会每轮重扫 | 不会。`providers` 是 `useState`（`models.tsx:127`），引用稳定，只在 `setProviders` 时变化 |
| `detectAllBrokenRefs` 是死代码 → 是不是漏接了 | 是死代码（全仓零调用），但**不是漏接**：标红的设计范围就是「当前对话 + 成员」。它更像预留接口。已在 P3-9 记录范围问题 |
| 替换对话框「点了取消但已经改了数据」 | 不会。取消/关闭只是 `onClose()`，写操作全部在 `run()` 里，只有点「替换」才触发 |
| i18n 键是否齐全 | 齐全。`kind` 四个键（`missing`/`disabled`/`malformed`/`nokey`）中英都有 |

---

## 四、必须读代码才能确认、跑测试确认不了的项

| # | 项 | 为什么测试确认不了 |
| --- | --- | --- |
| 1 | **`ensureLoaded` 吞异常导致判定方向反转**（P1-3） | 要造「配置文件内容坏」需要先让进程内的 `loaded` 为 false。测试里 `loaded` 一旦置 true 就不再重读——**同一个进程内无法重复造这两个状态**，必须每场景独立进程。而且这条的正确修法是「`ensureLoaded` 区分 absent 与 corrupt 并上报」，属于设计决策，不是行为断言能锁住的 |
| 2 | **`hasSecret` 与 `readSecret` 的口径分歧**（P1-1） | 桩的 `safeStorage.decryptString` 永不抛，所以「有密文但解不开」这个状态在测试里**造不出来**（见 `stub-trust-boundary.md` 第 3 条）。只能靠静态核对「可用性判定用的是 `hasSecret` 而请求用的是 `readSecret`」这个事实 |
| 3 | **`save` 写盘失败被算成成功**（P1-2） | 要造写盘失败，得让 `writeFileAtomic` 抛——但它内部已 catch。可注入只读文件，但那会让 `writeFileAtomic` 走它自己的兜底路径，**测出的可能不是同一条失败分支**。这条更可靠的做法是读代码确认「`save` 返回 void」 |
| 4 | **IPv6 `[::1]`**（P1-4） | 单测能抓到，但**要有那条断言**。当前无任何测试，所以只能读代码发现 `hostname` 带方括号 |
| 5 | **四类 kind 与界面文案的对应**（P2-5） | 需要人判断「界面把两类的文案写成同一个，算不算没做到四类识别」——这是产品判断，不是行为断言 |
| 6 | **替换范围的语义**（P3-9） | 需要需求文档才能回答「标红该覆盖左侧列表吗」。代码按「当前对话」实现，无法从代码判断这是不是本意 |
| 7 | **定时任务跳过体检的合理性**（`chat-turns.ts:432`） | 代码注释说「无人值守，拦下来只会静默失败」。这个取舍合理，但**没人验证过**定时任务在模型失效时到底表现成什么（`runScheduledTurn:809` 有「未配置可用默认模型」的报错，但那条只在**两段回落都失败**时触发）。需要真跑一次定时任务才知道 |

---

## 五、一句话结论

**这批代码的问题不在"没写"，在"写了两套"**：

- 密钥有 `hasSecret`（在不在）与 `readSecret`（能不能解开）两套口径，可用性判定接了前者、请求接了后者 → P1-1
- 「配置读坏就放行」在注释里有一套、在 `ensureLoaded` 里是另一套（判成空配置→全标红）→ P1-3
- 「四类识别」在类型里是四类、在用户眼前是两类 → P2-5
- `from` 在比较前 trim 了一次、`c.ref` 没 trim → P2-6

以及一个同形老账：`save` 返回 void 且吞异常，`applyModelSwap` 无条件把它算成成功 → P1-2（就是项目刚修过 11 处的那种）

**优先级建议**：P1-1 / P1-2 / P1-3 先修（都是"不报错但没生效"类），P1-4、P2-5、P2-6 次之，P3-9 需要产品决定范围。

**没能验到的**：所有运行时行为（只读审查，未跑任何脚本）。上面每条"怎么验"都是设计好的验证步骤，不是已经执行过的结论。