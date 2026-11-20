import { readFileSync } from 'fs'
import { join } from 'path'
import { getConfig, getConfigLoadKind, getDevaHome, setConfig } from './services/config'
import { readSecret, setSecret } from './services/secrets'
import { decryptAsLegacy } from './services/secret-rekey'
import { isPluginManagedKey, pluginManagedProviderIds } from './services/plugin-managed'
import { isPresetProviderId } from '../shared/preset-providers'
import type { SecretsStat, StepStat } from '../shared/import-protocol'

/**
 * 导入第 ①/② 步：服务商并入 + 密钥补缺。
 *
 * 为什么服务商要导：这是「新装的 DevaPlus 别从零开始」里最值钱的一项——用户的 5 个自定义服务商（中转站、反代、
 * 自己的 DeepSeek 账号）全靠它，不导就得一个个重配 apiHost / 模型清单。`models.activeModelId`（最近使用）
 * 也一并带过来：用户导入就是为了「不用重配」，导完还得再挑一次模型属于同一件事。
 *
 * ⚠️ **不做 apiHost + name 双判据「合并」**：那套是为了「让两边共用一个 provider 并重写会话引用」服务的。本方案
 * 不改任何 provider id，所以 `id 相同 = 同一个服务商`、`id 不同 = 两个服务商`，简单且没有歧义。id 已存在时整个
 * provider 原样保留本地那份（本地可能改过 apiHost / 密钥 / 启用态，凭什么被原版覆盖）。
 *
 * 为什么不导 remote / layout：remote 含飞书 appSecret 与配对关系，两个应用争同一个机器人会互相抢会话；
 * layout 是纯界面偏好，搬过去只会让用户觉得「窗口大小我自己还没调过，怎么就变了」。
 */

/** 服务商并入结果：新增了哪些 id、因为已存在而保留本地的是哪些、哪些是应用自带（不计入用户统计）。 */
export interface ProviderMergeStat extends StepStat {
  kept: string[]
  /** 必填（覆盖 StepStat 的可选）：本模块总会填，调用方不必再判空。 */
  builtin: string[]
  /**
   * 必填（覆盖 StepStat 的可选）：本模块总会填，调用方不必再判空。
   *
   * 为什么要覆盖成必填：`report.providers` 直接把这里的结果抄过去（importer.ts），若留可选，
   * 漏填时协议层不会报错，界面拿到的就是 undefined——「N 个服务商归插件管」那行会静默消失。
   * 宁可让本模块编译期就发现漏填。
   */
  pluginManaged: string[]
  /** 本次一并带过来的「最近使用模型」（`<providerId>:<modelId>`）；没带则为空。 */
  activeModelId?: string
  /**
   * 本次是否尝试过写 config.json。竞态守卫要用它判「收尾时是否需要补回」：
   * 不能按 `copied.length` 判——第二轮导入零新增（幂等），但用户的旧快照仍可能把上一轮的成果抹掉。
   */
  wrote?: boolean
}

type Cfg = Record<string, unknown>
interface Provider {
  id?: unknown
  [k: string]: unknown
}

/**
 * 读一份 JSON 配置，三态返回。
 *
 * ⚠️ 以前是 `try { return JSON.parse(...) } catch { return null }`：读失败 → null → `mergeProviders` 里
 * `providersOf(null)` 得空数组 → 立即 `return stat` → 报告「0 个服务商」，而 `ok` 可能还是 true。
 * **服务商是导入里最值钱的一项**（重配要重填密钥、重选模型），静默归零等于让人白导一次还查不出原因。
 *
 * 三态：
 *  - `absent`：ENOENT，原版没配过 → 正常；
 *  - `ok`：读到了；
 *  - `unreadable`：被占用 / 无权限（`reason: 'source-config-unreadable'`）或半截 JSON
 *    （`reason: 'source-config-corrupt'`）→ 调用方必须记失败。
 *
 * 源侧读失败不需要 fail closed（这是只读原版），但绝不能当成「没有」。
 */
type JsonRead = { kind: 'absent' } | { kind: 'ok'; cfg: Cfg } | { kind: 'unreadable'; reason: string }

function readJson(p: string): JsonRead {
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', reason: 'source-config-unreadable' }
  }
  try {
    return { kind: 'ok', cfg: JSON.parse(raw) as Cfg }
  } catch {
    return { kind: 'unreadable', reason: 'source-config-corrupt' }
  }
}

/** 目标 config 里的 providers 数组（不存在则空）。 */
export function providersOf(cfg: Cfg | null): Provider[] {
  const models = cfg?.models as { providers?: unknown } | undefined
  return Array.isArray(models?.providers) ? (models.providers as Provider[]) : []
}

/**
 * 目标 `~/.deva-plus/mcp.json` 里真实存在的服务 id，三态返回。
 *
 *  - `ok`      ：读到了（`ids` 可能是空集合——目标确实还没配 MCP）；
 *  - `absent`  ：ENOENT，目标没有 mcp.json → 确实没有 id 可用；
 *  - `unknown` ：读不出来 / 内容坏 → **不知道**里面有谁，调用方不许当成「没有」。
 *
 * ⚠️ 这里以前是 `catch { return new Set() }` —— 又一次「读不出当成没有」：目标 mcp.json 被占用时，
 * 所有 `mcp:<id>:<field>` 会被判成「无主密文」进 `ignored`（界面说「不适用，已忽略」），
 * 而它们正是要搬的密钥。返回类型从 `Set` 改成三态，就是为了让调用方无法静默走错分支。
 */
type McpIdRead = { kind: 'ok'; ids: Set<string> } | { kind: 'absent' } | { kind: 'unknown' }

function targetMcpIds(): McpIdRead {
  const file = join(getDevaHome(), 'mcp.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    // ENOENT = 目标没有 mcp.json（还没导入过 MCP）→ 确实没有 id 可用
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' }
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    const ids = new Set<string>()
    if (servers && typeof servers === 'object') {
      for (const id of Object.keys(servers as Record<string, unknown>)) ids.add(id)
    }
    return { kind: 'ok', ids }
  } catch {
    // 内容坏：不知道里面有哪些服务
    return { kind: 'unknown' }
  }
}

/**
 * 把原版 config 里的服务商并入本地 config，**只补 id 不存在的**。
 * 直接改本地 config 的内存态并落盘（setConfig 会持久化），不返回整份配置——避免调用方误以为能自行替换整段。
 *
 * 统计口径：应用**自带**的预置服务商（anthropic / openai / … / typesafe，见 shared/preset-providers.ts）单独归入
 * `builtin`，既不算 copied 也不算 skipped。它们本来就在二开版启动时被种进 config，与原版逐个 id 相同——
 * 若算 skipped，用户会看到「跳过 11 个」而以为自己有 11 个自定义服务商被忽略（实测用户只有 5 个）。
 * 同一条判据也用于处理合并本身（预置 id 照常保留本地那份），只是不进入用户的计数。
 */
export function mergeProviders(srcHome: string, opts?: { excludeIds?: string[] }): ProviderMergeStat {
  const stat: ProviderMergeStat = { copied: [], skipped: [], kept: [], builtin: [], pluginManaged: [] }
  const exclude = new Set(opts?.excludeIds ?? [])
  /**
   * 归外部插件托管的服务商 id（源侧与本应用侧取并集，见 `services/plugin-managed.ts`）。
   *
   * 判定放在**合并之前**：这类 id 即便被并进来了，也要让界面知道「它归插件管」，
   * 否则用户看到「新增 1 个服务商」却不知道那个是插件塞的、密钥也不用他填。
   * 它与 copied 不互斥——插件托管的 provider 该并进来（否则 magpie 在二开版里直接不可用），
   * 只是密钥那一步会跳过它的 key（见 copySecrets）。
   */
  const pluginIds = pluginManagedProviderIds([srcHome, getDevaHome()])
  const srcRead = readJson(join(srcHome, 'config.json'))
  // 读不出来 / 内容坏：**必须记失败**，不能落到「0 个服务商」那种「原版没配过」的显示上
  if (srcRead.kind === 'unreadable') return { copied: [], skipped: [], kept: [], builtin: [], pluginManaged: [], failed: [{ step: 'providers', id: '<config.json>', reason: srcRead.reason }] }
  const srcProviders = providersOf(srcRead.kind === 'ok' ? srcRead.cfg : null)
  if (!srcProviders.length) return stat

  /*
   * ⚠️ 目标配置读不出来时**一律不写**（P1-④）。
   *
   * `getConfig()` 在载入失败时回落成 `{}` 并 `loaded = true`；若照常合并再 `setConfig`，写回的就是
   * 「空配置 + 这次导入的几项」——用户原本的 providers / 偏好被整份抹掉，且没有任何备份。文件在但读不出
   * 不等于它真的空（半截 JSON 通常可修、EACCES/被占用时往往完全正常）。
   *
   * 这里返回可见失败而不是静默跳过：用户要知道「原版服务商这次一个都没进来，因为本应用配置读不出来」，
   * 而不是看到「0 个服务商、ok:true」。磁盘字节保持原样，留给用户/后续修复。
   */
  /*
   * ⚠️ 目标配置读不出来时**一律不写**（P1-④）。
   *
   * `getConfig()` 在载入失败时回落成 `{}` 并 `loaded = true`；若照常合并再 `setConfig`，写回的就是
   * 「空配置 + 这次导入的几项」——用户原本的 providers / 偏好被整份抹掉，且没有任何备份。文件在但读不出
   * 不等于它真的空（半截 JSON 通常可修、EACCES/被占用时往往完全正常）。
   *
   * 这里返回可见失败而不是静默跳过：用户要知道「原版服务商这次一个都没进来，因为本应用配置读不出来」，
   * 而不是看到「0 个服务商、ok:true」。磁盘字节保持原样，留给用户/后续修复。
   */
  if (getConfigLoadKind() === 'corrupt')
    return { ...stat, failed: [...(stat.failed ?? []), { step: 'providers', id: '<config.json>', reason: 'target-config-unreadable' }] }

  const dstCfg = getConfig() as Cfg
  const dstModels = (dstCfg.models && typeof dstCfg.models === 'object' ? dstCfg.models : {}) as Cfg
  const dstProviders = providersOf(dstCfg)
  const existing = new Set(dstProviders.map((p) => p?.id).filter((id): id is string => typeof id === 'string'))

  const merged = [...dstProviders]
  for (const p of srcProviders) {
    const id = typeof p?.id === 'string' ? p.id : ''
    // 没有 id 的服务商是坏数据（配置里 id 是主键），跳过并计入 skipped，别把脏数据搬进来
    if (!id) {
      stat.skipped.push('<no-id>')
      continue
    }
    /**
     * 用户在本轮导入窗口内**主动删除**的 provider：绝不再并回来。
     * 既不 push 也不计 skipped（那不是「因为已存在而跳过」，是用户的意愿）；不给这个出口的话，
     * 收尾那次补回会把用户刚删掉的服务商又装回去——用户会觉得「删了它自己回来了」。
     */
    if (exclude.has(id)) continue
    /*
     * 插件托管的 provider：**有意不导入**。
     *
     * 理由：这类 provider 由插件自己写进目标 config.json（插件安装时会做），导入再并一次会和插件打架
     * ——插件按自己的网关约定维护它（apiHost 指向本机网关、apiKey 由插件生成），原版那份地址/密钥搬过来
     * 只会让插件配置错位。用户装插件时它自然就有了，不需要我们从原版搬。
     *
     * 不并进 copied / skipped：那不是「因为已存在而跳过」，是「它不归导入管」。
     * 单列 `pluginManaged`，界面据此说「N 个服务商归插件管，装插件后自动出现」。
     */
    if (pluginIds.has(id)) {
      stat.pluginManaged.push(id)
      continue
    }
    const preset = isPresetProviderId(id)
    if (preset) stat.builtin.push(id)
    if (existing.has(id)) {
      // 本地已有的 id 整个保留：本地可能改过地址、密钥、模型启用态——凭什么是原版覆盖本地
      if (!preset) stat.kept.push(id)
      continue
    }
    merged.push(p)
    existing.add(id)
    // 预置服务商若意外缺失就顺手补上（无害），但记在 builtin 而不是 copied：那不是用户的资产
    if (!preset) stat.copied.push(id)
  }
  // 用「是否真的并入过东西」判落盘，而不是 stat.copied.length：预置服务商缺失时会被补进去但不计入 copied，
  // 那种情况下同样得写盘，否则内存态与磁盘不一致。
  let wrote = false
  const nextModels: Cfg = { ...dstModels, providers: merged }
  if (merged.length !== dstProviders.length) wrote = true

  /**
   * `models.activeModelId`（最近使用）也带过来，但只满足两个条件时：
   *  ① 目标当前**没有**选择（null / 空）——用户已经在 DevaPlus 里挑过模型，就不该被一次导入改回原版的；
   *  ② 它指向的 provider 在**目标最终配置里存在**。
   *
   * ② 是必须的：activeModelId 形如 `<providerId>:<modelId>`，若那个 provider 没被导进来（例如原版里已删、
   * 或 id 撞上本地被替换掉），设进去就是一个悬空引用——界面显示「已选模型」但发消息时才报「模型不可用」，
   * 比空着更难查。
   */
  const providerIds = new Set(merged.map((p) => (typeof p?.id === 'string' ? p.id : '')).filter(Boolean))
  const srcActive = (srcRead.kind === 'ok' ? (srcRead.cfg.models as { activeModelId?: unknown } | undefined) : undefined)
    ?.activeModelId
  const dstActive = (dstModels as { activeModelId?: unknown }).activeModelId
  if (typeof srcActive === 'string' && srcActive && !dstActive && providerIds.has(srcActive.split(':')[0])) {
    nextModels.activeModelId = srcActive
    wrote = true
    stat.activeModelId = srcActive
  }

  if (wrote) {
    // 落盘失败必须上报：内存态看着成功，磁盘上什么都没有（实测目标 config.json 不可写时报告说
    // 「新增 custom-x」，磁盘里连字样都找不到）。setConfig 现在会返回是否写成功。
    if (!setConfig({ models: nextModels })) {
      stat.failed = [
        ...(stat.failed ?? []),
        { step: 'providers', id: '<config.json>', reason: 'config-write-failed' }
      ]
    }
  }
  stat.wrote = wrote
  return stat
}

/**
 * 密钥补缺：只补目标没有的 key，且**只搬目标里确实有对应配置的**。
 *
 * ## ⚠️ 跨应用**不能**原样复制密文（这里以前写错了）
 *
 * 以前这句写的是「同机同账户，DPAPI 密文原样搬运即可解密，密文绑定 OS 用户账户、与文件路径无关」。
 * 那只对**直接调 DPAPI** 成立。本项目 `secrets.ts` 用的是 `safeStorage.encryptString`，Windows 上产出的是
 * **`v10` 前缀 + AES-256-GCM** 密文，而那个 AES 密钥本身是用 DPAPI 保护后存在**该应用自己的**
 * `userData/Local State` 的 `os_crypt.encrypted_key` 里。
 *
 * 原版 Deva 与 DevaPlus 是两个 app（`name` 不同 → userData 不同 → AES 密钥不同），所以**原样复制过来的
 * 密文必然解不开**，落地表现是 `keyunreadable`（「密钥读不出来」）而不是「没配过」。实测：
 * `Roaming/Deva` 与 `Roaming/DevaPlus` 的 `os_crypt.encrypted_key` 逐字节不同；用 DevaPlus 身份
 * `safeStorage.decryptString` 解原版密文抛 `Error while decrypting the ciphertext`。macOS 的 Keychain
 * 项同理按应用隔离。
 *
 * 正确做法见 `secret-rekey.ts`：在**原版应用的上下文**里解密拿到明文，再用**本应用**的 `safeStorage`
 * 重新加密。做不到时（原版没装 / 版本不兼容 / 解密失败）降级为**明确告知用户去重填**——
 * 绝不明说成功却写进一堆解不开的密文。
 *
 * ⚠️ **不能全量搬**：原版 secrets.json 里除了 provider 的 apiKey，还有 `remote:<botId>:appSecret` / `remote:…:botToken`
 * 和 `mcp:<id>:<field>`。`remote` 段仍不导（两个应用争同一个机器人会互相抢会话，见文件头），它的密文搬过去
 * 也没有配置能用——纯属无主密文，只会让「密钥」那一栏的数字虚高。所以 `remote:` 归入 `ignored`。
 *
 * ✅ **`mcp:<id>:<field>` 要搬**（本方案现在导 MCP 配置了）：判据不是「首段是不是 provider」——那会把 `mcp`
 * 当成一个不存在的 provider 从而丢掉全部 MCP 密钥。改为**按目标 mcp.json 里真实存在的 id 判**：
 * `mcp:<id>:…` 只有目标 `mcpServers` 里确实有这个 id 时才搬，否则仍算无主密文。
 *
 * 为什么按目标实际配置判，而不是让调用方传一份「本次导入的 mcp id 列表」：磁盘才是真源。传参会与磁盘不一致
 * ——例如 `upsertServerChecked` 报 `mcp-write-failed`（内存有、盘上没有）时，调用方手里有 id、磁盘上没有，
 * 把密文搬过去就成了真正意义上的无主密文，而且没有任何界面能看见它。
 *
 * 判据（provider 侧）：key 若含 `:`，取首段当 providerId；否则整串就是 providerId
 * （provider 的 apiKey 就是以 providerId 存的，见 providers/index.ts 的 `getSecret(cfg.providerId)`）。
 * 这样 `<providerId>:<modelId>` 这种按模型存的 key 也能一并保留。
 *
 * 为什么不覆盖已有 key：DevaPlus 里用户可能已经配了自己的密钥（实测它另有一套），覆盖等于悄悄改掉能用的密钥。
 * 换 Windows 用户 / 换机器 / 跨 macOS·Linux 时解不开，那只能重填，属于已知边界。
 *
 * 为什么走 importEncryptedSecret 而不是直接写 secrets.json：那是进程内缓存的模块，绕开它写盘会让当前进程继续
 * 用旧内存态 —— 「导了但用不上，要重启」。这条与陷阱一（chat-store 缓存）是同一类错误。
 *
 * ⚠️ **必须在 mergeProviders 与 importMcp 之后调用**：判据分别取自目标 config 的 providers 与目标 mcp.json，
 * 两者都要先写完。导入顺序里 mcp 步骤排在 copySecrets 之前，正是为此（见 importer.ts 的步骤注释）。
 */
export async function copySecrets(srcHome: string): Promise<SecretsStat> {
  const stat: SecretsStat = {
    copied: [],
    skipped: [],
    ignored: [],
    noEncryption: [],
    invalid: [],
    unrecoverable: [],
    pluginManaged: [],
    rekeyed: []
  }
  const file = join(srcHome, 'secrets.json')
  /**
   * 源 secrets.json 的三态，与 `readMemories` 同理：「读不出来」不等于「没有密钥」。
   *
   * 以前这里是 `existsSync` + 一个大 catch 直接 `return stat`：源文件被占用（EBUSY）或半截 JSON 时，
   * 报告显示「密钥 0 个」，界面含义是「你没有需要导的密钥」——而原版里明明配着。用户此刻正在换机，
   * 少了这一条他会在某次请求失败时才发现，且已无从追查。
   *
   * `failed` 里记 **`<secrets.json>`** 而不是逐条 key：一个字节都没读到，没有「哪条失败」可谈。
   */
  let src: Record<string, unknown>
  try {
    src = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return stat // 原版没有密钥文件：正常
    /*
     * 读到了但解析不了，与读不出来分开说，用户处置不同（前者要检查文件，后者稍后重试）。
     *
     * ⚠️ 以前最后一个分支是 `(e as Error)?.message ?? String(e)` —— 把 Node 的原始 message 写进
     * `reason`，界面查不到文案就原样显示，于是用户看到的是
     * `EBUSY: resource busy or locked, open 'C:\Users\lucel\.deva\secrets.json'`：
     * 英文 + 本机绝对路径。原文保留在下面的日志里供排查，界面只认码。
     */
    const corrupt = e instanceof SyntaxError || (e as Error)?.message?.startsWith('Unexpected')
    const reason = corrupt ? 'source-secrets-corrupt' : 'source-secrets-unreadable'
    if (!corrupt) console.warn('[import] 源 secrets.json 读不出来：', e)
    stat.failed = [{ step: 'secrets', id: '<secrets.json>', reason }]
    return stat
  }
  const providerIds = new Set(
    providersOf(getConfig() as Cfg)
      .map((p) => (typeof p?.id === 'string' ? p.id : ''))
      .filter(Boolean)
  )
  /*
   * 目标 mcp.json 里真实存在的 id，三态（见 targetMcpIds 的注释）：
   *  - `ok`     ：按 id 判归属；
   *  - `absent` ：目标还没有 mcp.json（ENOENT），`mcp:` 密钥确实无主；
   *  - `unknown`：读不出来 / 内容坏 = 不知道有没有。此时既不能搬（可能无主，搬了是垃圾密文），
   *    也不能归进 `ignored`（那等于断言「目标没有这个服务」）——如实记 failed，用户能看见
   *    「MCP 密钥判断不了，因为目标 mcp.json 读不出来」。
   */
  const mcpRead = targetMcpIds()
  /**
   * 归外部插件托管的 provider id（源侧与本应用侧取并集，见 `services/plugin-managed.ts`）。
   *
   * 这类 provider 的密钥**不归用户管**：由插件按自己的网关约定生成并写回 secrets.json。
   * 所以既不该搬（搬过来的旧密文可能指向已失效的 key），也**绝不能归进 `unrecoverable`**
   * ——那一栏的界面语义是「去设置 › 模型重填」，而这些 provider 在设置页里没有可编辑的密钥输入框，
   * 用户照做会扑空。单列 `pluginManaged`，界面改为提示「请去插件里配置」。
   */
  const pluginIds = pluginManagedProviderIds([srcHome, getDevaHome()])
  /*
   * ────────── 第一阶段：挑出该搬的 key，收集 (key, 密文) ──────────
   *
   * 不在这里直接写盘的原因：这些密文是**原版应用加密的**，本应用解不开（见文件头那段）。
   * 要先批量交给 `decryptAsLegacy`（它起一个 helper 进程，在原版 userData 上下文里解密），
   * 一次解密一批——每条起一个进程会慢到用户以为卡死，而且没意义。
   */
  const toImport: Array<{ key: string; cipherText: string }> = []
  for (const [key, value] of Object.entries(src)) {
    /*
     * 源值先过一遍「这是不是一个能用的密文」，**不能 `continue` 就算**。
     *
     * 以前是 `if (typeof value !== 'string' || !value) continue`：类型不对 / 空串 → 静默跳过，
     * 于是 `stat.invalid` 永远是空的（`secrets.ts` 里那个 `code:'invalid'` 成了死分类），
     * 验收实测四种坏值全是 `ok:true invalid:[] failed:[]`——用户以为密钥都导进来了。
     *
     * 更糟的是纯空白 `"   "`：它非空，于是被当有效密文写进目标，重启后一用就是 401，
     * 而界面显示「已配置」。所以判据必须是 `trim()` 后非空，并逐个说明为什么不收。
     */
    if (typeof value !== 'string' || !value.trim()) {
      stat.invalid.push(key)
      continue
    }
    const parts = key.split(':')
    const ns = parts[0]
    /*
     * 命名空间判定：
     *  - `mcp:<id>:<field>` → 目标 mcpServers 里真有 `id` 才算有主（`id` 不允许含冒号，见 isSafeId）；
     *    目标读不出来时（unknown）无法判断，记 failed 而不是猜。
     *  - 其余 → 首段当 providerId（`remote` 这类命名空间天然不在 provider 集合里）。
     * 先判 `mcp` 再判 provider 是必须的：`mcp` 本身不是 provider，顺序反了会把 MCP 密钥全归成无主密文。
     */
    /*
     * 插件托管的密钥：单列一栏，**在 owned 判定之前**。
     *
     * 顺序很关键：插件托管的 provider 有意不并进目标（见 mergeProviders），所以它不在 `providerIds` 里，
     * 按 owned 判会被当成无主密文丢进 ignored——界面会说「搬了也用不上」，
     * 而实际语义是「它归插件管，插件自己会写一条能用的进去」。两者用户动作不同，必须分开。
     * 也不能归 `unrecoverable`：那会指向设置页里不存在的密钥输入框。
     */
    if (ns !== 'mcp' && isPluginManagedKey(key, pluginIds)) {
      stat.pluginManaged.push(key)
      continue
    }
    let owned = false
    if (ns === 'mcp') {
      if (mcpRead.kind === 'unknown') {
        // 不知道目标有没有这个服务：既不能搬也不能说「无主」，如实上报
        stat.failed = [...(stat.failed ?? []), { step: 'secrets', id: key, reason: 'target-unreadable' }]
        continue
      }
      owned = mcpRead.kind === 'ok' && parts.length >= 3 && mcpRead.ids.has(parts[1])
    } else {
      owned = providerIds.has(ns)
    }
    if (!owned) {
      // 无主密文：目标没有对应配置，搬了永远用不上（详见上方注释）
      stat.ignored.push(key)
      continue
    }
    // 归属判定通过：进入待导入清单，第二阶段统一处理
    toImport.push({ key, cipherText: value })
  }

  if (!toImport.length) return stat

  /*
   * ────────── 第二阶段：在原版上下文解密 → 用本应用重新加密 → 写盘 ──────────
   *
   * 这一步是本次修复的核心。导入的不是密文，而是**重加密后的新密文**。
   *
   * 解密失败时（原版没装 / 版本不兼容 / 本机无加密存储 / 某条密文本身坏了）：
   *  - 整批失败 → 全部进 `unrecoverable`，报告里明确告诉用户去「设置 › 模型」重填；
   *  - 单条失败（`plaintexts[i] === null`）→ 只把那条进 `unrecoverable`，其余照常导入。
   * 绝不把解不开的密文写进目标——那正是这次要修的 bug（界面上是「缺少密钥」，用户无从判断）。
   */
  const dec = await decryptAsLegacy(toImport.map((x) => x.cipherText))
  if (!dec.ok) {
    console.warn('[import] 无法在原版上下文解密密钥，降级为「明确告知用户重填」：', dec.code)
    /*
     * 只进 `unrecoverable`，**不进 `failed`**。
     *
     * 进了 `failed` 会让 `report.ok = false`，界面就会说「导入失败」——可实际上别的都导进来了，
     * 用户要做的是「去设置里重填这 N 条密钥」，这是一条提示而不是一次失败。
     * `unrecoverable` 本来就是为了与失败分开才单列的（见 SecretsStat 的注释）。
     */
    for (const { key } of toImport) stat.unrecoverable.push(key)
    return stat
  }

  for (let i = 0; i < toImport.length; i++) {
    const { key, cipherText } = toImport[i]
    const plain = dec.plaintexts[i]
    if (plain === null || plain === undefined) {
      // 单条解开不了（源里那条本身就坏了，或不属于原版密钥）——同上，只进 unrecoverable
      stat.unrecoverable.push(key)
      continue
    }
    /*
     * 目标已有同名密钥时的处置（**这是已导入过的坏密文的修复路径**）：
     *
     * - 目标那条**能解**（用户在 DevaPlus 里自己配的、或上次已经重加密过的）→ `skipped` 保留本地，
     *   覆盖等于悄悄改掉一条能用的密钥；
     * - 目标那条**解不开**（跨应用导入留下的残留）→ **覆盖**，并计入 `rekeyed`。
     *
     * 为什么必须覆盖：用户手里唯一的修好手段就是「重新导入一次」。若不覆盖，导入器跳过它、
     * 界面又一直说「密钥读不出来」，他永远修不好（只能手动删掉那条再导，而界面没给删的入口）。
     * 判据用 `readSecret` 的真实三态，不靠猜。
     */
    const existing = await readSecret(key)
    const existedBroken = existing.kind === 'unreadable'
    if (existing.kind === 'ok') {
      stat.skipped.push(key)
      continue
    }
    const r = await setSecret(key, plain)
    // 明文用完即弃：不落盘、不进日志（本函数里任何一行都不打印 plain）
    toImport[i] = { key, cipherText: '' }
    if (r.ok) {
      stat.copied.push(key)
      if (existedBroken) stat.rekeyed.push(key)
    } else if (!r.available) {
      stat.noEncryption.push(key)
      stat.failed = [
        ...(stat.failed ?? []),
        { step: 'secrets', id: key, reason: 'no-encryption' }
      ]
    } else {
      stat.failed = [
        ...(stat.failed ?? []),
        { step: 'secrets', id: key, reason: 'secrets-write-failed' }
      ]
    }
    void cipherText
  }
  return stat
}
