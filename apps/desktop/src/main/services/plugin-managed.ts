import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 「这个服务商由外部插件托管」的判定。
 *
 * ## 为什么要判这个
 *
 * magpie 插件（`E:\magpie-agent-deva`）直接改 Deva 的 `config.json`，往里塞一个 `kind:'custom'` 的
 * provider（默认 id `magpie`，指向本机网关 `http://127.0.0.1:3425/v1`），并把它的 apiKey 写进
 * `secrets.json`。这类服务商的密钥**不归用户管**：密钥由插件自己按网关约定生成（`magpie-deva` 之类），
 * 用户既看不到、也不需要填。
 *
 * 所以导入时**不该搬它的密钥**，也不该把它归进 `unrecoverable`——那会让界面提示
 * 「去设置 › 模型重填」，而设置页里那个服务商根本没有可编辑的密钥输入框，用户点了没用。
 *
 * ## 为什么不能靠 id、也不能靠 apiHost 猜
 *
 * - **id 不硬编码**：插件允许改名（`uniqueProviderId` 在 `magpie` 被占时会生成 `magpie-2`），
 *   写死 `id === 'magpie'` 在插件改名/多实例时静默失效，而失效的表现正是「又把它的密钥导进来了」。
 * - **`kind:'custom'` 不能判**：用户自己加的服务商也是 `custom`，那才是真正该导的密钥。
 * - **apiHost 不能判**：插件连的是本机网关，但用户可以自己配一个本机地址的中转，判错就把他的密钥跳过。
 *
 * ## 判据：插件自己的状态文件
 *
 * 插件把「我托管了哪个 provider」写在 `<DEVA_HOME>/.magpie-agent.state.json` 里
 * （`providerId` 字段，见插件的 `lib/deva-files.mjs` 的 `files().state`）。这是**插件自己声明的所有权**，
 * 比任何特征猜测都可靠；它同时也是插件 `restore()`（用户在 magpie 里断开 Deva）时用来删 provider 的依据，
 * 所以插件一定会维护它。
 *
 * ## 为什么同时看源与目标两个 home
 *
 * 导入是「原版 → 本应用」。插件的状态文件可能在任一侧：
 *  - 原版装过插件（`<srcHome>/.magpie-agent.state.json`）→ 源 config 里那个 provider 是插件塞的；
 *  - 本应用侧装过插件（`<本应用 home>/.magpie-agent.state.json`）→ 那个 id 在本应用里同样归插件管。
 * 两侧都要读，取并集。
 *
 * ## 为什么把「哪些插件」做成表
 *
 * 将来再接第二个插件（比如某个 MCP 网关）只需加一行，不用改判定逻辑；界面侧也永远不需要认识具体插件名
 * ——它只读报告里的 `pluginManaged` 数组。
 */
interface PluginStateFile {
  /** 相对 DEVA_HOME 的文件名。 */
  file: string
  /** 该文件里记录「我托管的 provider id」的字段名。 */
  idField: string
  /** 记录「我托管的密钥 key」的字段（可选）。有些插件会托管不止一个 key。 */
  keyField?: string
}

/**
 * 已知的插件状态文件。
 *
 * 只收录**插件自己写、且语义明确是所有权声明**的文件；不收录任何配置特征（见文件头那三条理由）。
 * 加新条目时确认该文件由插件维护、且插件在解除托管时会删掉/清空对应字段——否则会长期误判。
 */
const PLUGIN_STATE_FILES: PluginStateFile[] = [
  // magpie-agent：{ providerId: 'magpie', ownedSecret: true, ... }
  { file: '.magpie-agent.state.json', idField: 'providerId' }
]

/** 一个 home 里能读到的插件托管信息。 */
interface PluginOwnership {
  /** 托管的 provider id。 */
  providers: Set<string>
  /** 托管的密钥 key（目前没插件填，留出位置）。 */
  keys: Set<string>
}

function readOwnership(home: string): PluginOwnership {
  const out: PluginOwnership = { providers: new Set(), keys: new Set() }
  for (const spec of PLUGIN_STATE_FILES) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(home, spec.file), 'utf8'))
    } catch {
      /*
       * 读不出来 / 没有这个文件 → 这个插件没装过，跳过它。
       *
       * 这里**不需要**像别处那样区分「没有」与「读不出来」：判错的代价只是「少跳过几个密钥」，
       * 也就是退化成导入前的旧行为（尝试导入，失败则进 unrecoverable）——用户仍能在报告里看到，
       * 不会静默丢数据。为它记一条 failed 只会给没装插件的用户刷噪声。
       */
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const rec = parsed as Record<string, unknown>
    const id = rec[spec.idField]
    if (typeof id === 'string' && id) out.providers.add(id)
    if (spec.keyField) {
      const key = rec[spec.keyField]
      if (typeof key === 'string' && key) out.keys.add(key)
    }
  }
  return out
}

/**
 * 插件托管的 provider id 集合（源 home 与本应用 home 的并集）。
 *
 * 为什么要显式传两个 home 而不是各调用一次：调用方（导入器）本来就同时拿着源与目标，一次算完避免
 * 「读两次、两次之间插件又改了」这种不一致。
 */
export function pluginManagedProviderIds(homes: string[]): Set<string> {
  const out = new Set<string>()
  for (const home of homes) {
    if (!home) continue
    for (const id of readOwnership(home).providers) out.add(id)
  }
  return out
}

/**
 * 某个密钥 key 是否由插件托管。
 *
 * 现在只有 provider 级的所有权（`<providerId>` / `<providerId>:<modelId>` 两种写法都算它），
 * key 级的 `keyField` 目前没有任何插件填。留这个函数是为了调用点不需要在将来改签名。
 */
export function isPluginManagedKey(key: string, pluginProviders: Set<string>): boolean {
  if (!key) return false
  const idx = key.indexOf(':')
  const providerId = idx === -1 ? key : key.slice(0, idx)
  return pluginProviders.has(providerId)
}
