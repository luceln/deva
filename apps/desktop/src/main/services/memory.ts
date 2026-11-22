import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'path'
import { getDevaHome } from './config'
import { projectMemoryRootOf } from './worktree/scope'

/**
 * 记忆（Memory）服务 v2（方案 design/memory-v2-plan.html，借鉴 Claude Code），分三层（scope）：
 * - **global**（界面叫「关于你」）：`<DEVA_HOME>/memory.json`，用户本人的情况，以及对所有角色都适用的做事要求。
 * - **role**（角色记忆）：`<DEVA_HOME>/personas/memory/<角色 id>.json`，某个角色做自己那类工作时学到的东西；
 *   只有这个角色读写（它的定时任务、它当成员时只读）。按 id 存，改名不受影响；删角色时连同删除（先备份）。
 * - **project**（项目记忆）：`<DEVA_HOME>/projects/<key>/memory.json`，按工作区隔离的私有经验与进展，不入版本库。
 *   key = 工作区真实路径（realpath）规整后 sha1 前 24 位。团队共享的约定仍归 AGENTS.md。
 *
 * 每条记忆有类型（user 用户 / feedback 做事方式 / project 进展 / reference 资料）、一句话标题和多行正文。
 * 随消息下发的是标题索引（做事方式类附正文，见 listing.ts），其余正文由模型用 memory_read 按 id 读取——记忆再多
 * 也只占索引的上下文。上限按索引行计：条数与索引总字数两重上限，各层独立；模型写入撞上限时先自动归纳
 * （memory-consolidate.ts）。
 *
 * 旧版（v1，每条一句话 content）读到时自动转换：先备份原文件，标题取原文第一句、正文保留原文、类型暂记为 user，
 * 并标记待整理，由下一轮对话用当轮模型补上类型与标题（memory-tidy.ts）。
 *
 * 由模型经 memory_read / memory_write / memory_delete 读写（memory-tools.ts），用户经 `memory:*` IPC 在面板里查看、
 * 修改、删除；两边同一套校验。主进程单线程 + 同步读改写，多会话并行写入不会交错；写入走临时文件 + rename。
 *
 * ## 二开语义（合并上游 v2 时保留，勿因对齐上游改回去）
 *
 * 1. **读取三态**（`MemoryRead`）：`absent` / `ok` / `unreadable` 分开。上游 v2 的 `readMemoryFile` 在
 *    「读不出来 / 解析失败 / 结构异常」时一律 `return { entries: [] }`，而写入是「读全量 → 改 → 整份覆盖」，
 *    一次瞬时占用（Windows 上杀毒扫盘 EBUSY）、一次权限变更、一次半截 JSON，都会把用户**全部记忆**覆盖成
 *    一条甚至零条。这是最危险的一类静默错误：不报错，但数据没了。所以所有写盘路径一律走 `readMemoryFileState`
 *    并在 `unreadable` 时拒绝写入（`readFailed`）。
 * 2. **落盘失败是一种返回值而不是异常**（`writeFailed`）：导入器、工具、面板三处调用都更愿意拿到 `ok:false`，
 *    而不是被迫 try/catch（导入器那样会整轮中断）。
 * 3. **`memory-changed`**：归纳期间这条记忆被改 / 被删，本次写入作废。与 `notFound`（一开始就不存在）分开，
 *    用户的处置不同（前者重试即可拿最新内容，后者去查 id）。
 * 4. **面板快照带 `readError`**：读不出来时界面必须显示「文件坏了」，不能显示成「还没有记忆」——后者会诱导
 *    用户写新条目，从而拿空集合覆盖掉那份本来还能手工抢救的文件。
 * 5. **项目记忆根解析**：worktree 会话用的是主仓库的项目记忆（`projectMemoryRootOf`），否则在 worktree 里
 *    读到的是一份全新空记忆，用户在主仓库的踩坑一条都看不见。
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

export interface MemoryEntry {
  /** 稳定短 id（全局 m_ / 角色 r_ / 项目 p_ + 8 位十六进制），供读取正文、更新、删除引用。 */
  id: string
  type: MemoryType
  /** 一句话标题：进索引，只看它就能判断与当前任务是否相关。 */
  title: string
  /** 正文：规则或事实，做事方式与进展类另写原因与何时适用；可为空。 */
  body: string
  createdAt: number
  updatedAt: number
}

/** 写入入参：新增时 type 与 title 必填；按 id 更新时省略的字段保持原值。 */
export interface MemoryInput {
  type?: MemoryType
  title?: string
  body?: string
}

/** 记忆作用域：全局（用户本人）/ 某个角色 / 某个工作区。 */
export type MemoryScope = { kind: 'global' } | { kind: 'role'; personaId: string } | { kind: 'project'; root: string }

export const GLOBAL_SCOPE: MemoryScope = { kind: 'global' }

/**
 * 一次回合里各层记忆的读写方式（主对话全可写；项目成员全局与角色只读、项目可写；定时任务全只读）。
 * 项目记忆的工作区以 ToolContext.workspaceRoot 的实时值为准（轮中挂载后即生效），这里只记读写方式。
 */
export interface MemoryAccess {
  global: 'rw' | 'ro'
  role: { personaId: string; name: string; mode: 'rw' | 'ro' }
  project: 'rw' | 'ro'
}

/** 标题、正文字数上限（各层共用）。 */
export const MEMORY_TITLE_MAX = 60
export const MEMORY_BODY_MAX = 1500
/** 全局与每个角色：条数 / 索引总字数上限。 */
export const MEMORY_MAX_ENTRIES = 100
export const MEMORY_INDEX_BUDGET = 4000
/** 每个项目：条数 / 索引总字数上限。 */
export const PROJECT_MEMORY_MAX_ENTRIES = 60
export const PROJECT_MEMORY_INDEX_BUDGET = 3000

interface Limits {
  maxEntries: number
  budget: number
}

export function memoryLimits(scope: MemoryScope): Limits {
  return scope.kind === 'project'
    ? { maxEntries: PROJECT_MEMORY_MAX_ENTRIES, budget: PROJECT_MEMORY_INDEX_BUDGET }
    : { maxEntries: MEMORY_MAX_ENTRIES, budget: MEMORY_INDEX_BUDGET }
}

/** id 前缀 → 作用域类别（供读取 / 更新 / 删除时自动定位）。 */
export function scopeKindOfId(id: string): MemoryScope['kind'] {
  return id.startsWith('p_') ? 'project' : id.startsWith('r_') ? 'role' : 'global'
}

/** 角色 id 是否可直接当文件名（同 personas.ts 的 isSafeId）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/**
 * 工作区 → 稳定的项目记忆键。按真实路径算（符号链接 / 大小写不同的写法指向同一项目即同一份记忆），
 * 取不到真实路径（目录已不存在等）回落原路径。Windows / macOS 默认大小写不敏感，统一转小写。
 */
export function projectMemoryKey(root: string): string {
  let p = root
  try {
    p = realpathSync.native(root)
  } catch {
    /* 回落原路径 */
  }
  let norm = p.replace(/[\\/]+$/, '')
  if (process.platform === 'win32' || process.platform === 'darwin') norm = norm.toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 24)
}

/** 某作用域的记忆文件路径（归纳、迁移的备份放在同目录的 memory-backups/ 下）。 */
export function memoryPath(scope: MemoryScope): string {
  if (scope.kind === 'project')
    return join(getDevaHome(), 'projects', projectMemoryKey(scope.root), 'memory.json')
  if (scope.kind === 'role') return join(getDevaHome(), 'personas', 'memory', `${scope.personaId}.json`)
  return join(getDevaHome(), 'memory.json')
}

const TYPE_LABEL: Record<MemoryType, string> = { user: '用户', feedback: '做事方式', project: '进展', reference: '资料' }

/** 给模型看的类型名（界面另有自己的叫法，见 i18n）。 */
export function memoryTypeLabel(t: MemoryType): string {
  return TYPE_LABEL[t]
}

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v)
}

export function scopeLabel(scope: MemoryScope): string {
  return scope.kind === 'project' ? '项目记忆' : scope.kind === 'role' ? '角色记忆' : '全局记忆'
}

/** 规整标题：单行、去首尾空白。 */
export function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 规整正文：统一换行、去首尾空白、连续空行压成一个。 */
export function normalizeBody(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 旧版一句话 → 标题：取第一句（最多 60 字），太长截断加省略号。 */
function firstSentence(content: string): string {
  const text = normalizeTitle(content)
  const m = text.match(/^.+?[。！？；!?;](?=\s|$|[^\d])/)
  const s = (m && m[0].length <= MEMORY_TITLE_MAX ? m[0] : text).replace(/[。；;，,、：:]+$/, '')
  return s.length <= MEMORY_TITLE_MAX ? s : `${s.slice(0, MEMORY_TITLE_MAX - 1)}…`
}

// ── 读写文件 ────────────────────────────────────────────────────────────────────

interface MemoryFile {
  entries: MemoryEntry[]
  /** 旧版转换来的条目还没由模型补上类型与标题（见 memory-tidy.ts）。 */
  tidy?: 'pending'
  /** 整理已失败的次数：到上限即放弃，保留规则转换的结果。 */
  tidyTries?: number
}

function parseEntry(raw: unknown): { entry: MemoryEntry; legacy: boolean } | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string') return null
  const createdAt = Number(e.createdAt) || 0
  const updatedAt = Number(e.updatedAt) || createdAt
  if (typeof e.title === 'string') {
    return {
      entry: {
        id: e.id,
        type: isMemoryType(e.type) ? e.type : 'user',
        title: e.title,
        body: typeof e.body === 'string' ? e.body : '',
        createdAt,
        updatedAt
      },
      legacy: false
    }
  }
  // v1：每条一句话 content。
  if (typeof e.content !== 'string') return null
  return {
    entry: { id: e.id, type: 'user', title: firstSentence(e.content), body: e.content, createdAt, updatedAt },
    legacy: true
  }
}

/**
 * 读取记忆文件的**三态**结果（二开语义 ①）。
 *
 * 为什么单调的 `MemoryFile` 不够：`{ entries: [] }` 同时表示「确实没有」和「读不出来」两件事，而写入路径是
 * 「读全量 → 改 → 整份覆盖」。把「读不出来」当成「没有」，一次瞬时占用就会抹掉用户全部记忆。
 * `unreadable` 必须让写入直接拒绝，并把原因浮到界面 / 工具返回。
 */
export type MemoryRead =
  /** 文件不存在：这是第一次使用，`entries` 为空且可以安全写入。 */
  | { kind: 'absent'; entries: MemoryEntry[]; file: MemoryFile }
  /** 读到了且解析成功。 */
  | { kind: 'ok'; entries: MemoryEntry[]; file: MemoryFile }
  /** 存在但读不出来 / 解析不了：**不知道盘上有什么，绝不能覆盖写**。 */
  | { kind: 'unreadable'; error: string }

/**
 * 读某作用域的记忆文件，三态返回。
 *
 * ## ⚠️ 为什么不能「读失败就返回空」
 *
 * 这个结果会被**整体覆盖写回**（writeMemory / deleteMemory 都是「读全量 → 改 → 落盘」）。
 * 若读失败返回空集合，一次瞬时故障就会把用户的全量记忆覆盖成只剩这一条：
 *
 *  - 文件被独占（Windows 上杀毒 / 索引服务扫盘）→ readFileSync 抛 EBUSY；
 *  - 权限被改坏（EACCES）；
 *  - 文件是半截 JSON（上次写盘中断）→ JSON.parse 抛。
 *
 * 三种情况下「盘上其实有内容」，返回空就等于宣布「你本来就没有记忆」，随后写入会把它抹掉。
 */
function readMemoryFileState(scope: MemoryScope): MemoryRead {
  const p = memoryPath(scope)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    // ENOENT = 真的还没有（第一次使用）。其它错误是「读不到」，绝不能当成空
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', entries: [], file: { entries: [] } }
    return { kind: 'unreadable', error: (e as Error)?.message ?? String(e) }
  }
  let parsed: { entries?: unknown; tidy?: unknown; tidyTries?: unknown }
  try {
    parsed = JSON.parse(raw) as { entries?: unknown; tidy?: unknown; tidyTries?: unknown }
  } catch (e) {
    // 解析不了 = 内容坏（半截写入）。写入前必须拦住，否则会拿「只有一条」覆盖掉原本能救回的文件
    return { kind: 'unreadable', error: `记忆文件解析失败：${(e as Error)?.message ?? String(e)}` }
  }
  if (!Array.isArray(parsed?.entries)) return { kind: 'unreadable', error: '记忆文件结构异常（entries 不是数组）' }
  const entries: MemoryEntry[] = []
  let legacy = false
  for (const r of parsed.entries) {
    const hit = parseEntry(r)
    if (!hit) continue
    entries.push(hit.entry)
    legacy ||= hit.legacy
  }
  const file: MemoryFile = {
    entries,
    ...(parsed.tidy === 'pending' ? { tidy: 'pending' as const } : {}),
    ...(typeof parsed.tidyTries === 'number' ? { tidyTries: parsed.tidyTries } : {})
  }
  if (legacy) {
    // 旧版文件：原样备份一份，再按新格式写回并标记待整理（只转换一次）。
    try {
      const dir = join(dirname(p), 'memory-backups')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `memory-v1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), raw, 'utf8')
      file.tidy = 'pending'
      writeMemoryFile(scope, file)
    } catch {
      /* 写不了：本次按转换结果用，下次再试 */
    }
  }
  return { kind: 'ok', entries: file.entries, file }
}

/**
 * 读文件，读不出来时**回落空集**的便利版本。
 *
 * ⚠️ 只能给「不写盘」的只读路径用（拼提示词、算统计）。**凡是要落盘的地方都不许用它**——那样读失败会被
 * 写成「空」。写入路径一律用 `readMemoryFileState`，见 `readFailed`。
 */
function readMemoryFile(scope: MemoryScope): MemoryFile {
  const r = readMemoryFileState(scope)
  return r.kind === 'unreadable' ? { entries: [] } : r.file
}

function writeMemoryFile(scope: MemoryScope, file: MemoryFile): void {
  const p = memoryPath(scope)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  // 项目 / 角色记忆顺带记下来源：只为人工排查「这个文件是谁的」，读取时不依赖它。
  const body = {
    version: 2,
    ...(scope.kind === 'project' ? { root: scope.root } : scope.kind === 'role' ? { personaId: scope.personaId } : {}),
    ...(file.tidy ? { tidy: file.tidy } : {}),
    ...(file.tidyTries ? { tidyTries: file.tidyTries } : {}),
    entries: file.entries
  }
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
  renameSync(tmp, p)
}

/** 读取某作用域的全部记忆（按创建先后）。文件不存在 / 损坏视为空，绝不抛错。 */
export function listMemories(scope: MemoryScope = GLOBAL_SCOPE): MemoryEntry[] {
  if (scope.kind === 'role' && !isSafeId(scope.personaId)) return []
  return readMemoryFile(scope).entries
}

/**
 * 读取某作用域的全部记忆，**三态**（写入路径用；见 `MemoryRead` 的说明）。
 *
 * 名字与旧二开实现保持一致：`memory-consolidate.ts` / `memory-tools.ts` / 导入器都按这个三态判断，
 * 换成上游的 `listMemories()`（读失败回落空集）会把这些路径上的「读不出来」重新变回「没有」。
 */
export function readMemories(scope: MemoryScope = GLOBAL_SCOPE): MemoryRead {
  if (scope.kind === 'role' && !isSafeId(scope.personaId))
    return { kind: 'unreadable', error: '角色 id 不合法（可能找不到这个角色）' }
  const r = readMemoryFileState(scope)
  return r.kind === 'unreadable' ? r : { kind: r.kind, entries: r.file.entries, file: r.file }
}

/** 是否有旧版转换来、待模型整理的条目，以及已失败的次数。 */
export function memoryTidyState(scope: MemoryScope): { pending: boolean; tries: number } {
  if (scope.kind === 'role' && !isSafeId(scope.personaId)) return { pending: false, tries: 0 }
  const f = readMemoryFile(scope)
  return { pending: f.tidy === 'pending', tries: f.tidyTries ?? 0 }
}

/** 整理结束：写回整理后的条目并清掉待整理标记（entries 省略 = 只记一次失败）。 */
export function finishMemoryTidy(scope: MemoryScope, entries: MemoryEntry[] | null, giveUp: boolean): void {
  const r = readMemoryFileState(scope)
  // 读不出来时不写：整理结果会整份覆盖，盲目写会把读不到的旧条目抹掉
  if (r.kind === 'unreadable') return
  const f = r.file
  if (entries) writeMemoryFile(scope, { entries })
  else if (giveUp) writeMemoryFile(scope, { entries: f.entries })
  else writeMemoryFile(scope, { ...f, tidyTries: (f.tidyTries ?? 0) + 1 })
}

export function newMemoryId(scope: MemoryScope, existing: MemoryEntry[]): string {
  const prefix = scope.kind === 'project' ? 'p_' : scope.kind === 'role' ? 'r_' : 'm_'
  const ids = new Set(existing.map((e) => e.id))
  for (;;) {
    const id = `${prefix}${randomBytes(4).toString('hex')}`
    if (!ids.has(id)) return id
  }
}

/** 索引里那一行的文本（标题索引按这个长度计预算）。 */
export function formatMemoryLine(e: Pick<MemoryEntry, 'id' | 'type' | 'title'>): string {
  return `${e.id} [${memoryTypeLabel(e.type)}] ${e.title}`
}

/** 当前索引总字数（与随消息下发同一口径）。 */
export function memoryUsage(entries: Pick<MemoryEntry, 'id' | 'type' | 'title'>[]): number {
  return entries.reduce((n, e) => n + formatMemoryLine(e).length, 0)
}

/** 失败原因码：渲染层据此走 i18n，工具回灌则用 error 文本。 */
export type MemoryErrorCode =
  | 'empty'
  | 'tooLong'
  | 'full'
  | 'budget'
  | 'notFound'
  | 'duplicate'
  | 'badType'
  /**
   * 落盘失败（磁盘满 / 无权限 / 文件被占）。**与上面几个码性质不同**：那些是「输入不合法，改一改就能写」，
   * 这个是「输入没问题，但这次没存下去」。以前它表现为抛异常，导入器整轮被掀翻；现在作为一种普通失败返回。
   */
  | 'writeFailed'
  /**
   * **读取**失败（文件被占用 / 无权限 / 半截 JSON）→ 为免覆盖掉盘上原有内容，本次拒绝写入。
   * 与 `writeFailed` 必须分开：那条是「读了但没写下去，重试就行」，这条是「连盘上有什么都不知道」，
   * 处置完全不同（要先检查文件，绝不能盲目重试——重试的后果是拿一条覆盖全量）。
   */
  | 'readFailed'
  /**
   * 归纳期间这条记忆被改动 / 删除 / 合并掉了，本次写入作废。
   *
   * 与 `notFound`（一开始就不存在）分开：这条**曾经存在**，是并发改动让它不再是本次要写的那份，
   * 用户的处置也不同（前者去查 id，后者重试一次即可拿最新内容）。
   */
  | 'memory-changed'

export type MemoryWriteResult =
  | { ok: true; entry: MemoryEntry; created: boolean }
  | { ok: false; code: MemoryErrorCode; error: string }

function budgetError(scope: MemoryScope, used: number): MemoryWriteResult {
  return {
    ok: false,
    code: 'budget',
    error: `${scopeLabel(scope)}的索引总量已达上限（写入后 ${used} 字，上限 ${memoryLimits(scope).budget}）：请用 memory_write 带 id 合并相近条目、缩短标题，或用 memory_delete 删除过时条目后再写`
  }
}

/**
 * 落盘失败的统一表达。刻意不写成抛异常：这条路径会经过记忆面板的 IPC、memory_write 工具、以及导入器，
 * 三处都更愿意拿到一个 `ok:false` 而不是被迫 try/catch（导入器那边的后果是整轮中断）。
 */
function writeFailed(scope: MemoryScope): MemoryWriteResult {
  return {
    ok: false,
    code: 'writeFailed',
    error: `${scopeLabel(scope)}未能写入磁盘（磁盘空间 / 权限 / 文件被占用），本次修改没有保存`
  }
}

/**
 * 「读不出来」的统一表达。与 `writeFailed` 分开：那条是「读到了但没写下去」，这条是「连盘上有什么都不知道」。
 *
 * 为什么不能用 `writeFailed`：文案会让用户以为「只是这次没存上，重试即可」，而实际上一次覆盖写会把
 * 盘上原有内容换成「只有这一条」。两者的处置完全不同（后者要用户先检查文件）。
 */
function readFailed(scope: MemoryScope, why: string): MemoryWriteResult {
  return {
    ok: false,
    code: 'readFailed',
    error: `${scopeLabel(scope)}文件读不出来（${why}），为避免覆盖掉原有内容，本次没有写入`
  }
}

/** 新增（无 id）或按 id 更新一条记忆。 */
export function writeMemory(input: MemoryInput, id?: string, scope: MemoryScope = GLOBAL_SCOPE): MemoryWriteResult {
  if (scope.kind === 'role' && !isSafeId(scope.personaId))
    return { ok: false, code: 'notFound', error: '找不到这个角色的记忆' }
  const lim = memoryLimits(scope)
  // ⚠️ 必须先用三态读：读不出来时写下去就是「拿一条覆盖全量」
  const read = readMemoryFileState(scope)
  if (read.kind === 'unreadable') return readFailed(scope, read.error)
  const file = read.file
  const entries = file.entries
  const hit = id ? entries.find((e) => e.id === id) : undefined
  if (id && !hit)
    return {
      ok: false,
      code: 'notFound',
      error: `${scopeLabel(scope)}中不存在 id 为 ${id} 的记忆（可先用 memory_read 查看现有记忆）`
    }
  const type = input.type ?? hit?.type
  if (!type || !isMemoryType(type))
    return { ok: false, code: 'badType', error: '缺少有效的类型 type（user / feedback / project / reference）' }
  const title = input.title !== undefined ? normalizeTitle(input.title) : (hit?.title ?? '')
  const body = input.body !== undefined ? normalizeBody(input.body) : (hit?.body ?? '')
  if (!title) return { ok: false, code: 'empty', error: '记忆标题为空' }
  if (title.length > MEMORY_TITLE_MAX)
    return {
      ok: false,
      code: 'tooLong',
      error: `标题过长（${title.length} 字，上限 ${MEMORY_TITLE_MAX}）：标题只写一句话概括，细节写进正文 body`
    }
  if (body.length > MEMORY_BODY_MAX)
    return { ok: false, code: 'tooLong', error: `正文过长（${body.length} 字，上限 ${MEMORY_BODY_MAX}）：请精简` }
  // 同层里标题相同 = 同一主题：新增时内容也一样视为已记住，不一样则提示带 id 更新；更新时撞上别的条目也拒。
  const key = title.toLowerCase()
  const twin = entries.find((e) => e.id !== id && e.title.toLowerCase() === key)
  if (twin) {
    if (!hit && twin.body === body && twin.type === type) return { ok: true, entry: twin, created: false }
    return {
      ok: false,
      code: 'duplicate',
      error: `已有同标题的记忆（id=${twin.id}）：同一主题请带这个 id 更新，不要重复新增`
    }
  }
  const now = Date.now()
  if (hit) {
    const next = { ...hit, type, title, body }
    const used = memoryUsage(entries) - formatMemoryLine(hit).length + formatMemoryLine(next).length
    // 只拒「越改越超」：缩短 / 不变的更新即便总量仍超（旧数据）也放行，否则永远没法合并瘦身。
    if (used > lim.budget && formatMemoryLine(next).length > formatMemoryLine(hit).length) return budgetError(scope, used)
    Object.assign(hit, { type, title, body, updatedAt: now })
    try {
      writeMemoryFile(scope, file)
    } catch {
      return writeFailed(scope)
    }
    return { ok: true, entry: hit, created: false }
  }
  if (entries.length >= lim.maxEntries)
    return {
      ok: false,
      code: 'full',
      error: `${scopeLabel(scope)}已满（上限 ${lim.maxEntries} 条）：请先用 memory_delete 删除过时条目，或用 memory_write 带 id 合并相近条目`
    }
  const entry: MemoryEntry = { id: newMemoryId(scope, entries), type, title, body, createdAt: now, updatedAt: now }
  const used = memoryUsage(entries) + formatMemoryLine(entry).length
  if (used > lim.budget) return budgetError(scope, used)
  entries.push(entry)
  try {
    writeMemoryFile(scope, file)
  } catch {
    return writeFailed(scope)
  }
  return { ok: true, entry, created: true }
}

/** 删除一条记忆；不存在 / 读不出来 / 写不下去时如实说明原因。三种结果要分开，否则调用方说不清原因。 */
export interface MemoryDeleteResult {
  /** 被删掉的条目；没有删到（不存在 / 读不出 / 写失败）时为 null。 */
  deleted: MemoryEntry | null
  /** 是否真的改动了盘上内容。`false` 且 `deleted` 非空 = 删是删了但没落盘。 */
  written: boolean
  /** 连盘上有什么都不知道（读失败）。与「不存在这条 id」必须分开。 */
  readError?: string
}

export function deleteMemory(id: string, scope: MemoryScope = GLOBAL_SCOPE): MemoryDeleteResult {
  if (scope.kind === 'role' && !isSafeId(scope.personaId)) return { deleted: null, written: false }
  const read = readMemoryFileState(scope)
  if (read.kind === 'unreadable') return { deleted: null, written: false, readError: read.error }
  const file = read.file
  const idx = file.entries.findIndex((e) => e.id === id)
  if (idx < 0) return { deleted: null, written: false }
  const [removed] = file.entries.splice(idx, 1)
  try {
    writeMemoryFile(scope, file)
  } catch {
    return { deleted: null, written: false }
  }
  return { deleted: removed, written: true }
}

/**
 * 整体替换某作用域的全部条目（归纳后写回，见 memory-consolidate.ts）；待整理标记原样保留。
 * 返回是否真的写下去了：写失败 / 读不出来都返回 false，调用方据此报 `readFailed` / `writeFailed`，
 * 而不是「以为替换成功」。
 */
export function replaceMemories(scope: MemoryScope, entries: MemoryEntry[]): boolean {
  const read = readMemoryFileState(scope)
  if (read.kind === 'unreadable') return false
  try {
    writeMemoryFile(scope, { ...read.file, entries })
  } catch {
    return false
  }
  return true
}

/** 清空某作用域的全部记忆（仅用户经面板触发；模型没有对应工具）。读不出来时不写，返回 false。 */
export function clearMemories(scope: MemoryScope = GLOBAL_SCOPE): boolean {
  const read = readMemoryFileState(scope)
  if (read.kind === 'unreadable') return false
  try {
    writeMemoryFile(scope, { entries: [] })
  } catch {
    return false
  }
  return true
}

/** 删除角色时连同它的记忆一起删：先备份到同目录的 memory-backups/。 */
export function removeRoleMemory(personaId: string): void {
  if (!isSafeId(personaId)) return
  const p = memoryPath({ kind: 'role', personaId })
  if (!existsSync(p)) return
  try {
    const dir = join(dirname(p), 'memory-backups')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${personaId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      readFileSync(p, 'utf8'),
      'utf8'
    )
    rmSync(p, { force: true })
  } catch {
    /* 备份不了就不删：留着比误删强 */
  }
}

// ── 面板 IPC ────────────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  entries: MemoryEntry[]
  /** 当前索引总字数（与随消息下发同一口径）。 */
  used: number
  budget: number
  maxEntries: number
  maxTitle: number
  maxBody: number
  /**
   * 读失败时的原因（二开语义 ④）。
   *
   * 以前这里只有 `entries`：文件损坏时 `listMemories()` 给出空数组，界面于是显示「还没有记忆」。
   * 用户按这个提示去写新条目，会拿一份空集合覆盖掉那份可能还能手工抢救的文件。必须能把「读不出来」
   * 与「确实没有」分开传到界面。
   */
  readError?: string
}

function snapshot(scope: MemoryScope): MemorySnapshot {
  const lim = memoryLimits(scope)
  const read = readMemories(scope)
  // 读不出来时**不**回落成空列表：那会让界面把「文件坏了」显示成「还没有记忆」。
  if (read.kind === 'unreadable')
    return {
      entries: [],
      used: 0,
      budget: lim.budget,
      maxEntries: lim.maxEntries,
      maxTitle: MEMORY_TITLE_MAX,
      maxBody: MEMORY_BODY_MAX,
      readError: read.error
    }
  const entries = read.entries
  return {
    entries,
    used: memoryUsage(entries),
    budget: lim.budget,
    maxEntries: lim.maxEntries,
    maxTitle: MEMORY_TITLE_MAX,
    maxBody: MEMORY_BODY_MAX
  }
}

export type MemoryIpcResult = { ok: true; snapshot: MemorySnapshot } | { ok: false; code: MemoryErrorCode }

/**
 * IPC 入参 → 作用域：省略（undefined / null）= 全局；非空字符串 = 该工作区的项目记忆；`{ personaId }` = 该角色的记忆。
 * 其余一律抛错让 invoke reject——若静默回落全局，渲染层传坏参数时「清空项目记忆」就会变成清空全局记忆。
 */
function ipcScope(arg: unknown): MemoryScope {
  if (arg === undefined || arg === null) return GLOBAL_SCOPE
  if (typeof arg === 'string' && arg.trim()) {
    /*
     * M15：传进来的可能是 worktree 路径，必须解析成**项目记忆根**再算作用域，
     * 否则面板在 worktree 会话里编辑的是另一份空记忆——用户在主仓库记的东西在这里看不见，
     * 而界面完全不提示（静默分裂）。解析只用 `projectMemoryRootOf`（同步查内存表，不读盘）。
     */
    const trimmed = arg.trim()
    return { kind: 'project', root: projectMemoryRootOf(trimmed) ?? trimmed }
  }
  const personaId = (arg as { personaId?: unknown } | null)?.personaId
  if (typeof personaId === 'string' && isSafeId(personaId)) return { kind: 'role', personaId }
  throw new Error('memory: invalid scope')
}

function ipcInput(raw: unknown): MemoryInput {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    ...(isMemoryType(o.type) ? { type: o.type } : {}),
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    ...(typeof o.body === 'string' ? { body: o.body } : {})
  }
}

/**
 * 面板用：查看 / 修改 / 删除 / 清空。每次都回带最新快照，渲染层直接替换列表。
 * 末位参数 scope：省略 = 全局（个人资料面板）；字符串 = 该工作区的项目记忆；`{ personaId }` = 角色记忆。
 */
export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', (_e, scope?: unknown): MemorySnapshot => snapshot(ipcScope(scope)))
  ipcMain.handle('memory:write', (_e, input: unknown, id?: string, scopeArg?: unknown): MemoryIpcResult => {
    const scope = ipcScope(scopeArg)
    const target = typeof id === 'string' && id ? id : undefined
    const r = writeMemory(ipcInput(input), target, scope)
    if (!r.ok) return { ok: false, code: r.code }
    // 手动新增撞上已有条目：writeMemory 对模型按幂等成功处理，面板则要明确告诉用户「没有新增」。
    if (!target && !r.created) return { ok: false, code: 'duplicate' }
    return { ok: true, snapshot: snapshot(scope) }
  })
  ipcMain.handle('memory:delete', (_e, id: string, scopeArg?: unknown): MemoryIpcResult => {
    const scope = ipcScope(scopeArg)
    deleteMemory(String(id ?? ''), scope)
    return { ok: true, snapshot: snapshot(scope) }
  })
  ipcMain.handle('memory:clear', (_e, scopeArg?: unknown): MemoryIpcResult => {
    const scope = ipcScope(scopeArg)
    clearMemories(scope)
    return { ok: true, snapshot: snapshot(scope) }
  })
}