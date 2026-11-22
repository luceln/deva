import { app, ipcMain, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './atomic-write'
import type { ConfigChangedEvent, ConfigSetResult } from '../../shared/config-protocol'
import { DEVA_HOME_DIRNAME } from '../../shared/brand'

/**
 * 应用配置存储（主进程）。
 * 非敏感的用户配置（主题 / 语言 / 服务商与模型 / 默认模型等）以**明文 JSON** 存于
 * `~/.deva-plus/config.json`，开发者可手改 / 备份 / 版本化（对标 ~/.claude）。
 * 根目录可用环境变量 `DEVA_HOME` 覆盖（便携安装 / 测试 / CI）。
 * **敏感信息（API 密钥）绝不进此文件**——见 services/secrets.ts（safeStorage 加密的 secrets.json）。
 * 详见 docs/architecture/security.md。
 */

let home = ''

/**
 * DevaPlus 配置根目录：DEVA_HOME 覆盖，否则 ~/.deva-plus。首次调用即确保目录存在。
 *
 * 目录名与上游的 ~/.deva 分开（DevaPlus 与 Deva 要能同时运行）：共用同一个目录会让两个独立进程同时写
 * config.json / _index.json，彼此覆盖，且没有锁拦着——比"跑 dev 看了眼数据"严重得多。
 * 不跟随 productName / app name 走，是刻意的：DEVA_HOME 与这里都是用户可预期的固定路径（文档、脚本、备份都引用它）。
 * 也不从 ~/.deva 搬任何东西过来：新装的 DevaPlus 就是全新安装的样子（预置服务商连接信息、零模型、零密钥），
 * 用户自己配置；把上游的用户资产搬过来属于"与上游同步"，是独立的功能，不该藏在启动路径里。
 */
export function getDevaHome(): string {
  if (home) return home
  const override = process.env.DEVA_HOME?.trim()
  home = override && override.length > 0 ? override : join(app.getPath('home'), DEVA_HOME_DIRNAME)
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
  } catch {
    /* 目录创建失败：后续读写各自兜底，不阻断启动 */
  }
  return home
}

function configPath(): string {
  return join(getDevaHome(), 'config.json')
}

let config: Record<string, unknown> = {}
let loaded = false

/**
 * 首次载入的结果，**只在 `ensureLoaded` 里记一次**。
 *
 * 为什么需要它：`ensureLoaded` 把「文件不存在」与「内容解析不了」折成同一个 `{}`——对绝大多数调用方
 * 这是对的（读不到就当没配过，别把启动搞崩）。但可用性判定**必须分清**：配置读坏时若当成「一个服务商都
 * 没有」，就会把全库会话判成 `missing`、体检拒绝所有发送，界面还说「模型不可用」，用户根本找不到真正
 * 原因（该去修 config.json）。这两态的差别只在错误发生的那一刻能看到，事后内存里只剩 `{}`，故必须当时记下。
 *
 * 值：
 *  - `ok`：读到了并且解析成对象；
 *  - `absent`：文件不存在（ENOENT）——真的没配过；
 *  - `corrupt`：文件在但读不出/解析不了（半截写入、手改坏、权限）——**不知道里面有什么**。
 */
export type ConfigLoadKind = 'ok' | 'absent' | 'corrupt'
let loadKind: ConfigLoadKind = 'ok'

/**
 * 内存态是否曾经与磁盘对齐过（载入成功，或本进程写盘成功过）。
 *
 * 用来区分「首次初始化」与「用户把配置文件删了」：两者 `readFileSync` 都是 ENOENT，但前者该写第一份，
 * 后者**不能**把用户主动删掉的配置静默复活（那等于撤销用户的操作）。
 */
let baselineEstablished = false

/** 同步载入（配置很小；同步读简化了首帧同步 IPC）。 */
function ensureLoaded(): void {
  if (loaded) return
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      config = parsed as Record<string, unknown>
      loadKind = 'ok'
      baselineEstablished = true
    } else {
      // 解析成非对象（字符串 / 数字 / null）：内容不合约定，等同坏文件
      loadKind = 'corrupt'
    }
  } catch (e) {
    /*
     * 分两种，别一起折成 `{}`：
     *  - ENOENT → 真没配过，`absent`；
     *  - 其它（JSON 语法错、EACCES、EBUSY）→ **不知道里面有什么**，`corrupt`。
     */
    config = {}
    loadKind = (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'corrupt'
  }
  loaded = true
}

/**
 * 配置的载入状态（**只读、不触发重读**）。
 *
 * 给「读坏就放行」这类旁路判定用：它需要知道自己是「真没配过」还是「读不出来」，而 `getConfig()`
 * 两种都给 `{}`。不要为了这个去改 `ensureLoaded` 抛异常——那会把一次文件损坏泄漏成全局崩溃。
 */
export function getConfigLoadKind(): ConfigLoadKind {
  ensureLoaded()
  return loadKind
}

/**
 * 写盘前**重读磁盘**，把「此刻磁盘上真实是什么」与内存态对齐。返回能否继续写。
 *
 * 为什么不能只信内存 `loaded`：`ensureLoaded` 只在首次调用时读一次。文件被用户改坏 / 被别的进程改成
 * 不一致的内容之后，内存里仍是陈旧快照，照着它写回去就是**用旧内容覆盖新内容**，而且没有任何一方报错。
 *
 * 三种结论：
 *  - `ok`：读到了对象。配置内容**换成磁盘这份**（后续 merge 与 patch 都以它为基准），内存同步更新；
 *  - `corrupt`：文件在但读不出 / 解析不了——不知道里面有什么，**绝不写**；
 *  - `missing`：ENOENT。首次初始化允许写；已有过合法基线则是用户主动删除，**拒绝**（不复活）；
 *  - `unreadable`：非 ENOENT 的读取失败（EACCES / EBUSY / EPERM…），**绝不写**。
 *
 * 注意这里**不改** `loadKind` 的既有语义（那是启动时那一次载入的历史事实，可用性判定依赖它）；
 * 本函数只是写入路径的即时体检，结论装在返回值里。
 */
type RereadKind = 'ok' | 'corrupt' | 'missing' | 'unreadable'

function rereadForWrite(): { kind: RereadKind; detail?: string } {
  let raw: string
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      // 从来没有过基线 = 真的首次初始化；有过基线 = 用户主动删了，不能替他重建。
      return baselineEstablished ? { kind: 'missing' } : { kind: 'ok' }
    }
    return { kind: 'unreadable', detail: (e as Error)?.message ?? String(e) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { kind: 'corrupt', detail: (e as Error)?.message ?? String(e) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { kind: 'corrupt', detail: 'config.json 顶层不是对象' }
  // 写回以磁盘为基准：别的进程 / 用户加进来的键必须留住。
  config = parsed as Record<string, unknown>
  loadKind = 'ok'
  baselineEstablished = true
  return { kind: 'ok' }
}

/**
 * 落盘。**返回是否成功**（以前静默吞掉异常，导致「报告说服务商都导入了，磁盘上一个字都没有」这种最坏的失效）。
 * 调用方按需检查：导入器必须检查（否则报成功而数据没落盘），其它内存态场景可以忽略。
 */
function persist(): boolean {
  try {
    // 原子写：写到一半崩溃不会留下半截 JSON——那样下次启动解析失败即回落空配置，服务商与模型全丢。
    writeFileAtomic(configPath(), JSON.stringify(config, null, 2))
    return true
  } catch (e) {
    console.warn('[config] 配置落盘失败：', (e as Error)?.message ?? e)
    return false
  }
}

/* ───────────── 导入期间的写入暂存（P0-2 竞态） ───────────── */

/**
 * 为什么要有这个：渲染层 `store/models.tsx` 在 providers / activeModelId / activeEffort 任一变化时**整段回写**
 * `models`；而「打开一个对话」就会把最近使用模型写进 activeModelId。导入要搬上百 MB、跑几十秒，用户这期间点开
 * 任何一个对话，就会用**导入前的旧快照**把刚并入的服务商整段覆盖掉——报告说成功，磁盘上却一个都没有。
 *
 * 做法：导入开始时 `beginConfigHold()`，此时渲染层的 `config:set` 补丁**排队不落盘**（主进程自己的 setConfig 不受
 * 影响，它才是权威写入方）；收尾时先释放队列应用用户这一轮的改动，再补一次「只补缺」的服务商合并把成果补回来。
 * 这样既不会丢掉用户的改动，也不会有任何一个时刻让陈旧快照压掉导入结果。
 */
let holdDepth = 0
const heldPatches: Array<Record<string, unknown>> = []

/** 开始暂存渲染层写入（可嵌套；配对调用 endConfigHold）。 */
export function beginConfigHold(): void {
  holdDepth++
}

/** 现在是否在暂存中（渲染层写入被排队）。 */
export function isConfigHeld(): boolean {
  return holdDepth > 0
}

/** 结束暂存并返回排队的补丁（调用方决定怎么应用）；队列清空。 */
export function endConfigHold(): Array<Record<string, unknown>> {
  if (holdDepth > 0) holdDepth--
  if (holdDepth > 0) return [] // 还有外层持有者，继续攒着
  const out = heldPatches.splice(0, heldPatches.length)
  return out
}

/**
 * 主进程内读取整份配置（只读快照）。
 * 供其它服务在进程内复用（如 git.ts 读 `git.path` 覆盖），避免各自重复读文件。
 */
export function getConfig(): Record<string, unknown> {
  ensureLoaded()
  return config
}

/**
 * 把渲染层的一条 `config:set` 补丁里的 `models` 段**合并**到当前内存态上（纯函数，不写盘）。
 *
 * ## 为什么需要它（2-B 的核心）
 *
 * 渲染层 `store/models.tsx` 每次 providers / activeModelId / activeEffort 变化都**整段回写** `models`。它手里
 * 是「自己加载那一刻」的快照，而主进程可能已经在这之后改过 models（导入并入服务商、别的窗口改了配置）。原先
 * `setConfig` 是**替换**语义，于是陈旧快照一回写就把那些改动整段抹掉。只靠「导入期间排队 + 收尾补回」只能缩窗口
 * ——收尾后到渲染层重载完成之间仍有几十毫秒，那段时间的陈旧回写照样抹得掉。
 *
 * 改为合并语义后，**不变量**变成：渲染层删不掉它没见过的 provider。不管快照多旧、回声多晚，主进程里那些
 * provider 都还在。这是根治，不是再缩一次窗口。
 *
 * ## 合并规则
 *
 *  - `patch.models` 为 `undefined` → 原样返回（尊重 `setConfig` 的「undefined 删键」协议）
 *  - `providers`：以**磁盘（当前内存态）**为基准，`removedProviders` 里点名的删掉；同 id 的用 incoming 那份覆盖
 *    （用户改过的 host / 模型列表要生效）；incoming 里有、磁盘没有的追加（用户新增的）。
 *    → 磁盘有而 incoming 没有的，**保留**（这正是「渲染层删不掉它没见过的」）。
 *  - 其余字段（`activeModelId` / `activeEffort` / 将来新增的兄弟字段）：**incoming 胜**。这些是单值选择，
 *    用户点了就是用户的意思，没有「合并」可言。
 *
 * ## 为什么删要靠 `removedProviders` 显式声明
 *
 * 合并语义下「incoming 里没有」不再等于「用户删了」（也可能只是快照旧）。渲染层必须显式列出本轮主动删掉的 id，
 * 删才生效——所以 `removedProviders` 不是可选优化，是这个语义的必要条件。
 */
/**
 * 只读地拿一份「磁盘上现在是什么」用于**合并基准**，不改模块内存态。
 *
 * `mergeModelsPatch` 是纯函数（不写盘），但它的「磁盘基准」不能再用内存快照：渲染层整段回写来的补丁要跟
 * **磁盘当前**的 providers 合并，否则主进程刚并入的服务商会被陈旧快照抹掉，而内存态也已过时的话连判据都没有。
 * 读不出来 / 不存在时退回内存态（与既有行为一致：那种情况本来就该由 setConfigDetailed 拒绝写入）。
 */
function peekConfigForMerge(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* 读不出 / 解析不了 → 退回内存态 */
  }
  ensureLoaded()
  return config
}

export function mergeModelsPatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (!patch || typeof patch !== 'object') return patch
  const incoming = patch.models as Record<string, unknown> | undefined
  if (incoming === undefined) return patch // undefined = 删键，原样交给 setConfig
  if (!incoming || typeof incoming !== 'object') return patch

  const diskCfg = peekConfigForMerge()
  const disk = (diskCfg.models && typeof diskCfg.models === 'object' ? diskCfg.models : {}) as { providers?: unknown }
  const diskProviders = Array.isArray(disk.providers) ? (disk.providers as Array<{ id?: unknown }>) : []
  const inProviders = Array.isArray((incoming as { providers?: unknown }).providers)
    ? ((incoming as { providers?: unknown }).providers as Array<{ id?: unknown }>)
    : []
  const removedRaw = patch.removedProviders
  const removed = new Set(
    Array.isArray(removedRaw) ? removedRaw.filter((x): x is string => typeof x === 'string') : []
  )

  const inById = new Map<string, { id?: unknown }>()
  for (const p of inProviders) if (typeof p?.id === 'string') inById.set(p.id, p)

  const merged: Array<{ id?: unknown }> = []
  const seen = new Set<string>()
  for (const p of diskProviders) {
    const id = typeof p?.id === 'string' ? p.id : ''
    if (!id) {
      // 没有 id 的脏数据：没有合并依据，按 incoming 原样带过（不在这里做数据清洗，那不是本函数的职责）
      merged.push(p)
      continue
    }
    if (removed.has(id)) continue // 用户本轮主动删的：不复活
    merged.push(inById.get(id) ?? p) // 同 id 用 incoming 覆盖，否则保留磁盘那份
    seen.add(id)
  }
  for (const p of inProviders) {
    const id = typeof p?.id === 'string' ? p.id : ''
    if (id && seen.has(id)) continue
    if (id && removed.has(id)) continue // 既说要删又传上来（快照回声）：以删为准
    merged.push(p) // 磁盘没有的新 provider
  }

  /*
   * ⚠️ `removedProviders` 是**内部簿记键**，不能留在返回值里。
   *
   * `setConfig` 是逐键浅合并：留在里面就会被写进用户的 config.json，而且**永远不会自己消失**
   * ——删键的条件是「值为 undefined」，而渲染层清空后是「不再传这个键」，不是传 undefined。
   * 用户手改 config.json 时会看到一个无文档解释的数组。
   */
  const { removedProviders: _drop, ...rest } = patch
  return { ...rest, models: { ...incoming, providers: merged } }
}

/** 一条排队补丁的应用结果（裸下标，由调用方包成自己的失败类型——config 层不 import 导入协议）。 */
export interface HeldPatchOutcome {
  /** 应用失败的补丁下标（落盘失败）。 */
  failures: Array<{ index: number }>
  /**
   * 这一批补丁里是否有任一条**自身带 `models` 键**。判据严格是「键存在」，不是「合并后内容变了」：
   * 导入器用它决定收尾要不要跑一次 `mergeProviders` 把 activeModelId 之类恢复回来——陈旧快照把它写成 null、
   * provider 列表零变化时，「有变化」会判 false → 不补回 → activeModelId 悄悄保持 null。判「键存在」才稳。
   */
  touchedModels: boolean
  /** 这批补丁里用户显式声明删除的 provider id（合并 + 免疫复活两处共用同一集合）。 */
  removedIds: Set<string>
}

/**
 * 把导入期间排队的渲染层补丁**合并**应用回内存态 + 磁盘。
 *
 * 与 `setConfig` 的分工：`setConfig` 是替换语义（主进程内部写入，如 `mergeProviders` 写完整合并结果——若在这里再
 * 被「保留未知 id」过滤一遍，用户删掉的服务商会在下次导入时复活）；本函数是**合并**语义（渲染层快照写回）。
 */
export function applyHeldPatches(held: Array<Record<string, unknown>>): HeldPatchOutcome {
  const failures: Array<{ index: number }> = []
  let touchedModels = false
  const removedIds = new Set<string>()
  for (const [index, patch] of held.entries()) {
    if (!patch || typeof patch !== 'object') continue
    if (Object.prototype.hasOwnProperty.call(patch, 'models')) touchedModels = true
    const r = patch.removedProviders
    if (Array.isArray(r)) for (const id of r) if (typeof id === 'string') removedIds.add(id)
    if (!setConfig(mergeModelsPatch(patch))) failures.push({ index })
  }
  return { failures, touchedModels, removedIds }
}

/**
 * 写配置的详细结果。`ok:false` 时 `code` 说明是**哪一类**失败——调用方大多忽略返回值，但
 * 「磁盘读不出」「被外部改过」与「写盘失败」对用户要做的事完全不同，不能压成同一个 false。
 */
export interface ConfigWriteResult {
  ok: boolean
  /**
   * - `config-unreadable`：磁盘上的 config.json 此刻读不出来（半截 JSON / 被占用 / 权限）；
   * - `config-changed-externally`：本次 patch 要覆盖的键在磁盘上已被改过，或文件被外部删除；
   * - `config-write-failed`：读得到、也没冲突，但写盘失败（磁盘满、被占）。
   */
  code?: 'config-unreadable' | 'config-changed-externally' | 'config-write-failed'
  detail?: string
}

/**
 * 写配置的完整实现。`setConfig` 是它的布尔投影（保留既有调用方）。
 *
 * ## 为什么写前必须重读磁盘
 *
 * `ensureLoaded` 只在首次调用时读一次，`config` 是那一刻的快照。文件被用户手改坏、或被别的进程改成别的
 * 内容之后，照内存写回去就是**用旧内容覆盖新内容**。更糟的是载入态那一份：`ensureLoaded` 把「内容坏」
 * 折成 `{}`，于是同一轮里 MCP 启用 / 角色启用会写出「空配置 + 这次补丁」——用户其余所有键（主题、模型、
 * 服务商）一次性消失，而调用方（`mcp-config.ts` / `personas.ts` / `skills.ts` …）**都不检查返回值**。
 *
 * 所以这里的顺序是：**先重读** → 判能不能写 → 再合并与落盘。
 *
 * ## 为什么冲突要整次失败，而不是「磁盘优先、静默忽略本次」
 *
 * 调用方忽略返回值，失败必须整体、可观察。若只跳过冲突的那个键、把其余键写下去，上层状态与磁盘就再次
 * 不一致（它以为全写好了），而界面上没有任何提示。整次失败时内存态也保持不动，与磁盘维持同一份已知状态。
 *
 * 回滚只针对**本次 `patch` 覆盖到的键**：记下旧值（含「本来没有这个键」）再整体恢复，不影响并发的其它键写入。
 *
 * ⚠️ **这里是替换语义，不做 models 合并**（合并只在 `config:set` / `applyHeldPatches` 那条「渲染层快照写回」
 * 路径上）。`mergeProviders` 写的是自己算好的完整合并结果，若再被「保留未知 id」过滤一遍，用户删掉的服务商
 * 就会在下次导入时复活。见 `mergeModelsPatch` 的说明。
 *
 * ⚠️ **这里刻意不广播 config:changed**。渲染层 `store/models.tsx` 有「providers 一变就 config:set」的回写 effect，
 * 若每次写盘都广播，就会形成「广播 → 渲染层重载 → 回写 → 广播」的刷新循环（打字卡顿、磁盘狂写）。
 * 需要通知渲染层的场景只有「外部批量改动」（导入），由调用方在改完后显式调 `publishConfigChanged`。
 */
export function setConfigDetailed(patch: Record<string, unknown>): ConfigWriteResult {
  ensureLoaded()
  if (!patch || typeof patch !== 'object') return { ok: true }

  const fresh = rereadForWrite()
  if (fresh.kind === 'corrupt' || fresh.kind === 'unreadable') {
    // 不知道磁盘上有什么：一个字节都不写，内存也保持原样（下一个调用方看到的是同一份「未知」）。
    console.warn('[config] config.json 读不出来，拒绝写入：', fresh.detail ?? fresh.kind)
    return { ok: false, code: 'config-unreadable', detail: fresh.detail }
  }
  if (fresh.kind === 'missing') {
    // 曾经有过合法基线，现在没了：用户主动删的，不能替他重建。
    console.warn('[config] config.json 已被外部删除，拒绝重建')
    return { ok: false, code: 'config-changed-externally', detail: 'config.json 已被删除' }
  }

  /*
   * 到这一步 `config` 已是磁盘的最新内容（见 rereadForWrite）。冲突判定拿它当基线没有意义——
   * 基线要的是「上一次成功写盘后，这些键在我这边的值」。用内存态里的旧值比对同样不可靠（它就是被重读覆盖掉的那份），
   * 故基线由 `lastWritten` 维护：每次写盘成功后更新成「这次写下去的这几个键」。
   */
  for (const key of Object.keys(patch)) {
    const seen = lastWritten.get(key)
    if (!seen) continue // 本进程从没写过这个键：磁盘内容就是权威，没有「被外部改过」可言
    const diskValue = Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined
    if (JSON.stringify(diskValue) !== JSON.stringify(seen.value)) {
      console.warn(`[config] ${key} 在磁盘上已被外部改动，整次写入取消`)
      return { ok: false, code: 'config-changed-externally', detail: key }
    }
  }

  /*
   * 记旧值，键不存在时用 `undefined` 表示「本来没有」。
   *
   * ⚠️ 必须**深拷贝**：调用方（`writeEnabled` / `writeRolesMap`）是先 `enabledMap()` 拿到内存里的
   * **同一个对象引用**、改完再交给这里，浅存引用等于存的就是改后的状态，回滚等于没回滚。
   * 实测踩过：IPC 已如实返回 false，而 `isEnabled` 仍读回 true。
   */
  const before = new Map<string, unknown>()
  for (const k of Object.keys(patch)) {
    before.set(k, Object.prototype.hasOwnProperty.call(config, k) ? structuredClone(config[k]) : undefined)
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete config[k]
    else config[k] = v
  }
  if (persist()) {
    for (const k of Object.keys(patch)) {
      lastWritten.set(k, { value: structuredClone(hasOwn(config, k) ? config[k] : undefined) })
    }
    baselineEstablished = true
    return { ok: true }
  }
  // 写盘失败：把内存恢复成写之前的样貌，让「内存态」与「磁盘」一致（见上方说明）
  for (const [k, v] of before) {
    if (v === undefined) delete config[k]
    else config[k] = v
  }
  return { ok: false, code: 'config-write-failed' }
}

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

/** 本进程上次成功写盘时，各键写下去的值（冲突判定的基线）。 */
const lastWritten = new Map<string, { value: unknown }>()

/** 布尔投影：既有调用方只看成功与否。 */
export function setConfig(patch: Record<string, unknown>): boolean {
  return setConfigDetailed(patch).ok
}

/* ───────────── 配置变更广播 ───────────── */

type ConfigChangedListener = (p: ConfigChangedEvent) => void
const changedListeners = new Set<ConfigChangedListener>()

/**
 * 通知渲染层「配置被外部改动了」，由 registerConfigIpc 订阅后转发成 `config:changed`。
 * 订阅者回调里抛错不能打断发布方（导入正在收尾），故逐个 try/catch 隔离。
 */
export function publishConfigChanged(p: ConfigChangedEvent): void {
  for (const l of changedListeners) {
    try {
      l(p)
    } catch (e) {
      console.warn('[config] config:changed 订阅者异常：', (e as Error)?.message ?? e)
    }
  }
}

export function onConfigChanged(listener: ConfigChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

export function registerConfigIpc(getWindow: () => BrowserWindow | null): void {
  ensureLoaded()

  // 外部批量改动（导入）后转发给渲染层：渲染层据此重载模型/角色列表，不必重启或切页。
  // 只由显式 publishConfigChanged 触发；config:set 回写不广播，故不会自激（见 setConfig 的说明）。
  onConfigChanged((p) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('config:changed', p)
  })

  // 同步读取整份配置：供渲染层首帧读取主题/语言，避免闪烁（FOUC）。
  ipcMain.on('config:get-sync', (evt) => {
    ensureLoaded()
    evt.returnValue = config
  })

  // 异步读取整份配置。
  ipcMain.handle('config:get', () => {
    ensureLoaded()
    return config
  })

  // 顶层浅合并补丁：值为 undefined 时删除该键。
  // `models` 段特殊处理——**合并**而非替换（见 mergeModelsPatch：渲染层整段回写的是它加载时的快照，
  // 替换语义下陈旧快照会抹掉主进程后来并入的服务商）。其它键保持原样的顶层浅合并。
  //
  // 导入期间（isConfigHeld）仍然只排队不落盘：排队的是**原始 patch**，合并在 drain（applyHeldPatches）时做——
  // 那时的磁盘状态才是对的，此刻合并会用到中途状态。
  ipcMain.handle('config:set', (_e, patch: Record<string, unknown>): ConfigSetResult => {
    if (isConfigHeld()) {
      if (patch && typeof patch === 'object') heldPatches.push(patch)
      return { ok: true, queued: true }
    }
    const ok = setConfig(mergeModelsPatch(patch))
    return { ok, ...(ok ? {} : { error: 'config-write-failed' }) }
  })
}
