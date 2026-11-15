import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import type { StepStat } from '../shared/import-protocol'

/**
 * 导入第 ⑥ 步：会话（`data/chats/`）。
 *
 * 按 `safeId(id)` 判目标是否已有同名文件，有就跳过。**不用 mtime 判增量**：mtime 会带来「原版删了哪些要不要跟着删」
 * 的传播问题，而本需求是一次性导入——按 id 判存在即天然幂等，原版之后删不删都与这里无关。
 *
 * ⚠️ **成对搬**：主对话的 `members[].sessionId` 与成员会话的 `parentId` 是双向引用。只搬一边，成员卡片点开空白。
 * 所以扫描时把「parentId 非空」的成员会话与其父一起纳入本批；反过来父文件里的 members 也已随父文件整体复制过去。
 * id 原样保留——引用天然有效，不需要任何映射。
 *
 * ⚠️ **compacted 同批**：主 JSON 的 `compacted.file` 存的是拆分文件名（`<id>.compacted-<ts>.jsonl`），
 * 缺了它早期历史读不出来（chat-store 的 readCompacted 返回 null → 那段历史当作不存在）。id 不变则文件名也不用改，
 * 照原文件名复制即可。
 *
 * **不搬 `_index.json`**：它是派生数据，由 ensureIndex() 自愈重建；搬过去反而可能带着指向不存在文件的条目。
 * `model` 与 `focusRoot` 也无需重写：前者是 providerId:modelId（provider id 原样保留，引用天然有效），
 * 后者是绝对路径（同机同盘，两边读到同一个目录）。这两条是旧方案「重写」逻辑在这里整块作废的原因。
 */

/** 会话文件名 → id（去掉 .json；只认最外层主文件，compacted 由单独规则处理）。 */
function sessionIdOf(name: string): string | null {
  if (!name.endsWith('.json') || name === '_index.json') return null
  return name.slice(0, -5)
}

/** 与 chat-store 的 safeId 同一白名单：id 来自磁盘但仍要防路径穿越。 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

/** 把原版会话搬进 DevaPlus，返回复制的会话 id 与拆分文件。 */
export function importSessions(srcHome: string): StepStat & { compacted: string[] } {
  const stat: StepStat & { compacted: string[] } = { copied: [], skipped: [], compacted: [] }
  const srcDir = join(srcHome, 'data', 'chats')
  const dstDir = join(getDevaHome(), 'data', 'chats')
  let names: string[]
  try {
    names = readdirSync(srcDir)
  } catch {
    return stat // 原版没有会话
  }
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch {
    return stat
  }

  // ① 先算出「哪些会话要搬」：全部主文件 + 它们的 compacted。成对关系的保证来自「主对话与成员会话都是独立主文件」，
  //    两边都在同一批里；父文件里的 members 引用随文件内容整体过来，成员文件的 parentId 也原样保留。
  const wanted = new Map<string, string>() // id -> 原文件名
  for (const name of names) {
    const id = sessionIdOf(name)
    if (!id) continue
    wanted.set(id, name)
  }

  for (const [id, name] of wanted) {
    const safe = safeId(id)
    if (!safe) continue
    const from = join(srcDir, name)
    const to = join(dstDir, `${safe}.json`)
    try {
      if (existsSync(to)) {
        // 目标已有：跳过（幂等），但仍要检查 compacted（首次导入可能复制中断过）
        stat.skipped.push(id)
      } else {
        copyFileSync(from, to)
        stat.copied.push(id)
      }
    } catch {
      if (!stat.copied.includes(id) && !stat.skipped.includes(id)) stat.skipped.push(id)
      continue
    }
    copyCompacted(srcDir, dstDir, safe, stat)
  }
  return stat
}

/**
 * 复制某个会话的拆分文件（`<id>.compacted-<ts>.jsonl`），仅当目标没有同名文件时。
 * 文件名里含 id，所以用 `${safe}.compacted-` 前缀匹配即可，不必解析主 JSON 的 compacted 字段。
 */
function copyCompacted(
  srcDir: string,
  dstDir: string,
  safe: string,
  stat: { compacted: string[] }
): void {
  const prefix = `${safe}.compacted-`
  let names: string[]
  try {
    names = readdirSync(srcDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue
    const to = join(dstDir, name)
    if (existsSync(to)) continue
    try {
      copyFileSync(join(srcDir, name), to)
      stat.compacted.push(name)
    } catch {
      /* 单个拆分文件失败：主文件已在，那段历史读不出来，但不影响会话本身 */
    }
  }
}

/**
 * 本批会话里被引用到的 id 集合（供附件步骤按需核对；也便于诊断「成员成对是否齐全」）。
 * 只读主文件，不解析消息体，成本很低。
 */
export function referencedSessionIds(srcHome: string): Set<string> {
  const out = new Set<string>()
  const dir = join(srcHome, 'data', 'chats')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const id = sessionIdOf(name)
    if (!id) continue
    out.add(id)
    try {
      const s = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        members?: { sessionId?: unknown }[]
        parentId?: unknown
      }
      for (const m of s.members ?? []) if (typeof m?.sessionId === 'string') out.add(m.sessionId)
      if (typeof s.parentId === 'string' && s.parentId) out.add(s.parentId)
    } catch {
      /* 坏文件只按文件名计入 */
    }
  }
  return out
}
