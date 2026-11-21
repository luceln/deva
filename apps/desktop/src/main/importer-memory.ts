import { readFileSync } from 'fs'
import { join } from 'path'
import {
  GLOBAL_SCOPE,
  MEMORY_TITLE_MAX,
  isMemoryType,
  listMemories,
  normalizeBody,
  normalizeTitle,
  writeMemory,
  type MemoryInput,
  type MemoryScope
} from './services/memory'
import { readSourceDir, SOURCE_DIR_UNREADABLE } from './importer-source-dir'
import type { MergeStat } from '../shared/import-protocol'

/**
 * 导入第 ④ 步：记忆合并（全局 + 项目私有），逐条判据：
 *
 *  ① 目标已有相同 `id` → 视为同一条，**保留 DevaPlus 的**，不覆盖（用户可能在新应用里改过它）；
 *  ② id 不同但 `content` 逐字相同 → 跳过；
 *  ③ 其余 → 追加。
 *
 * ⚠️ **① 实际几乎不会命中，这是本方案的已知限制**：写回一律走 `writeMemory(content, undefined, …)`，它总是
 * 分配新的随机 id，**源 id 从不落盘**。所以只要内容不同，导入的条目在目标里都是新 id。由此带来一个真实副作用：
 * 历史对话里「记忆更新 [m_xxx]」提到的 id 在目标侧并不存在（内容在、id 换了）。要保住源 id 得改 memory.ts 的
 * 写入接口（允许指定 id 新建，且要处理 id 冲突与预算），超出本模块范围；`writeMemory` 的「id 必须已存在」约束
 * 也不允许从外部塞入 id。保留 ① 分支是为了将来若带上 id 写入时行为正确，且对「源本身就是导出的这份数据」这种
 * 边角情形仍然成立。
 *
 * ⚠️ **必须走 `writeMemory`，不许直接写 memory.json**。配额（单条 300 字、全局 4000 字 / 100 条、项目 3000 字 /
 * 60 条）、去重、规整三条规则只有它会执行。绕过它直接写盘看着「导成功了」，但总量一旦超过预算，此后用户的
 * `memory_write` 会**全线拒写**且没有任何提示——那是把一次导入变成永久的静默故障。
 *
 * ⚠️ **超限是「拒写」不是「抛错」**：`writeMemory` 返回 `{ ok: false, code }`（full / budget / tooLong），
 * 文件一个字节都不写。所以每条都要检查 `ok`，失败进 failures 让界面逐条显示；否则「没写进去」会被当成「写好了」。
 * 不整批中止：按原版顺序能进就进，进不去的记下来，用户清几条记忆后重跑即补齐（幂等）。
 *
 * ⚠️ **`ok: true` 也不等于「新增」**：内容经 `normalize`（换行折成空格、首尾去空白）后若与已有条目逐字相同，
 * `writeMemory` 返回 `{ ok: true, created: false }` 且**不写盘**。只认 `ok` 会把没落盘的条目记进 added，
 * 于是第二次导入仍报「新增 N」，界面也不再显示「无新增」。必须同时看 `created`。
 *
 * 项目记忆目录名可直接对上：`projectMemoryKey` = realpath → 去尾斜杠 → 小写（win/mac）→ sha1 前 24 位。
 * 同机同路径两边算出的 key 必然一致，所以同名目录照搬即可，不需要重算或映射。
 */

interface RawEntry {
  id?: unknown
  /** v2：type / title / body。 */
  type?: unknown
  title?: unknown
  body?: unknown
  /** v1：一句话正文（旧版文件，读到时按 v2 转换，同 memory.ts 的 parseEntry）。 */
  content?: unknown
}

/**
 * 读一个 memory.json：entries + 记在里面原始 root。
 *
 * ⚠️ 以前这个函数返回 `RawEntry[]`，注释还写着「读不到 / 结构不合 → 空」——那句注释本身就是在描述 bug：
 * **读不到是「不知道」，不是「空」**。后果链是完整的静默丢失：读失败 → `[]` → 调用方 `if (!entries.length) continue`
 * → 用户全部记忆不导入，报告里连一条失败都没有。
 *
 * 三态：
 *  - `absent`：ENOENT，原版这个作用域本来就没记忆（全局没有 memory.json，或那个项目没存过）；
 *  - `ok`：读到了、结构正常；
 *  - `unreadable`：被占用 / 无权限 / 半截 JSON → **必须让调用方记失败**，不能当没记忆。
 *
 * 为什么连 root 一起返回（而不是另一个函数再读一遍）：原来 `readEntries` 读一次、`readProjectRoot`
 * 再读一次同一个文件。除了多一次 I/O，两次读之间还留着「内容被改写」的窗口——第一次读到 N 条、第二次
 * 可能已不同；而 root 就在同一份内容里，分开读纯粹是历史原因。
 */
type MemoryFileRead =
  | { kind: 'absent' }
  | { kind: 'ok'; entries: RawEntry[]; root: string | null }
  | { kind: 'unreadable'; reason: string }

function readMemoryFile(file: string): MemoryFileRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', reason: 'source-memory-unreadable' }
  }
  let parsed: { entries?: unknown; root?: unknown }
  try {
    parsed = JSON.parse(raw) as { entries?: unknown; root?: unknown }
  } catch {
    // 读到了但解析不了：内容坏（半截写入）。与「读不出来」分开说，用户处置不同。
    return { kind: 'unreadable', reason: 'source-memory-corrupt' }
  }
  if (!Array.isArray(parsed?.entries)) return { kind: 'unreadable', reason: 'source-memory-corrupt' }
  // root 只对项目记忆有用；缺了由调用方报 missing-root（那是真缺失，不是读失败）
  const root = typeof parsed.root === 'string' && parsed.root.trim() ? parsed.root : null
  return { kind: 'ok', entries: parsed.entries as RawEntry[], root }
}

/**
 * 把一条源记忆规整成 v2 的写入入参（type / title / body）。
 *
 * 源可能来自新版（已有 type / title / body），也可能来自旧版（只有一句话 content）。旧版按
 * `memory.ts` 里同一套规则就地转换：标题取原文第一句、正文保留原文、类型暂记 user——
 * 这样「导入」与「本机读旧文件」得到的是同一份结果，不会出现「导入后标题和本机自动转换的不一样」。
 */
function toInput(raw: RawEntry): { input: MemoryInput; title: string } | null {
  if (typeof raw?.title === 'string' && raw.title.trim()) {
    const title = normalizeTitle(raw.title)
    const body = normalizeBody(typeof raw.body === 'string' ? raw.body : '')
    return { input: { type: isMemoryType(raw.type) ? raw.type : 'user', title, body }, title }
  }
  const content = typeof raw?.content === 'string' ? raw.content : ''
  if (!content.trim()) return null
  const first = normalizeTitle(content)
  const m = first.match(/^.+?[。！？；!?;](?=\s|$|[^\d])/)
  const s = (m && m[0].length <= MEMORY_TITLE_MAX ? m[0] : first).replace(/[。；;，,、：:]+$/, '')
  const title = s.length <= MEMORY_TITLE_MAX ? s : `${s.slice(0, MEMORY_TITLE_MAX - 1)}…`
  return { input: { type: 'user', title, body: normalizeBody(content) }, title }
}

/**
 * 合并一个作用域的记忆。entries 逐条走 writeMemory；三级判据在这里做，配额由 writeMemory 把关。
 * 返回的 added / skipped / failed 里都带标题摘要，界面能看出「哪一条没进来」。
 *
 * 判据按 **v2 的标题**比（旧版是比正文）：同层里标题相同 = 同一主题，那是 `writeMemory` 的去重口径，
 * 这里先拦一遍只是让报告能说明「为什么跳过」，免得白跑一次写入再拿到 duplicate。
 */
function mergeInto(entries: RawEntry[], scope: MemoryScope): MergeStat {
  const stat: MergeStat = { added: [], skipped: [], failed: [] }
  const existing = listMemories(scope)
  const ids = new Set(existing.map((e) => e.id))
  const titles = new Set(existing.map((e) => e.title.toLowerCase()))
  for (const raw of entries) {
    const conv = toInput(raw)
    if (!conv) continue
    const { input, title } = conv
    const id = typeof raw?.id === 'string' ? raw.id : ''
    const label = title.length > 40 ? `${title.slice(0, 40)}…` : title
    // ① id 相同 → 留本地的
    if (id && ids.has(id)) {
      stat.skipped.push(label)
      continue
    }
    // ② 标题相同（同层即同一主题）→ 已有这条，不重复
    if (titles.has(title.toLowerCase())) {
      stat.skipped.push(label)
      continue
    }
    const r = writeMemory(input, undefined, scope)
    if (!r.ok) {
      // 配额满了 / 单条过长 / 文件读不出来：writeMemory 没写盘，如实记失败（不吞掉，界面必须显示）
      stat.failed.push({ step: 'memories', id, reason: r.code })
      continue
    }
    if (!r.created) {
      // 规整后与已有条目相同 → 同样没写盘。既不是新增也不是失败，记跳过（口径与 ② 一致）。
      stat.skipped.push(label)
      continue
    }
    stat.added.push(label)
    ids.add(r.entry.id)
    titles.add(r.entry.title.toLowerCase())
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
  const projects = empty()

  // 全局记忆：读不出来要如实记失败，不能因为「读不到」就当成「原版没有记忆」。
  const g = readMemoryFile(join(srcHome, 'memory.json'))
  const global = g.kind === 'unreadable' ? empty() : mergeInto(g.kind === 'ok' ? g.entries : [], GLOBAL_SCOPE)
  if (g.kind === 'unreadable') {
    global.failed.push({ step: 'memories', id: '<memory.json>', reason: g.reason })
  }

  /*
   * 源侧静默第 7 处。原注释「原版没有项目记忆目录（ENOENT 是常态）」后半句对、前半句是错的：
   * `projects` 被同名文件占住（ENOTDIR）/ ACL 改坏（EACCES）/ 被杀毒锁住（EBUSY）时，**所有项目**的记忆
   * 都一条不导，而报告只说「记忆 0 条」。
   *
   * 注意这处的爆炸半径比别处大：一个目录读不出来，覆盖的是「全部项目」的记忆，不是某一个。
   */
  const projectsList = readSourceDir(join(srcHome, 'projects'), true)
  if (projectsList.kind === 'unreadable') {
    projects.failed.push({ step: 'memories', id: '<projects>', reason: SOURCE_DIR_UNREADABLE })
  }
  const projectDirs =
    projectsList.kind === 'ok'
      ? (projectsList.dirents ?? [])
          .filter((d) => d.isDirectory() && /^[0-9a-f]{24}$/.test(d.name))
          .map((d) => d.name)
      : []
  for (const key of projectDirs) {
    const file = join(srcHome, 'projects', key, 'memory.json')
    const read = readMemoryFile(file)
    // 读不出来：这个项目的记忆一条都没导入，必须让用户看到（以前这里静默 continue）
    if (read.kind === 'unreadable') {
      projects.failed.push({ step: 'memories', id: key, reason: read.reason })
      continue
    }
    if (read.kind === 'absent' || !read.entries.length) continue
    // 项目记忆的 scope 要 root；但目标目录名只取决于 key。这里用「目标侧同 key 目录」定位：
    // writeMemory 会按 scope.root 重算 key，所以必须给出能与 key 对应的 root。
    // memory.json 里记着原始 root（saveMemories 写入的 `root` 字段），用它最稳；没有则跳过该项目（无法定位作用域）。
    if (!read.root) {
      projects.failed.push({
        step: 'memories',
        id: key,
        reason: 'missing-root'
      })
      continue
    }
    const r = mergeInto(read.entries, { kind: 'project', root: read.root })
    projects.added.push(...r.added)
    projects.skipped.push(...r.skipped)
    projects.failed.push(...r.failed)
  }
  return { global, projects }
}
