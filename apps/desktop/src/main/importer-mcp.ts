import { readFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import { setEnabled, upsertServerChecked, type McpValue } from './services/mcp-config'
import { backupBroken, inspectTarget } from './importer-target'
import type { Failure, StepStat } from '../shared/import-protocol'

/**
 * 导入第 ② 步：MCP 服务配置（`~/.deva/mcp.json` → `~/.deva-plus/mcp.json`）。
 *
 * ## 为什么导
 *
 * MCP 是「这个应用能干什么」的一部分：用户的 magpie / context7 / deepwiki 等服务，重配要重填 URL、
 * 重摆 headers、重开开关。原版什么样就搬成什么样（用户明确要求**含明文 headers 里的密钥**，不剥）。
 *
 * ## 幂等口径：只补目标没有的 id
 *
 * 与 skills / personas 同一条：`id 已存在 → skipped`，**整个不覆盖**。用户完全可能在 DevaPlus 里自己配过
 * 同名服务（地址不同、密钥不同），凭什么是原版覆盖本地。判据只看 id，不看内容 / mtime。
 *
 * ## 为什么必须走 mcp-config 的写入层
 *
 * `upsertServerChecked` 内部会 `changeListener` → `mcp.ts` 的 reconcile，「启用即可用」靠那条链兑现。
 * 自己 `writeFileSync` 会让新导入的服务在本次运行内连不上，必须重启才生效——与 chat-store 缓存那条同类错误。
 *
 * ## 三态（本项目修了整整一轮的同一件事）
 *
 * 源 `mcp.json`：
 *  - `ENOENT`        → 原版确实没配 MCP，正常（`absent`）；
 *  - 解析失败        → `source-mcp-corrupt`（文件在、内容坏，用户要去看文件）；
 *  - 其它读错误      → `source-mcp-unreadable`（EPERM / EBUSY / EACCES，稍后重试即可）。
 * 后两种都进 `failed`，让 `ok=false` 与报告能看见。
 *
 * 目标 `mcp.json`：被同名目录占位 → `target-blocked`；存在但读不出 → `target-unreadable`。
 * 两种情况都**一个字节都不写**——`upsertServer` 内部 `readAll()` 会把「读不出」当成空库，
 * 随后整份覆盖就会抹掉用户已有的全部 MCP 配置。
 */

/** 源里一条 MCP 服务的原始形状（宽松读取，逐字段容错）。 */
interface SrcServer {
  name?: unknown
  description?: unknown
  transport?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
}

type JsonRead =
  | { kind: 'absent' }
  | { kind: 'ok'; cfg: Record<string, unknown> }
  | { kind: 'unreadable'; reason: string }

/**
 * 读源 JSON，三态。
 *
 * 失败码由调用方给：同一段读取逻辑要服务 mcp.json 与 config.json 两处，而用户对「MCP 配置坏了」
 * 与「config.json 读不出来」的处置不同。
 */
function readSourceJson(file: string, corruptCode: string, unreadableCode: string): JsonRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    // 只有 ENOENT 才是「原版没有这个文件」；其余是「读不出来」，不能当成没有
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', reason: unreadableCode }
  }
  try {
    const cfg = JSON.parse(raw) as Record<string, unknown>
    return { kind: 'ok', cfg: cfg && typeof cfg === 'object' ? cfg : {} }
  } catch {
    return { kind: 'unreadable', reason: corruptCode }
  }
}

/** 目标 mcp.json 的实况（复用 importer-target 的判据，与其它步骤同一份逻辑）。 */
type TargetState = 'absent' | 'usable' | 'blocked' | 'unreadable'

function targetState(): TargetState {
  const probe = inspectTarget(join(getDevaHome(), 'mcp.json'))
  if (probe.kind === 'usable') return 'usable'
  if (probe.kind === 'blocked') return 'blocked'
  if (probe.kind === 'unreadable') return 'unreadable'
  return 'absent'
}

/**
 * 目标 mcpServers 里现有 id。
 *
 * 读失败时**抛错**而不是返回空集合：空集合会让下面的循环把每条都当成「目标没有」，
 * 于是覆盖写入抹掉用户已有的全部 MCP 配置。调用方接住这个错误并按 `target-unreadable` 处理。
 */
function existingIds(): Set<string> {
  const ids = new Set<string>()
  try {
    const raw = readFileSync(join(getDevaHome(), 'mcp.json'), 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    if (servers && typeof servers === 'object') {
      for (const id of Object.keys(servers as Record<string, unknown>)) ids.add(id)
    }
    return ids
  } catch (e) {
    throw new Error(`mcp-target-reread-failed: ${(e as Error)?.message ?? String(e)}`)
  }
}

/** id 要同时当映射键与密钥前缀（`mcp:<id>:<field>`），非法的一律不搬。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

export function importMcp(srcHome: string): StepStat & { failed: Failure[] } {
  const stat: StepStat & { failed: Failure[] } = { copied: [], skipped: [], failed: [] }
  const fail = (id: string, reason: string): void => {
    stat.failed.push({ step: 'mcp', id, reason })
  }

  // ① 源 mcp.json 三态
  const srcRead = readSourceJson(
    join(srcHome, 'mcp.json'),
    'source-mcp-corrupt',
    'source-mcp-unreadable'
  )
  if (srcRead.kind === 'unreadable') {
    stat.failed.push({ step: 'mcp', id: '<mcp.json>', reason: srcRead.reason })
    return stat
  }
  if (srcRead.kind === 'absent') return stat // 原版没配过 MCP：正常

  const srcServers = srcRead.cfg.mcpServers
  if (!srcServers || typeof srcServers !== 'object') return stat
  const srcMap = srcServers as Record<string, unknown>
  const ids = Object.keys(srcMap)
  if (!ids.length) return stat

  // ② 目标 mcp.json 四态：被占位 / 读不出时**一个字节都不写**
  const dst = targetState()
  if (dst === 'blocked' || dst === 'unreadable') {
    // 整份目标配置都动不了：逐条报失败，id 用服务 id 让用户知道是**哪些**没进来
    const reason = dst === 'blocked' ? 'target-blocked' : 'target-unreadable'
    for (const id of ids) stat.failed.push({ step: 'mcp', id, reason })
    return stat
  }

  // 内容坏（读得到、解析不了）：先留档再重写。否则 upsertServer 内部的 readAll() 会把半截旧文件
  // 当成空库，静默吃掉里面可能还能人工抢救的条目。
  if (dst === 'usable') {
    try {
      JSON.parse(readFileSync(join(getDevaHome(), 'mcp.json'), 'utf8'))
    } catch {
      const bak = backupBroken(join(getDevaHome(), 'mcp.json'))
      console.warn(`[import] 目标 mcp.json 内容坏，已备份为 ${bak} 并重建`)
    }
  }

  let existing: Set<string>
  try {
    existing = dst === 'absent' ? new Set() : existingIds()
  } catch {
    // 探测与读取之间被抢走：现在不知道里面有什么，绝不覆盖
    for (const id of ids) fail(id, 'target-unreadable')
    return stat
  }

  // ③ 逐条并入：只补目标没有的 id
  const imported: string[] = []
  for (const id of ids) {
    if (!isSafeId(id)) {
      /*
       * 非法 id 搬不了（要当映射键与密钥前缀 `mcp:<id>:<field>`，含冒号/分隔符会撕开命名空间）。
       *
       * ⚠️ 这**不是** `skipped`。界面上 skipped 是中性的「目标已有同名、保留本地、不用管」，
       * 而这里的东西**根本没导进来**——归到 skipped 等于告诉用户「不用管」，那是错的分类
       * （AGENTS.md：一个桶只能表示它字面说的那件事）。
       *
       * 也不能直接塞 `failed` 而不给码：界面 `FAILURE_REASON_KEY` 查不到码就原样渲染，
       * 用户会看到 `<unsafe-id:...>` 这个内部占位符。所以单独给一个原因码 + 中英文案。
       * id 用脱敏后的短串（原始 id 可能很长/含控制字符），`<` 开头让界面按占位符规则处理。
       */
      stat.failed.push({ step: 'mcp', id: `<unsafe-id:${id.slice(0, 20)}>`, reason: 'mcp-unsafe-id' })
      continue
    }
    if (existing.has(id)) {
      stat.skipped.push(id)
      continue
    }
    const s = (srcMap[id] ?? {}) as SrcServer
    const transport =
      s.transport === 'sse' || s.transport === 'http' || s.transport === 'stdio'
        ? s.transport
        : 'stdio'
    /*
     * 内容原样搬运：transport / command / args / env / url / headers 全部照搬，含 headers / env 里的明文值。
     * 用户明确要求「原版什么样就怎么样」，所以这里不做任何脱敏或改写——密钥在这台机器上本来就是明文/同一账户
     * 加密（若源里是 {secretRef} 占位，也会原样带过去，对应的密文由 copySecrets 按 mcp:<id>:<field> 搬）。
     */
    const res = upsertServerChecked({
      id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name : id,
      description: typeof s.description === 'string' ? s.description : '',
      transport,
      command: typeof s.command === 'string' ? s.command : undefined,
      args: Array.isArray(s.args)
        ? (s.args as unknown[]).filter((a): a is string => typeof a === 'string')
        : undefined,
      env: (s.env as Record<string, McpValue> | undefined) ?? undefined,
      url: typeof s.url === 'string' ? s.url : undefined,
      headers: (s.headers as Record<string, McpValue> | undefined) ?? undefined
    })
    if (!res.ok) {
      // 内存里有、盘上没有：重启后这个服务就消失了，必须报失败
      fail(id, 'mcp-write-failed')
      continue
    }
    stat.copied.push(id)
    imported.push(id)
  }

  // ④ 启用态：只对**本次成功导入**的 id 动手，且只照搬源里明确为 true 的
  /*
   * 为什么只动 imported 里的：跳过的 id 目标里本来就有，用户可能已经把它关了（或开着）。
   * 拿源的开关去改本地设置，等于悄悄改用户的决定。
   *
   * 为什么源里缺这个键就不开：`mcp-config.ts` 的约定是「新建默认关」，用户自己去开。
   * 源里写了 true 就照着开（「原版什么样就什么样」）；没写 / 写 false 则保持默认关。
   *
   * ⚠️ 源 config.json 读不出时**不能静默**：服务内容照常导入（那部分在 mcp.json 里，读得到），
   * 但启用态无从得知，导入的服务会全部停在「默认关」。用户看到「MCP 已导入 N 个」却一个都连不上，
   * 而报告是绿的——这就是「读不出当成没有」的又一次复制（只是这次「没有」的是启用态）。
   *
   * 处置：给每个本次导入的 id 记一条 `source-mcp-enabled-unknown`。不猜「全开」（那会替用户改开关），
   * 也不假装成功。providers 步那条 `source-config-unreadable` 讲的是服务商，这里讲的是 MCP 开关，
   * 两条都该出现——它们指向不同资产的处置。
   */
  if (imported.length) {
    const cfgRead = readSourceJson(
      join(srcHome, 'config.json'),
      'source-config-corrupt',
      'source-config-unreadable'
    )
    if (cfgRead.kind === 'unreadable') {
      /*
       * 读不出 / 内容坏：启用态未知。**这一支必须自己上报**——`providers` 步那条
       * `source-config-unreadable` 讲的是服务商没导进来，与「MCP 服务导进来了但开关不知道」
       * 是完全不同的两件事：用户看到后者会去 MCP 页面确认开关，看到前者只会觉得服务商没导。
       * 静默的后果是「MCP 已导入 N 个」+ 全绿的报告 + 一个都连不上。
       */
      for (const id of imported) stat.failed.push({ step: 'mcp', id, reason: 'source-mcp-enabled-unknown' })
    } else if (cfgRead.kind === 'ok') {
      const mcp = cfgRead.cfg.mcp as { enabled?: unknown } | undefined
      const enabled = mcp && typeof mcp === 'object' ? mcp.enabled : undefined
      if (enabled && typeof enabled === 'object') {
        const map = enabled as Record<string, unknown>
        for (const id of imported) {
          if (map[id] !== true) continue
          if (!setEnabled(id, true)) stat.failed.push({ step: 'mcp', id, reason: 'mcp-write-failed' })
        }
      }
    }
  }

  return stat
}
