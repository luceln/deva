import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfig, getDevaHome, setConfig } from './config'
import { deleteSecretsByPrefix, readSecret } from './secrets'
import { setRoles } from './ext-roles'

/**
 * MCP 服务配置的读写（全局，`~/.deva-plus/mcp.json`，与项目无关）。
 *
 * 设计：
 * - 服务清单存 `~/.deva-plus/mcp.json` 的 `mcpServers` 映射（沿用 Claude Desktop 的键名，便于用户迁移/理解）。
 * - **身份 = 映射键（id）**，显示名 = `name`；id 稳定不改（改显示名只重写字段）。
 * - 启用态**不入 mcp.json**，集中存 `config.json` 的 `mcp.enabled[id]`，默认关（与 skills 一致）。
 * - **密钥零明文落盘**：env / headers 里的敏感值以 `{ secretRef }` 占位，真实值经 safeStorage 加密存
 *   `~/.deva-plus/secrets.json`（键 `mcp:<id>:<field>`）。`{secretRef}` 占位本身非敏感，可回渲染层用于「已配置」展示。
 *
 * 安全：MCP 配置由**主进程直读**；Agent 写配置应走 create_mcp（校验 + 密钥占位）。
 * 连接、子进程 spawn、密钥解密全部只发生在主进程（mcp.ts），明文永不出主进程。
 */

export type McpTransport = 'stdio' | 'sse' | 'http'

/** env / header 值：明文字符串（非敏感），或指向加密库的引用（真实值在 `mcp:<id>:<secretRef>`）。 */
export type McpValue = string | { secretRef: string }

export interface McpServerConfig {
  /** 映射键，稳定身份（选择 / 启用态 / 密钥前缀键）。 */
  id: string
  name: string
  description: string
  transport: McpTransport
  /** stdio：启动命令。 */
  command?: string
  /** stdio：命令参数。 */
  args?: string[]
  /** stdio：环境变量（值可为明文或 `{secretRef}`）。 */
  env?: Record<string, McpValue>
  /** sse / http：服务地址。 */
  url?: string
  /** sse / http：请求头（值可为明文或 `{secretRef}`）。 */
  headers?: Record<string, McpValue>
}

export interface McpServerInput {
  /** 有 id → 覆盖；无 id → 新建（据 name 生成稳定键）。 */
  id?: string
  name: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, McpValue>
  url?: string
  headers?: Record<string, McpValue>
  /** 可选：一并设置启用态（新建默认关）。 */
  enabled?: boolean
}

type StoredServer = Omit<McpServerConfig, 'id'>

function mcpFile(): string {
  return join(getDevaHome(), 'mcp.json')
}

/** 读取 mcp.json 的 mcpServers 映射（不存在 / 损坏 → 空，绝不抛错）。 */
function readAll(): Record<string, StoredServer> {
  try {
    const raw = readFileSync(mcpFile(), 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    if (servers && typeof servers === 'object') return servers as Record<string, StoredServer>
  } catch {
    /* 无文件 / 解析失败 → 空库 */
  }
  return {}
}

/**
 * 把整份 mcpServers 落盘。返回是否真的写成功。
 *
 * ⚠️ 这里以前是 `catch {}`——**写盘失败完全不可感知**：`upsertServer` 照常返回记录、调用方以为写好了，
 * 而磁盘上什么都没有，重启后配置凭空消失（这是同一个病的第 10 处，与 config.json 那条同形）。
 * 导入器要据此报 `mcp-write-failed`，所以必须把结果交出去；忽略返回值的调用方行为不变。
 */
function writeAll(servers: Record<string, StoredServer>): boolean {
  try {
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8')
    return true
  } catch (e) {
    // 不再静默：内存态仍可用（下次可重试），但调用方现在能知道盘上没落成
    console.warn('[mcp] 写 mcp.json 失败：', (e as Error)?.message ?? e)
    return false
  }
}

/** 校验 id 安全（防 `..` / 分隔符逃逸；同时用作密钥前缀）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 据显示名生成安全、唯一的 id。 */
function makeId(name: string, existing: Record<string, StoredServer>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || 'mcp'
  let id = base
  let n = 2
  while (existing[id]) id = `${base}-${n++}`
  return id
}

/** 规整 args：仅保留字符串项。 */
function cleanArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return []
  return args.filter((a): a is string => typeof a === 'string')
}

/** 规整 env / headers：丢弃空键；值保留明文字符串或合法 `{secretRef}`。 */
function cleanValueMap(map: unknown): Record<string, McpValue> {
  const out: Record<string, McpValue> = {}
  if (!map || typeof map !== 'object') return out
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    const key = k.trim()
    if (!key) continue
    if (typeof v === 'string') out[key] = v
    else if (v && typeof v === 'object' && typeof (v as { secretRef?: unknown }).secretRef === 'string') {
      const ref = (v as { secretRef: string }).secretRef.trim()
      if (ref) out[key] = { secretRef: ref }
    }
  }
  return out
}

// ── 变更通知（mcp.ts 据此对账连接）──────────────────────────────────────────

/** 一次配置变更的影响面：enabled=启用态变了（立即对账）；connection=影响连接的字段变了（防抖对账）。 */
export interface McpChange {
  enabled: boolean
  connection: boolean
}

let changeListener: (id: string, change: McpChange) => void = () => {}

/**
 * 订阅配置变更（仅 mcp.ts 注册一次）。挂在写入层而非各 IPC 上，故无论经扩展页、`create_mcp`
 * 工具还是将来别的入口改配置，「启用即可用」都由同一处兑现。
 */
export function onMcpConfigChange(fn: (id: string, change: McpChange) => void): void {
  changeListener = fn
}

/** 影响连接的字段签名（名称 / 描述不在内：改它们无需重连）。 */
function connectionSig(s: StoredServer): string {
  return JSON.stringify([s.transport, s.command, s.args, s.env, s.url, s.headers])
}

// ── 启用态（config.json 的 mcp.enabled）──────────────────────────────────────

/**
 * 启用态映射的**副本**。
 *
 * ⚠️ 必须复制，不能返回内存里的那个对象：调用方普遍是「取出来 → 改一项 → 整段写回」，
 * 直接改原对象会在 `setConfig` **之前**就污染内存态，导致写盘失败时无从回滚
 * （`setConfig` 记的「旧值」已经是改后的样子）。实测：IPC 已返回 false，`isEnabled` 仍读回 true。
 */
function enabledMap(): Record<string, boolean> {
  const mcp = getConfig().mcp
  const enabled = (mcp as { enabled?: unknown })?.enabled
  if (enabled && typeof enabled === 'object') return { ...(enabled as Record<string, boolean>) }
  return {}
}

/**
 * 落盘启用态，返回是否写成功。
 *
 * 与 `writeAll` 同理：`setConfig` 本来就会返回 boolean，以前在这里被丢掉，于是「启用了」只是内存里为真，
 * 磁盘上还是关的——重启后服务又变回停用，而这一刻界面上明明是开着的。
 */
function writeEnabledMap(map: Record<string, boolean>): boolean {
  const mcp = getConfig().mcp
  const base = mcp && typeof mcp === 'object' ? (mcp as Record<string, unknown>) : {}
  return setConfig({ mcp: { ...base, enabled: map } })
}

export function isEnabled(id: string): boolean {
  return enabledMap()[id] === true
}

function writeEnabled(id: string, enabled: boolean): boolean {
  const map = enabledMap()
  map[id] = enabled === true
  return writeEnabledMap(map)
}

/**
 * 用户显式启停：落盘并通知对账。返回是否真的写进磁盘。
 *
 * ⚠️ 写盘失败时**不通知**：`setConfig` 已经把内存态回滚成旧值，此时再 `changeListener(id, {enabled:true})`
 * 等于告诉连接层「用户要开」而内存里是「关」——界面刷新一次又从内存读回关，连接却已按开去兑现，
 * 正是本轮要消灭的那种不一致（验收实测：磁盘未变而内存已变）。
 */
export function setEnabled(id: string, enabled: boolean): boolean {
  if (!isSafeId(id)) return false
  const wrote = writeEnabled(id, enabled)
  // 值没变也要通知（「请按此状态兑现」），但只在真的写进磁盘时
  if (wrote) changeListener(id, { enabled: enabled === true, connection: false })
  return wrote
}

// ── 读写 ──────────────────────────────────────────────────────────────────

export function listServerConfigs(): McpServerConfig[] {
  const servers = readAll()
  const out: McpServerConfig[] = []
  for (const [id, s] of Object.entries(servers)) {
    if (!isSafeId(id) || !s || typeof s !== 'object') continue
    out.push({ id, ...s })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export function getServerConfig(id: string): McpServerConfig | null {
  if (!isSafeId(id)) return null
  const s = readAll()[id]
  if (!s || typeof s !== 'object') return null
  return { id, ...s }
}

/**
 * 写入结果：`ok=false` 表示配置只进了内存、没落到磁盘（重启后配置消失）。
 *
 * 导入器要靠它报 `mcp-write-failed`。其余调用方（IPC / create_mcp 工具）沿用 `upsertServer` 的返回值即可，
 * 不因此改变行为——但写盘失败现在至少会被记录，不再被 `catch {}` 完全抹掉。
 */
export interface McpWriteResult {
  server: McpServerConfig
  ok: boolean
}

/** 新建或覆盖一个 MCP 服务配置，返回最终记录（不含写入状态；要判写入是否成功用 `upsertServerChecked`）。 */
export function upsertServer(input: McpServerInput): McpServerConfig {
  return upsertServerChecked(input).server
}

/**
 * 与 `upsertServer` 同一条写路径（同一份 `readAll` / `writeAll` / 变更通知），额外交出**写盘是否成功**。
 *
 * 导入器必须走这个而不是 `upsertServer`：`writeAll` 以前 `catch {}` 静默吞，写盘失败时报告会写「已导入」，
 * 磁盘上却没有，重启即消失——这与 config.json 那条 `config-write-failed` 是同一种病。
 */
export function upsertServerChecked(input: McpServerInput): McpWriteResult {
  const name = (input.name || '').trim() || '未命名 MCP'
  let id = input.id && isSafeId(input.id) ? input.id : ''
  const isNew = !id
  const servers = readAll()
  if (!id) id = makeId(name, servers)

  const transport: McpTransport =
    input.transport === 'sse' || input.transport === 'http' ? input.transport : 'stdio'
  const rec: StoredServer = {
    name,
    description: (input.description ?? '').trim(),
    transport
  }
  if (transport === 'stdio') {
    rec.command = (input.command ?? '').trim()
    rec.args = cleanArgs(input.args)
    rec.env = cleanValueMap(input.env)
  } else {
    rec.url = (input.url ?? '').trim()
    rec.headers = cleanValueMap(input.headers)
  }

  const prev = servers[id]
  const wasEnabled = isEnabled(id)
  servers[id] = rec
  const ok = writeAll(servers)

  if (typeof input.enabled === 'boolean') writeEnabled(id, input.enabled)
  else if (isNew) writeEnabled(id, false)

  const change: McpChange = {
    enabled: isEnabled(id) !== wasEnabled,
    connection: !prev || connectionSig(prev) !== connectionSig(rec)
  }
  if (change.enabled || change.connection) changeListener(id, change)

  return { server: { id, ...rec }, ok }
}

/**
 * 删除一个服务：清 mcp.json 条目、启用态、可用角色、以及其全部密钥（`mcp:<id>:` 前缀）。
 *
 * 返回是否**关键的两处配置都写进了磁盘**（mcp.json 与 config.json 的启用态）。
 * 以前是 void，`mcp:remove` 只能硬编码 `{ok:true}`：条目删掉了但盘上还在，重启后又冒出来
 * ——与 `mcp:set-enabled` 同一个形状（本轮把 writeAll / writeEnabledMap / setRoles 改成 boolean 时漏掉的调用方）。
 *
 * 「本来就没有这条」不算失败：那是幂等的删除，没什么可写。
 */
export function deleteServer(id: string): boolean {
  if (!isSafeId(id)) return false
  let ok = true
  const servers = readAll()
  if (id in servers) {
    delete servers[id]
    if (!writeAll(servers)) ok = false
  }
  const map = enabledMap()
  if (id in map) {
    delete map[id]
    if (!writeEnabledMap(map)) ok = false
  }
  if (!setRoles('mcp', id, null)) ok = false
  void deleteSecretsByPrefix(`mcp:${id}:`)
  return ok
}

// ── 连接期：把 `{secretRef}` 解密为可用的明文 env / headers（仅主进程内使用）──────

async function resolveValueMap(
  id: string,
  map: Record<string, McpValue> | undefined
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!map) return out
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string') {
      if (v) out[k] = v
    } else if (v && typeof v.secretRef === 'string') {
      const read = await readSecret(`mcp:${id}:${v.secretRef}`)
      if (read.kind === 'ok') out[k] = read.value
      else if (read.kind === 'unreadable') {
        // 绝不注入空值（那会让 MCP 服务启动后鉴权失败，看不出是本地解不开）；
        // 原因由 missingSecrets 的预检通道报给界面。
        console.warn(`[mcp] ${id} 的字段 ${k} 密钥读不出来：${read.reason}`)
      }
      // absent：本来就没配 → 同样跳过（缺密钥由 missingSecrets 报）
    }
  }
  return out
}

/**
 * 尚无可用值的密钥字段名。连接前预检：缺密钥的服务直接标「待填密钥」，不再明知会鉴权失败还去起进程。
 *
 * ⚠️ **「没配」与「解不开」必须分开**：以前两者都算进这个数组，界面统一提示「待填密钥」——
 * 用户会去重填一遍，而如果是换了账户导致解不开，重填确实能解决，但他不知道为什么；
 * 反过来如果是本机没有加密能力，重填也存不进去。所以额外给一个 `unreadable` 明细。
 */
export async function missingSecrets(
  cfg: McpServerConfig
): Promise<{ fields: string[]; unreadable: Array<{ field: string; reason: string }> }> {
  const map = cfg.transport === 'stdio' ? cfg.env : cfg.headers
  const fields: string[] = []
  const unreadable: Array<{ field: string; reason: string }> = []
  if (!map) return { fields, unreadable }
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string' || !v || typeof v.secretRef !== 'string') continue
    const read = await readSecret(`mcp:${cfg.id}:${v.secretRef}`)
    if (read.kind === 'absent') fields.push(k)
    else if (read.kind === 'unreadable') {
      fields.push(k) // 仍然算「没有可用值」，连接前要拦住
      unreadable.push({ field: k, reason: read.reason })
    }
  }
  return { fields, unreadable }
}

/** 解析 stdio 的环境变量（明文 + 解密后的密钥）。 */
export function resolveEnv(cfg: McpServerConfig): Promise<Record<string, string>> {
  return resolveValueMap(cfg.id, cfg.env)
}

/** 解析 sse / http 的请求头（明文 + 解密后的密钥）。 */
export function resolveHeaders(cfg: McpServerConfig): Promise<Record<string, string>> {
  return resolveValueMap(cfg.id, cfg.headers)
}
