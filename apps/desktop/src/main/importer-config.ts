import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getConfig, setConfig } from './services/config'
import { importEncryptedSecret } from './services/secrets'
import { isPresetProviderId } from '../shared/preset-providers'
import type { StepStat } from '../shared/import-protocol'

/**
 * 导入第 ①/② 步：服务商并入 + 密钥补缺。
 *
 * 为什么服务商要导：这是「新装的 DevaPlus 别从零开始」里最值钱的一项——用户的 5 个自定义服务商（中转站、反代、
 * 自己的 DeepSeek 账号）全靠它，不导就得一个个重配 apiHost / 模型清单。`models.activeModelId`（最近使用）也一并
 * 跟着 providers 走：它指向的 id 若在目标里存在（本方案 id 原样保留），引用天然有效。
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
}

type Cfg = Record<string, unknown>
interface Provider {
  id?: unknown
  [k: string]: unknown
}

function readJson(p: string): Cfg | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Cfg
  } catch {
    return null
  }
}

/** 目标 config 里的 providers 数组（不存在则空）。 */
function providersOf(cfg: Cfg | null): Provider[] {
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
export function mergeProviders(srcHome: string): ProviderMergeStat {
  const stat: ProviderMergeStat = { copied: [], skipped: [], kept: [], builtin: [] }
  const srcCfg = readJson(join(srcHome, 'config.json'))
  const srcProviders = providersOf(srcCfg)
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
  if (merged.length !== dstProviders.length) {
    setConfig({ models: { ...dstModels, providers: merged } })
  }
  return stat
}

/**
 * 密钥补缺：只补目标没有的 key。同机同账户，DPAPI 密文原样搬运即可解密（见 secrets.ts 开头的说明）——
 * 密文绑定的是 OS 用户账户，与文件路径无关。
 *
 * 为什么不覆盖已有 key：DevaPlus 里用户可能已经配了自己的密钥（实测它另有一套），覆盖等于悄悄改掉能用的密钥。
 * 换 Windows 用户 / 换机器 / 跨 macOS·Linux 时解不开，那只能重填，属于已知边界。
 *
 * 为什么走 importEncryptedSecret 而不是直接写 secrets.json：那是进程内缓存的模块，绕开它写盘会让当前进程继续
 * 用旧内存态 —— 「导了但用不上，要重启」。这条与陷阱一（chat-store 缓存）是同一类错误。
 */
export async function copySecrets(srcHome: string): Promise<StepStat> {
  const stat: StepStat = { copied: [], skipped: [] }
  const file = join(srcHome, 'secrets.json')
  if (!existsSync(file)) return stat
  let src: Record<string, unknown>
  try {
    src = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return stat
  }
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string' || !value) continue
    // 已有 / 加密不可用都会返回 false：前者是「保留本地」，后者只能让用户重填
    if (await importEncryptedSecret(key, value)) stat.copied.push(key)
    else stat.skipped.push(key)
  }
  return stat
}
