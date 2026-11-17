import { getConfig, getConfigLoadKind } from './config'
import { readSecret } from './secrets'
import type { AvailabilityKind, AvailabilityResult } from '../../shared/chat-protocol'

/**
 * 模型引用可用性判定（主进程）——**全产品唯一**回答「这个 `"providerId:modelId"` 还能不能用」的地方。
 *
 * 为什么单独做一处：会话的模型是各自快照固定的一个字符串（见 chat-store StoredSession.model），模型被删、
 * 服务商被禁用、密钥没配，都会让某些会话的引用悬空，而界面要标红、批量的替换要按「坏引用」筛会话。若渲染层
 * 自己再算一遍（比如拿 store/models 的 providers 判 enabled），两套规则迟早漂移——`resolveRefStrict` 曾经就
 * 只查 id 不看 enabled，界面与主进程各说各话。故判定只在这里做，渲染层拿 IPC 结果。
 *
 * 判定依据只有两处现成真源：config.json 的 `models.providers`（明文非敏感项，宽松逐字段容错）与
 * `secrets.ts` 的 `readSecret` 三态（**能不能解开**决定可用性，明文仍不外泄）。**不抛错、不弹窗**——判定异常时宁可放行，
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
 *
 * ## 必须按「地址字面量」判，不能拿 hostname 和裸字符串比
 *
 * `new URL('http://[::1]:11434/v1').hostname` 返回的是 **`'[::1]'`（带方括号）**，不是 `'::1'`；
 * `[::ffff:127.0.0.1]` 更会被规范化成 `[::ffff:7f00:1]`。以前直接 `h === '::1'`，IPv6 本机地址
 * **永远判不出**——用 `http://[::1]:11434` 配 Ollama 的用户被判「缺密钥」红标 + 体检拦截。
 *
 * ## 哪些算本机
 *
 * - `localhost` / `*.localhost`：RFC 6761 保留给本机，`localhost.` 带尾点也认（FQDN 写法）。
 * - 环回地址 `127.0.0.0/8`（不只 `127.0.0.1`：整段都是环回，`127.0.0.2` 一样指向本机）、`::1`。
 * - IPv4-mapped IPv6 环回 `::ffff:127.x.x.x`（Node 会写成 `::ffff:7f00:1`，按前缀 `::ffff:7f` 认）。
 * - `host.docker.internal` / `gateway.docker.internal`：Docker Desktop 里跑 Ollama 的标准入口，是本机服务，
 *   但它是**主机名**不是 IP，以前被判成远端、要求密钥。
 * - `0.0.0.0`：保留旧行为。它是「监听所有接口」的写法，作为连接地址语义不对，但改掉它会让既有配置
 *   （用户照文档抄的）突然变成缺密钥——保守起见仍认作本机。
 *
 * **不认**局域网 IP（`192.168.*` / `10.*`）：那是**另一台机器**上的服务，密钥该配就得配。
 * 把它当本机放行，等于让真正的「忘配密钥」静默通过——这正是本模块要防的静默。
 */
export function keylessHost(host: unknown): boolean {
  if (typeof host !== 'string' || !host) return false
  let raw: string
  try {
    raw = new URL(host).hostname.toLowerCase()
  } catch {
    // 地址写得不像 URL（用户手填的残缺值）→ 不当作本机，照常要求密钥：宁可多提示一次，也不放过真缺密钥的。
    return false
  }
  // IPv6 字面量在 URL 里带方括号：剥掉再比，否则 '::1' 这类比较永不成立
  const h = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  // localhost 与 *.localhost，容忍 FQDN 的尾点
  const bare = h.endsWith('.') ? h.slice(0, -1) : h
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (bare === 'host.docker.internal' || bare === 'gateway.docker.internal') return true
  if (bare === '0.0.0.0') return true
  // IPv6 环回与 IPv4-mapped 环回（Node 把 127.0.0.1 规范化成 7f00:1）
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  if (bare.startsWith('::ffff:7f') || bare.startsWith('::ffff:127.')) return true
  // IPv4 环回整段 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true
  return false
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
 * 判定一个模型引用能否使用。顺序即优先级（先命中先返回），五类失效原因分开报：
 * 界面要能区分「得换个模型」（malformed / missing / disabled）与「密钥的事」（nokey / keyunreadable）。
 *
 * - 空引用 → 可用：空 = 尚未定格模型（跟随全局默认，见 StoredSession.model 注释），它没引用任何具体模型，
 *   谈不上失效；标红只会把用户赶去换一个本来就好好的会话。
 * - 密钥按 `readSecret` 的**三态**判，不再用 `hasSecret`。
 *
 * ## 为什么不能用 `hasSecret`（P1-1）
 *
 * `hasSecret` 只有 `Boolean(store[key])`——只看**密文在不在**。换 OS 账户 / 换机器 / Linux 缺 libsecret 时，
 * 密文还在但解不开：`hasSecret` 返 true → 这里判 `ok` → 红标不亮、轮前体检放行 → 请求发出去才 401。
 * 而这恰是已确认「换账户必现」的那一类，提交声称的「四类识别」与「轮前拦截」在这一形态上**双双失效**。
 *
 * `providers/index.ts` 早已把 `unreadable` 单独报成 auth 错误（「无法读取 X 的密钥：…」），
 * 这里接同一口径，两处才不会再各说各话。
 *
 * `unreadable` 单列一个 kind 而不是折进 `nokey`：密文在但解不开 ≠ 没配过，用户的处置不同
 * （前者要重填或装 libsecret，后者只要填一次），界面文案也该不同。
 */
export async function resolveAvailability(
  ref: string | null | undefined
): Promise<AvailabilityResult> {
  if (!ref || typeof ref !== 'string') return { ok: true }
  /*
   * 配置**读坏**时放行（本函数注释顶上说清了「判定只是提示用的旁路，不该反过来阻断用户的会话」）。
   *
   * 这一条以前写在外层 `catch` 里，但从来没有生效过：`getConfig()` → `ensureLoaded()` 自己就把异常吞成
   * `{}`（见 config.ts），外层 catch 永远进不去。于是配置内容坏时 → providers=[] → 第一个引用就 `missing`
   * → **全库会话标红、体检拒绝所有发送**，而界面说「模型不可用」，用户找不到真正原因（该去修 config.json）。
   *
   * 所以先问一次载入状态：`corrupt` 才是「读不出来，不知道」，`absent` 是「真没配过」，照常判 missing。
   */
  if (getConfigLoadKind() === 'corrupt') return { ok: true }
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
    /*
     * 三种情况必须分开报，因为用户的处置完全不同：
     *  - `!model`（**模型被删**）→ 去换一个模型；
     *  - `model.enabled === false`（**模型被停用**）→ 去设置里把它重新启用（换模型是白换一次）；
     *  - 之前这两个共用 `missing`，界面一句「模型不可用，请换一个」把「去启用」也说成「去换」。
     *
     * 用独立的 `model-disabled` 而不是给 `disabled` 加 `scope` 字段：kind 是**字符串字面量联合**，
     * 界面靠 `t(\`cf.modelSwap.kind.${kind}\`)` 取文案、也是 `BrokenRef` 的唯一判定依据。加 scope 等于让
     * 「怎么显示」与「怎么判定」分居两个字段，每个消费点都得同时看两处，漏一处就退回两套口径；
     * 而独立 kind 是同一个字段的枚举扩张，所有既有消费点（`=== 'nokey'` 之类）天然不会误命中，
     * 漏掉的只是文案——那种漏是**响亮**的（界面显示原始 key），不是静默错判。
     */
    if (!model) return { ok: false, kind: 'missing', detail: `model ${pid}:${mid}` }
    if (model.enabled === false)
      return { ok: false, kind: 'model-disabled', detail: `model ${pid}:${mid}` }
    // 本机服务无需密钥，不能按「没密钥」标红——那会把好好的本地模型（Ollama 等）赶去换模型。
    if (keylessHost(provider.apiHost)) return { ok: true }
    const secret = await readSecret(pid)
    if (secret.kind === 'absent') return { ok: false, kind: 'nokey', detail: `provider ${pid}` }
    /*
     * 整份密钥库读不出来 → **放行**（与配置读坏同一条原则：判定只是提示用的旁路，不该因为一次文件损坏
     * 就把用户所有会话拦下来）。这时既不能说「没配过」（会全库标红 + 体检拒绝），也不能说「解不开」
     * （那是单条密文的问题，重填这一条就好）——真正的动作是去修 secrets.json。
     *
     * 这也说明不必另开「整体状态」接口：单条读取的返回值已经能判到整体，而这种接口要么是同步版
     * （首次载入前返回值不可信）、要么多一个调用点，最后都会有人用错。
     */
    if (secret.kind === 'store-unreadable') return { ok: true }
    if (secret.kind === 'unreadable')
      return { ok: false, kind: 'keyunreadable', detail: `provider ${pid}: ${secret.reason}` }
    return { ok: true }
  } catch {
    // 密钥库异常（readSecret 理论上不抛，但别让判定把自己搞崩）：放行。
    // 注意「配置读坏」不走这里（`ensureLoaded` 自己吞了异常），那条路在函数开头的 getConfigLoadKind。
    return { ok: true }
  }
}

/** 这个引用能不能直接用（`chat:model-swap-apply` 验目标模型、轮前体检都用它，结论与 resolveAvailability 一致）。 */
export async function isUsableRef(ref: string | null | undefined): Promise<boolean> {
  return (await resolveAvailability(ref)).ok
}

/**
 * **全量**服务商里「密钥用不了」的那些（不论有没有会话引用它）。
 *
 * 为什么需要这个：批量替换的候选集是「所有可用模型」，但排除依据以前只从 scan 结果（`BrokenRef[]`）反推——
 * 而 scan 只列出**有会话引用的失效项**。于是「服务商 B 缺密钥、但没有任何会话在用 B」不在 scan 里，
 * B 的模型就出现在候选里：用户从坏模型换到 B，换完还是不能用，得再来一次（B4）。
 * 这个功能存在的意义就是解决「模型不可用」，把用户从一个坏选项推到另一个坏选项比不做更糟。
 *
 * 判据与 `resolveAvailability` 同源（同一个 `readSecret` 三态），不另立一套：
 * - 本机服务（Ollama 等）从来不需要密钥 → 不列；
 * - 服务商被停用 → 不列（它已不在候选里，另有 `disabled` 原因）；
 * - `absent` → 缺密钥；`unreadable` → 解不开；`store-unreadable`（整份库读不出来）→ **不列**：
 *   那时「不知道」，不该把所有服务商都禁掉（与 `resolveAvailability` 的放行一致）。
 */
export interface BlockedProvider {
  id: string
  kind: Extract<AvailabilityKind, 'nokey' | 'keyunreadable'>
}

export async function listProvidersWithUnusableKey(): Promise<BlockedProvider[]> {
  // 配置读坏时与 resolveAvailability 一样放行：不知道就别拦
  if (getConfigLoadKind() === 'corrupt') return []
  const models = (getConfig().models ?? {}) as { providers?: unknown }
  const providers = Array.isArray(models.providers) ? (models.providers as StoredProvider[]) : []
  const out: BlockedProvider[] = []
  for (const p of providers) {
    const pid = typeof p?.id === 'string' ? p.id : ''
    if (!pid) continue
    // 停用的服务商不进候选，不必在这里重复报
    if (p.enabled === false) continue
    // 没有可用模型的组在候选里根本不会出现（空组被过滤），列出来只会制造一个空条目
    const list = Array.isArray(p.models) ? (p.models as StoredModelDef[]) : []
    if (!list.some((m) => m && m.enabled !== false)) continue
    // 本机服务无需密钥
    if (keylessHost(p.apiHost)) continue
    const secret = await readSecret(pid)
    if (secret.kind === 'absent') out.push({ id: pid, kind: 'nokey' })
    else if (secret.kind === 'unreadable') out.push({ id: pid, kind: 'keyunreadable' })
    // ok / store-unreadable：不列（见函数注释）
  }
  return out
}
