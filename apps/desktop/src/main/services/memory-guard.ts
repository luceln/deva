/**
 * 记忆写入的并发守卫。
 *
 * 为什么单独成文件：归纳（`memory-consolidate.ts`）在等模型的那几十秒里，用户完全可能去改动 / 删除 / 新增
 * 记忆。等模型回来时，`before` 那份快照已经过期——照它写回就会覆盖用户刚做的修改，或把已删的条目复活。
 * 这套「写回前重新读一次、与首次快照比对、不一致就整轮拒绝」的保护是 DevaPlus 独有的语义，上游没有对应实现，
 * 所以放在上游永远不会碰的文件里，`memory-consolidate.ts` 里只留调用。
 *
 * ## 三条不能退让的语义
 *
 * 1. **快照键是 `type + title + body` 三段**（见 {@link contentOf}）。只用 `id` 比存在性，会把「内容被改」
 *    当成没动；只比标题会漏掉「正文被改」，只比正文会漏掉「标题被改」。
 * 2. **读不出来 ≠ 没有条目**。`readMemories` 的三态里 `unreadable` 必须在写入前拦住：
 *    一次 EBUSY 就当成空集，随后覆盖写会把盘上全部记忆抹掉，而且不报错。
 * 3. **原始 id 重试要跟「首次读到的旧版本」比**，不一致就拒绝，**绝不退化成新增**——
 *    退化成新增会在记忆里留下一条用户从没见过的条目，还占预算。
 *
 * ## 为什么全是同步函数
 *
 * 守卫读盘与随后写盘之间**不能插入任何 await**：那会把「检查到写入」的窗口拉长，让本模块防的那个竞态
 * 重新出现。所以这里不提供异步版本，调用方也必须在拿到 ok 后立刻写。
 */
import {
  MEMORY_BODY_MAX,
  MEMORY_TITLE_MAX,
  formatMemoryLine,
  memoryLimits,
  memoryUsage,
  readMemories,
  type MemoryEntry,
  type MemoryScope
} from './memory'

/**
 * 因「等待期间记忆被改动」而整轮没提交时，被改动 / 删除 / 新增的条目。
 *
 * 与 `ok:false` 的 reason 一起回传：用户要知道是哪几条变了，否则「没提交」看起来像系统抽风。
 */
export interface SkippedEntry {
  id: string
  /**
   * `deleted`：等待期间这条被删了——不复活；
   * `modified`：等待期间内容被改过——保留用户版本，不拿归纳结果顶掉。
   */
  reason: 'deleted' | 'modified'
  /** 归纳结果原本想写成的样子（`null` 表示归纳结果里没有这条——原本要删掉它）。 */
  content: string | null
  /** 当前存储里的样子（`deleted` 时为 `null`）。 */
  current: string | null
}

/** 一条记忆的「内容快照」，用于并发改动比较（v2 结构：类型 + 标题 + 正文三段都要比）。 */
export function contentOf(e: MemoryEntry): string {
  return `${e.type}\u0000${e.title}\u0000${e.body}`
}

/** 两条记忆的内容是否完全一致（三段都比）。原始 id 重试的「没被改过」判据。 */
export function sameSnapshot(a: MemoryEntry, b: MemoryEntry): boolean {
  return a.type === b.type && a.title === b.title && a.body === b.body
}

export interface Drift {
  /** 被删除 / 被改动的既有条目。 */
  changed: SkippedEntry[]
  /** `before` 里没有的新条目 id。 */
  added: string[]
}

/**
 * 归纳期间的并发改动。
 *
 * 判据是「已有 id 被改 / 被删，或出现了 before 里没有的新 id」。返回值只用于报告
 * （界面要说清是哪几条变了），不参与写入决策——决策是「有改动就整轮拒绝」。
 *
 * 为什么不像上游那样逐条跳过：跳过意味着「这一轮归纳仍然写回，只是某几条按用户版本保留」。
 * 那要求调用方写出的集合恰好等于「模型结果 ∪ 用户改动」，而任何一处漏算都会静默丢条目
 *（实测：用户改 A、模型把 A+B 合并到 A，候选保留用户 A 却删了 B，ok:true）。
 * 归纳本身可重试，整轮拒绝后重跑一次就得到「基于用户最新内容」的结果，语义上更干净。
 */
export function detectConcurrentChange(before: MemoryEntry[], current: MemoryEntry[]): Drift {
  const was = new Map(before.map((e) => [e.id, e]))
  const now = new Map(current.map((e) => [e.id, e]))
  const changed: SkippedEntry[] = []
  for (const old of before) {
    const cur = now.get(old.id)
    if (!cur) changed.push({ id: old.id, reason: 'deleted', content: null, current: null })
    else if (contentOf(cur) !== contentOf(old))
      changed.push({ id: old.id, reason: 'modified', content: null, current: contentOf(cur) })
  }
  const added = current.filter((e) => !was.has(e.id)).map((e) => e.id)
  return { changed, added }
}

/** 把漂移摊成「报告文本 + 纯 id 列表」：两个归纳入口拼的是同一句话，避免各写一份。 */
export function driftDetail(drift: Drift): { text: string; ids: string[] } {
  const ids = [...drift.changed.map((c) => c.id), ...drift.added]
  const text = [...drift.changed.map((c) => `${c.id}:${c.reason}`), ...drift.added.map((id) => `${id}:added`)].join('、')
  return { text, ids }
}

/** {@link guardSnapshot} 的判定结果。**不带文案**：每个入口的措辞与原因码由它自己决定。 */
export type SnapshotVerdict =
  /** 快照一致，可以写回；`entries` 是刚刚重新读到的当前集合。 */
  | { ok: true; entries: MemoryEntry[] }
  /** 记忆文件读不出来：连盘上有什么都不知道，绝不能覆盖写。 */
  | { ok: false; kind: 'unreadable'; error: string }
  /** 等待期间被改 / 删 / 新增：整轮拒绝。 */
  | { ok: false; kind: 'drift'; drift: Drift }

/**
 * 写回前的守卫：重新读一次当前状态，与首次快照比对。
 *
 * 两个归纳入口（撞上限的写入、用户主动的纯压缩）都必须先过这一关；返回值 ok 时才允许写盘，
 * 且中间不能再 await（见文件头「为什么全是同步函数」）。
 */
export function guardSnapshot(scope: MemoryScope, before: MemoryEntry[]): SnapshotVerdict {
  const cur = readMemories(scope)
  if (cur.kind === 'unreadable') return { ok: false, kind: 'unreadable', error: cur.error }
  const drift = detectConcurrentChange(before, cur.entries)
  if (drift.changed.length || drift.added.length) return { ok: false, kind: 'drift', drift }
  return { ok: true, entries: cur.entries }
}

/**
 * 最终集合能否提交：条数、总预算（含 incoming 预留）、单条长度。不通过就不写盘。
 *
 * `incoming` 是「这一轮还要写进去的新条目标题」（纯压缩时为空）。预留给它是因为：不给它留位置，
 * 「归纳成功」之后紧跟的那次写入必然再撞一次上限，白花一轮模型调用。
 *
 * ⚠️ **预算算的是索引行（`id` / `type` / `title`），不含 `body`。** 这是上游 v2 沿用下来的口径
 *（`memoryUsage` → `formatMemoryLine`）：4000 字指的是「下发给模型的那份索引」的体积，不是正文总字数。
 * 别误按正文体积去估或去调阈值——那样调下来要么永远用不满、要么一写入就超，且看不出是口径问题。
 */
export function finalSetFits(
  scope: MemoryScope,
  entries: MemoryEntry[],
  incoming: string
): { ok: true } | { ok: false; reason: string } {
  const lim = memoryLimits(scope)
  if (entries.length > lim.maxEntries)
    return { ok: false, reason: `归纳后仍有 ${entries.length} 条，超过上限 ${lim.maxEntries} 条` }
  const tooLong = entries.find((e) => e.title.length > MEMORY_TITLE_MAX || e.body.length > MEMORY_BODY_MAX)
  if (tooLong)
    return {
      ok: false,
      reason: `归纳后有条目超过上限（${tooLong.id}：标题 ${tooLong.title.length}/${MEMORY_TITLE_MAX} 字、正文 ${tooLong.body.length}/${MEMORY_BODY_MAX} 字）`
    }
  const room = incoming ? formatMemoryLine({ id: 'x_00000000', type: 'user', title: incoming }).length : 0
  const used = memoryUsage(entries) + room
  if (used > lim.budget)
    return { ok: false, reason: `归纳后仍有 ${used} 字${incoming ? '（已含将写入的新条目）' : ''}，超过预算 ${lim.budget} 字` }
  return { ok: true }
}
