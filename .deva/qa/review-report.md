# 审查：导入功能同类残留（扫描脚本修好后）

> 审查方交付。产品代码零改动；脚本在 `.deva/qa/`（gitignore）。

## 一、脚本修好了什么（自证）

`node .deva/qa/scan-same-class.cjs` → 退出码 1，抓出 4 条：

```
BARE  importer-config.ts:45   readFileSync  return JSON.parse(readFileSync(p, 'utf8')) as Cfg
BARE  importer-memory.ts:46   readFileSync  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }
BARE  importer-personas.ts:98  existsSync   if (existsSync(to)) {
BARE  importer-personas.ts:160 existsSync   if (existsSync(to)) return undefined // 已有同名头像：不覆盖
```

8 条 canary 全 PASS，无 STALE 豁免。`break-scan.cjs` 双向验证：

```
PASS 基线：当前树有 4 条待确认（符合预期）
PASS A1：mergeDir 回裸 existsSync → 变红
PASS A2：copySecrets 改回读失败当没有 → 变红
PASS A3：去掉 readProjectRoot 的失败通道 → 变红
PASS B：4 条真问题接上守卫后 → 扫描不再把它们报成 BARE（说明修复会被认）
```

**B 方向是我这轮最看重的一条**：如果扫描修好之后仍然报红，就会逼人把真 bug 登记成豁免，机制用两次就废。现在两个方向都通了。

修脚本过程中我自己又抓出 4 个「检查在跑但没查对」：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `:193` 的 `GUARD.test(win)` 豁免 | 同函数里有 `inspectTarget` 就整段放行——正是我注释里否决过的写法 |
| 2 | `argsOf` 把外层 `(` 也吐进返回值 | 实参变成 `(file, 'utf8')`，变量追踪全失效 |
| 3 | 内容文件判据只认字面量 | `readFileSync(file)` 归到 OTHER 直接丢弃，`copySecrets` 现场漏掉 |
| 4 | 调用方通道用固定 12 行窗口 | `readProjectRoot` 的 `failed.push` 被算到紧邻的 `readEntries` 头上 |

第 4 条尤其值得记：它是**误判成「有通道」**，方向是放过真 bug。改成「窗口看到下一个 `<x> = ...(` 就停」才修好。

## 二、四处残留（按严重度）

### P1 —— `importer-memory.ts:43-51` `readEntries`：读失败 → 用户全部记忆静默消失

```ts
function readEntries(file: string): RawEntry[] {
  try { … } catch { return [] }        // ← 读不出来 ≡ 没有记忆
}
```

调用方 `importMemories`（`:107`、`:118`）：

```ts
const global = mergeInto(readEntries(join(srcHome, 'memory.json')), GLOBAL_SCOPE)
…
const entries = readEntries(join(srcHome, 'projects', key, 'memory.json'))
if (!entries.length) continue          // 空数组 → 静默跳过，零失败记录
```

`memory.json` 被占用（EBUSY）、ACL 被改坏（EACCES）、或半截 JSON 时，**用户的全部记忆既不导入也不报错**，报告显示「记忆 0 条」，界面含义是「原版没有记忆」。

这与 `copySecrets` 刚修好的那条**完全同形**（源内容文件读失败被当成「没有」），`AGENTS.md` 第二节写的「读写失败 = 不知道」正是它的反例。而 `copySecrets` 的注释里已经写明这个道理（`importer-config.ts:167-172`），`readEntries` 没跟上。

**修法**：`catch` 里区分 `ENOENT`（正常，返回 `[]`）与其他错误（返回 `{entries: [], error}` 或抛出），调用方把 error 记成 `failed`（`reason: 'source-read-failed'`）。项目记忆那层还要注意：`readEntries` 返回空导致 `continue` 时，`readProjectRoot` 也是空，两条要一并处理。

### P1 —— `importer-config.ts:43-49` `readJson`：读失败 → 报告「0 个服务商」

```ts
function readJson(p: string): Cfg | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as Cfg } catch { return null }
}
```

调用方 `mergeProviders`（`:69-71`）：

```ts
const srcCfg = readJson(join(srcHome, 'config.json'))
const srcProviders = providersOf(srcCfg)
if (!srcProviders.length) return stat           // ← 直接返回空统计，零失败
```

源 `config.json` 读不出来时报告「服务商 0 个、ok 仍可能为真」，用户以为原版没配服务商——而这是整个导入里最值钱的一项（5 个自定义服务商、apiHost 要重配）。

**修法**：同 `readEntries`——区分 `ENOENT` 与读失败，后者记 `failed`（`reason: 'source-config-unreadable'`）。注意 `mergeProviders` 被调用**两次**（首次 + 收尾补回，`importer.ts:102`），第二次的失败也要汇总。

### P1 —— `importer-personas.ts:98` 角色本体：`inspectTarget` 被 `existsSync` 门住

```ts
if (existsSync(to)) {
  const probe = inspectTarget(to)          // ← 只有 existsSync 为 true 才执行
  if (probe.kind === 'unreadable') { … 记 failed … continue }
  if (!builtin) stat.skipped.push(id)
  continue
}
copyFileSync(from, to)                     // ← existsSync 为 false 时到这里
```

**这里要纠正一处判断**：上一轮主进程说这处「已修」，理由是 `:104` 接了 `inspectTarget`。**但守卫的位置错了**——`inspectTarget` 在 `existsSync` 为 true 的分支里，而真正危险的是 `existsSync` 为 false 的情况：

- 目标被独占占用（EBUSY）→ `existsSync` 返回 **false** → 直接 `copyFileSync`，而它**先截断再写**；
- 目标 ACL 坏了（EPERM/EACCES）→ 同样 false → 同样覆盖；
- 目标是断链的符号链接 → `existsSync` 对断链返回 false → 写入会穿过链接写到别处或失败。

也就是说 `inspectTarget` 守的是「**目标确实存在**」这条路径（那里最坏是记一条 skipped，本来就不危险），而危险路径（false → 覆盖）根本没经过它。**修了等于没修。**

**修法**：把 `inspectTarget` 提到 `existsSync` 之前：

```ts
const pos = inspectTarget(to)
if (pos.kind === 'unreadable') { …记 failed… ; continue }
if (pos.kind === 'blocked') { …记 failed… ; continue }
if (pos.kind !== 'absent') { /* 已有：skipped */ continue }
copyFileSync(from, to)
```

### P1 —— `importer-personas.ts:160` 头像：同一条，且更纯粹

```ts
if (existsSync(to)) return undefined   // 已有同名头像：不覆盖
mkdirSync(dstAvatars, { recursive: true })
copyFileSync(join(srcAvatars, name), to)
```

`existsSync` 返 false（被占 / 读不出 / 断链）→ 直接 `copyFileSync` 覆盖原头像。原头像是一张正常图片，此刻被顶掉；`copyFileSync` 非原子，中途失败连旧图也没了。

这是 Globeman 说的唯一真残留，确认成立。**修法**：与上一处同一形状，接 `inspectTarget` 后再决定复制/跳过，`unreadable`/`blocked` 走 `target-unreadable` / `target-blocked`（该函数已有 `avatar-copy-failed` 通道，加两个码即可）。

## 三、三句措辞（供 `MEMBERS.md`）

**1. GUI 边界**（写进「做不到」的例外）

> 我能跑到「主进程模块在独立进程里被真实调用」这一层（`.deva/qa/` 的 `repro-*.ts` + esbuild 打包 + electron 桩），以及 typecheck / 静态扫描 / 在副本上做破坏验证。**GUI 层我不做也不声称验过**：不重启 Electron、不点按钮、不看渲染结果；界面只做读代码 + i18n key 两端存在性核对。凡结论涉及「用户看到的文案/交互行为」，一律标注「未跑 GUI」。

**2. 有害扫描适用条件**

> **碰到下列任一项必须做，并声明读过哪些原版敏感文件、为什么需要、数据去向**：文件系统写、凭据/密钥读写、网络地址、依赖与构建配置、子进程。
> **纯文案、纯样式、纯类型改动的轮次声明「不适用」直接跳过**，不写等价套话。

**3. `A change holds on the whole path` 放到第 3 步正文**

> 3. **读 diff 并追溯整条路径**（`A change holds on the whole path`）：从用户输入到最终结果，穿过所有调用方、它改动的状态与副作用。**一个函数写对不等于整个操作对**——本轮 `mergeProviders` 算得对但收尾那次返回值被丢、`targetState` 判得对但会话写盘走了另一条分支、`inspectTarget` 写得对但被 `existsSync` 门在 false 分支之外，都是这个形状。

## 四、一条该沉淀的（关于我自己）

这轮我三次差点假绿，加上 ALLOW 两条理由写反，**全是同一类：验证手段本身没被验证**。

- `assocblk` 破坏用的是未导入的符号 → 报错触发断言失败，看着像「抓到了」；
- `unread` 破坏改的是 `targetState` 的 `readFileSync` 分支，而场景走的是 `inspectTarget` 的 `openSync` 分支 → 破坏点选错，等于没破坏；
- `ALLOW` 两条理由把 `existsSync` 返 false 的分支方向写反（说「不会覆盖」，实际会覆盖）；
- 扫描脚本 4 次「在跑但没查对」（上表）。

**审查这个角色最该防的不是「代码写错了」，是「检查看起来在跑，其实什么都没查到」。** 对策不是更仔细，是给每个检查配一个反向证据：

- 扫描脚本 → `break-scan.cjs`（拆守卫必须红、修好后必须绿，双向）；
- canary 清单 → 源码重构导致正则失效时**报错而不是通过**；
- 豁免清单 → 反向清理（片段不存在即 STALE）；
- 场景破坏 → 失败原因必须对得上，不是「红了就算」。

建议进 `LESSONS.md`，Seen 1×（本条）。下一次审查如果还出现同类，记 2×。

## 五、状态

- `npm run typecheck`（node + web）通过。
- 产品代码零改动，全部脚本在 `.deva/qa/`（`scan-same-class.cjs` / `break-scan.cjs` / `break-verify.cjs`）。
- 上面 4 条 P1 交给主进程修；修完重跑 `node .deva/qa/scan-same-class.cjs` 应回到「通过」，届时把对应 canary 的期望从 `BARE` 改成 `GUARDED`——**这一步不做，canary 会一直红**，提醒更新清单是刻意的。
