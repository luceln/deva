import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { GLOBAL_SCOPE, listMemories, projectMemoryKey, writeMemory } from './services/memory'
import type { MergeStat } from '../shared/import-protocol'

/**
 * 导入第 ④ 步：记忆合并（全局 + 项目私有），三级判据按序：
 *
 *  ① 目标已有相同 `id` → 视为同一条，**保留 DevaPlus 的**，不覆盖（用户可能在新应用里改过它）；
 *  ② id 不同但 `content` 逐字相同 → 跳过（writeMemory 自身也是这个口径，重复条目没有意义）；
 *  ③ 其余 → 追加。
 *
 * ⚠️ **必须走 `writeMemory`，不许直接写 memory.json**。配额（单条 300 字、全局 4000 字 / 100 条、项目 3000 字 /
 * 60 条）、去重、规整三条规则只有它会执行。绕过它直接写盘看着「导成功了」，但总量一旦超过预算，此后用户的
 * `memory_write` 会**全线拒写**且没有任何提示——那是把一次导入变成永久的静默故障。
 *
 * ⚠️ **超限是「拒写」不是「抛错」**：`writeMemory` 返回 `{ ok: false, code }`（full / budget / tooLong），
 * 文件一个字节都不写。所以每条都要检查 `ok`，失败进 failures 让界面逐条显示；否则「没写进去」会被当成「写好了」。
 * 不整批中止：按原版顺序能进就进，进不去的记下来，用户清几条记忆后重跑即补齐（幂等）。
 *
 * 项目记忆目录名可直接对上：`projectMemoryKey` = realpath → 去尾斜杠 → 小写（win/mac）→ sha1 前 24 位。
 * 同机同路径两边算出的 key 必然一致，所以同名目录照搬即可，不需要重算或映射。
 */

type Cfg = Record<string, unknown>

interface RawEntry {
  id?: unknown
  content?: unknown
}

/** 读一个 memory.json 的 entries（读不到 / 结构不合 → 空）。 */
function readEntries(file: string): RawEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }
    return Array.isArray(parsed?.entries) ? (parsed.entries as RawEntry[]) : []
  } catch {
    return []
  }
}

/**
 * 合并一个作用域的记忆。entries 逐条走 writeMemory；三级判据在这里做，配额由 writeMemory 把关。
 * 返回的 added / skipped / failed 里都带正文摘要，界面能看出「哪一条没进来」。
 */
function mergeInto(entries: RawEntry[], scope: { kind: 'global' } | { kind: 'project'; root: string }): MergeStat {
  const stat: MergeStat = { added: [], skipped: [], failed: [] }
  const existing = listMemories(scope)
  const ids = new Set(existing.map((e) => e.id))
  const contents = new Set(existing.map((e) => e.content))
  for (const raw of entries) {
    const content = typeof raw?.content === 'string' ? raw.content : ''
    if (!content.trim()) continue
    const id = typeof raw?.id === 'string' ? raw.id : ''
    const label = content.length > 40 ? `${content.slice(0, 40)}…` : content
    // ① id 相同 → 留本地的
    if (id && ids.has(id)) {
      stat.skipped.push(label)
      continue
    }
    // ② 正文逐字相同 → 已有这条，不重复
    if (contents.has(content)) {
      stat.skipped.push(label)
      continue
    }
    const r = writeMemory(content, undefined, scope)
    if (!r.ok) {
      // 配额满了 / 单条过长：writeMemory 没写盘，如实记失败（不吞掉，界面必须显示）
      stat.failed.push({ step: 'memories', id, reason: r.code })
      continue
    }
    stat.added.push(label)
    ids.add(r.entry.id)
    contents.add(r.entry.content)
  }
  return stat
}

/**
 * 导入全局记忆 + 所有项目私有记忆。
 *
 * 两边的失败都逐条带原因放进各自的 `failed`（调用方合并成 report.memories.failed 给界面显示）——
 * 不再额外提供 `globalFailed` 之类的布尔汇总：那是 `global.failed.length > 0` 的派生值，
 * 多一个字段就多一处可能与明细对不上的地方。
 *
 * 项目目录按目录名原样对上即可——key 由真实路径算出、同机同路径两边一致，所以不需要还原出 root 再重算
 * （目录名本身就是权威值）；写回时仍要用 root，因为 writeMemory 会按 scope.root 重算 key。
 */
export function importMemories(srcHome: string): { global: MergeStat; projects: MergeStat } {
  const empty = (): MergeStat => ({ added: [], skipped: [], failed: [] })
  const global = mergeInto(readEntries(join(srcHome, 'memory.json')), GLOBAL_SCOPE)
  const projects = empty()
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(join(srcHome, 'projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9a-f]{24}$/.test(d.name))
      .map((d) => d.name)
  } catch {
    /* 原版没有项目记忆目录 */
  }
  for (const key of projectDirs) {
    const entries = readEntries(join(srcHome, 'projects', key, 'memory.json'))
    if (!entries.length) continue
    // 项目记忆的 scope 要 root；但目标目录名只取决于 key。这里用「目标侧同 key 目录」定位：
    // writeMemory 会按 scope.root 重算 key，所以必须给出能与 key 对应的 root。
    // memory.json 里记着原始 root（saveMemories 写入的 `root` 字段），用它最稳；没有则跳过该项目（无法定位作用域）。
    const root = readProjectRoot(join(srcHome, 'projects', key, 'memory.json'))
    if (!root) {
      projects.failed.push({
        step: 'memories',
        id: key,
        reason: 'missing-root'
      })
      continue
    }
    const r = mergeInto(entries, { kind: 'project', root })
    projects.added.push(...r.added)
    projects.skipped.push(...r.skipped)
    projects.failed.push(...r.failed)
  }
  return { global, projects }
}

/**
 * 取项目记忆文件里记下的原始 root（saveMemories 会顺带写 `root`，只为人工排查用）。
 * 有它才能把条目写回**同一个 key 目录**：writeMemory 按 scope.root 重算 key，root 不对就会写到别的项目去。
 * 若文件里没有 root，退而求其次：无法反推路径，只能跳过——写错地方比不写更糟。
 */
function readProjectRoot(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Cfg
    const root = parsed.root
    return typeof root === 'string' && root.trim() ? root : null
  } catch {
    return null
  }
}

/** 项目记忆目录名是否与某个 root 对应（供导入后核对用，也说明 key 的用法）。 */
export function projectKeyOf(root: string): string {
  return projectMemoryKey(root)
}
