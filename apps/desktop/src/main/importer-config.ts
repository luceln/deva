import { readFileSync } from 'fs'
import { join } from 'path'
import { getConfig, setConfig } from './services/config'
import { importEncryptedSecret } from './services/secrets'
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
 * 把原版 config 里的服务商并入本地 config，**只补 id 不存在的**。
 * 直接改本地 config 的内存态并落盘（setConfig 会持久化），不返回整份配置——避免调用方误以为能自行替换整段。
 *
 * 统计口径：应用**自带**的预置服务商（anthropic / openai / … / typesafe，见 shared/preset-providers.ts）单独归入
 * `builtin`，既不算 copied 也不算 skipped。它们本来就在二开版启动时被种进 config，与原版逐个 id 相同——
 * 若算 skipped，用户会看到「跳过 11 个」而以为自己有 11 个自定义服务商被忽略（实测用户只有 5 个）。
 * 同一条判据也用于处理合并本身（预置 id 照常保留本地那份），只是不进入用户的计数。
 */
export function mergeProviders(srcHome: string, opts?: { excludeIds?: string[] }): ProviderMergeStat {
  const stat: ProviderMergeStat = { copied: [], skipped: [], kept: [], builtin: [] }
  const exclude = new Set(opts?.excludeIds ?? [])
  const srcRead = readJson(join(srcHome, 'config.json'))
  // 读不出来 / 内容坏：**必须记失败**，不能落到「0 个服务商」那种「原版没配过」的显示上
  if (srcRead.kind === 'unreadable') return { copied: [], skipped: [], kept: [], builtin: [], failed: [{ step: 'providers', id: '<config.json>', reason: srcRead.reason }] }
  const srcProviders = providersOf(srcRead.kind === 'ok' ? srcRead.cfg : null)
  if (!srcProviders.length) return stat

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
 * 密钥补缺：只补目标没有的 key，且**只搬与本次导入的 provider 相关的**。
 *
 * 同机同账户，DPAPI 密文原样搬运即可解密（见 secrets.ts 开头的说明）——密文绑定的是 OS 用户账户，与文件路径无关。
 *
 * ⚠️ **不能全量搬**：原版 secrets.json 里除了 provider 的 apiKey，还有 `remote:<botId>:appSecret` / `remote:…:botToken`
 * 和 `mcp:<id>:<field>`。但本方案刻意不导 `remote` 段与 MCP 配置（见文件头的说明：两个应用争同一个机器人会互相
 * 抢会话）。把这些密文搬过去，目标里没有任何配置能用到它们——纯属无主密文，只会让「密钥」那一栏的数字虚高，
 * 与「remote 不导」自相矛盾。所以只保留 provider 相关的 key，其余归入 `ignored`（不适用，不算跳过也不算失败）。
 *
 * 判据：key 若含 `:`，取首段当 providerId（`remote` / `mcp` 这类命名空间天然不在 provider 集合里）；否则整串就是
 * providerId（provider 的 apiKey 就是以 providerId 存的，见 providers/index.ts 的 `getSecret(cfg.providerId)`）。
 * 这样 `<providerId>:<modelId>` 这种按模型存的 key 也能一并保留。
 *
 * 为什么不覆盖已有 key：DevaPlus 里用户可能已经配了自己的密钥（实测它另有一套），覆盖等于悄悄改掉能用的密钥。
 * 换 Windows 用户 / 换机器 / 跨 macOS·Linux 时解不开，那只能重填，属于已知边界。
 *
 * 为什么走 importEncryptedSecret 而不是直接写 secrets.json：那是进程内缓存的模块，绕开它写盘会让当前进程继续
 * 用旧内存态 —— 「导了但用不上，要重启」。这条与陷阱一（chat-store 缓存）是同一类错误。
 *
 * ⚠️ **必须在 mergeProviders 之后调用**：判据里的 provider 集合取自目标 config 的当前状态（含刚导入的那些）。
 */
export async function copySecrets(srcHome: string): Promise<SecretsStat> {
  const stat: SecretsStat = { copied: [], skipped: [], ignored: [], noEncryption: [], invalid: [] }
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
    // 读到了但解析不了，与读不出来分开说，用户处置不同（前者要检查文件，后者稍后重试）
    const reason = (e as Error)?.message?.startsWith('Unexpected') || e instanceof SyntaxError
      ? 'source-secrets-corrupt'
      : (e as Error)?.message ?? String(e)
    stat.failed = [{ step: 'secrets', id: '<secrets.json>', reason }]
    return stat
  }
  const providerIds = new Set(
    providersOf(getConfig() as Cfg)
      .map((p) => (typeof p?.id === 'string' ? p.id : ''))
      .filter(Boolean)
  )
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string' || !value) continue
    const providerId = key.includes(':') ? key.slice(0, key.indexOf(':')) : key
    if (!providerIds.has(providerId)) {
      // 无主密文：目标没有对应配置，搬了永远用不上（详见上方注释）
      stat.ignored.push(key)
      continue
    }
    /*
     * 四种结果**分开记**，不能压平成「跳过」：
     *  - `exists`        → skipped：目标已有同名密钥，保留本地那份，这是正常的「不用导」；
     *  - `invalid`       → invalid：源里那条本身是空的/坏的，属于源数据问题；
     *  - `no-encryption` → noEncryption：**这台机器没有可用加密**（Linux 无 libsecret / 换了 OS 账户）。
     *    这是「密钥不用重输」唯一会无声失效的通道——界面必须能把它单独提示出来（「这台机器无法保存密钥，
     *    请手动重填」），混进「跳过 5」用户永远不知道；
     *  - `write-failed`  → failed：内存里有、盘上没有，重启后密钥就没了，是真失败。
     */
    const r = await importEncryptedSecret(key, value)
    if (r.ok) stat.copied.push(key)
    else if (r.code === 'write-failed') {
      // reason 用 secrets 专属码：用户看到「配置写盘失败」会去查 config.json，而失败的是 secrets.json
      stat.failed = [...(stat.failed ?? []), { step: 'secrets', id: key, reason: 'secrets-write-failed' }]
    } else if (r.code === 'no-encryption') {
      stat.noEncryption.push(key)
      /*
       * 同时记一条失败。单独成栏是给界面**说清原因**用的，但整轮 ok 不能因此为真：
       * 「密钥不用重输」是导入的核心承诺之一，一个都没存进去却报「导入完成」，用户不会去重填密钥，
       * 直到下次发消息才发现「服务商连不上」。这与「失败被伪装成跳过」是同一个病，只是这次伪装成成功。
       * reason 用独立码（不是 config-write-failed）：这不是写盘失败，是这台机器根本没有存储能力。
       */
      stat.failed = [...(stat.failed ?? []), { step: 'secrets', id: key, reason: 'no-encryption' }]
    } else if (r.code === 'invalid') stat.invalid.push(key)
    else stat.skipped.push(key)
  }
  return stat
}
