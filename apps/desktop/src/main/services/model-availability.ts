import { getConfig } from './config'
import { hasSecret } from './secrets'
import type { AvailabilityResult, BrokenRef } from '../../shared/chat-protocol'

/**
 * 模型引用可用性判定（主进程）——**全产品唯一**回答「这个 `"providerId:modelId"` 还能不能用」的地方。
 *
 * 为什么单独做一处：会话的模型是各自快照固定的一个字符串（见 chat-store StoredSession.model），模型被删、
 * 服务商被禁用、密钥没配，都会让某些会话的引用悬空，而界面要标红、批量的替换要按「坏引用」筛会话。若渲染层
 * 自己再算一遍（比如拿 store/models 的 providers 判 enabled），两套规则迟早漂移——`resolveRefStrict` 曾经就
 * 只查 id 不看 enabled，界面与主进程各说各话。故判定只在这里做，渲染层拿 IPC 结果。
 *
 * 判定依据只有两处现成真源：config.json 的 `models.providers`（明文非敏感项，宽松逐字段容错）与
 * `secrets:has`（密钥**存在性**，不解密、不把明文带出 secrets.ts）。**不抛错、不弹窗**——判定异常时宁可放行，
 * 由 runTurn 的兜底去处理，别因为一次读配置失败就把用户的会话全标红。
 *
 * 注意：判定要读密钥存在性，而密钥库（secrets.ts）是异步惰性载入的，故本模块的函数都是 async。
 */

/** config.json 里的服务商 / 模型形状（宽松读取，逐字段容错，与 model-resolve.ts 同一套写法）。 */
interface StoredModelDef {
  id?: unknown
  enabled?: unknown
}
interface StoredProvider {
  id?: unknown
  enabled?: unknown
  apiHost?: unknown
  models?: unknown
}

/**
 * 这个服务商本来就是「不需要密钥」的那类吗（本机 Ollama 等）。
 * 判据是 apiHost 指向本机：预置目录里 Ollama 就是 `http://localhost:11434/v1`，建模流程对 isLocal 直接跳过
 * 写密钥（见 ModelSetupCard 的 isLocal 分支），而 provider 层无密钥时以空串继续（见 providers/index.ts）。
 * 不按 providerId 白名单判——用户自定义的本机服务同样不该因为没密钥被标红。
 */
function keylessHost(host: unknown): boolean {
  if (typeof host !== 'string' || !host) return false
  try {
    const h = new URL(host).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
  } catch {
    // 地址写得不像 URL（用户手填的残缺值）→ 不当作本机，照常要求密钥：宁可多提示一次，也不放过真缺密钥的。
    return false
  }
}

/**
 * 切分引用。不含冒号、或任一段为空 → null（交给调用方判 malformed）。
 * providerId 由本应用生成、不含冒号，按**首个**冒号切分即可（模型 id 里可能带冒号，如 `qwen3:8b`）。
 */
function splitRef(ref: string): [string, string] | null {
  const idx = ref.indexOf(':')
  if (idx < 0) return null
  const pid = ref.slice(0, idx).trim()
  const mid = ref.slice(idx + 1).trim()
  return pid && mid ? [pid, mid] : null
}

/**
 * 判定一个模型引用能否使用。顺序即优先级（先命中先返回），四类失效原因分开报：
 * 界面要能区分「得换个模型」（malformed / missing / disabled）与「只是缺密钥」（nokey，该去填密钥而不是换模型）。
 *
 * - 空引用 → 可用：空 = 尚未定格模型（跟随全局默认，见 StoredSession.model 注释），它没引用任何具体模型，
 *   谈不上失效；标红只会把用户赶去换一个本来就好好的会话。
 * - 密钥按**存在性**判（secrets.ts 的 hasSecret，与设置页的 keyStatus 同口径）。加密不可用的环境（如缺
 *   libsecret 的 Linux）密文仍在、解密会失败，此处仍记为「已配置」——判定不替 provider 层预判解密成败。
 */
export async function resolveAvailability(
  ref: string | null | undefined
): Promise<AvailabilityResult> {
  if (!ref || typeof ref !== 'string') return { ok: true }
  // detail 只写技术定位（provider / model id），供排查与日志；给用户看的文案由渲染层按 kind 出。
  try {
    const parts = splitRef(ref)
    if (!parts) return { ok: false, kind: 'malformed', detail: ref }
    const [pid, mid] = parts
    const models = (getConfig().models ?? {}) as { providers?: unknown }
    const providers = Array.isArray(models.providers) ? (models.providers as StoredProvider[]) : []
    const provider = providers.find((p) => p && p.id === pid)
    if (!provider) return { ok: false, kind: 'missing', detail: `provider ${pid}` }
    // enabled === false 才算禁用：旧配置里可能压根没有这个字段（宽松容错，与 model-resolve 一致）。
    if (provider.enabled === false) return { ok: false, kind: 'disabled', detail: `provider ${pid}` }
    const list = Array.isArray(provider.models) ? (provider.models as StoredModelDef[]) : []
    const model = list.find((m) => m && m.id === mid)
    if (!model || model.enabled === false) return { ok: false, kind: 'missing', detail: `model ${pid}:${mid}` }
    // 本机服务无需密钥，不能按「没密钥」标红——那会把好好的本地模型（Ollama 等）赶去换模型。
    if (!keylessHost(provider.apiHost) && !(await hasSecret(pid)))
      return { ok: false, kind: 'nokey', detail: `provider ${pid}` }
    return { ok: true }
  } catch {
    // 配置读坏 / 密钥库异常：放行。判定只是提示用的旁路，不该反过来阻断用户的会话。
    return { ok: true }
  }
}

/** 这个引用能不能直接用（`chat:model-swap-apply` 验目标模型、轮前体检都用它，结论与 resolveAvailability 一致）。 */
export async function isUsableRef(ref: string | null | undefined): Promise<boolean> {
  return (await resolveAvailability(ref)).ok
}

/**
 * 从一批「会话 id + 模型引用」里挑出引用已失效的（scanSessionsByModel 的判定底座）。
 * name 可选：给得出名字（成员名 / 对话标题）就带上，给不出留空由调用方补——本函数只做判定，不查会话。
 */
export async function detectAllBrokenRefs(
  sessions: { id: string; model?: string; name?: string }[]
): Promise<BrokenRef[]> {
  const checked = await Promise.all(
    sessions.map(async (s) => {
      const a = await resolveAvailability(s.model)
      if (a.ok || !a.kind) return null
      return { sessionId: s.id, name: s.name ?? '', ref: s.model ?? '', kind: a.kind }
    })
  )
  return checked.filter((b): b is BrokenRef => b !== null)
}
