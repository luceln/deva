import { mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { streamChat } from '../providers'
import { writeFileAtomic } from './atomic-write'
import type { CompactModelConfig } from './compaction'
import {
  formatMemoryLine,
  listMemories,
  memoryLimits,
  memoryPath,
  memoryUsage,
  newMemoryId,
  normalizeMemory,
  readMemories,
  replaceMemories,
  scopeLabel,
  writeMemory,
  type MemoryEntry,
  type MemoryScope,
  type MemoryWriteResult
} from './memory'

/**
 * 记忆写满后的自动归纳（issue #61：原先写满只会拒写，旧条目永远不会消失）。
 *
 * 模型经 memory_write 写入、撞上条数或总字数上限时，不再直接拒写：先用当前对话的模型把已有条目归纳一遍
 *（规则借鉴 Claude Code 后台整理记忆的做法：同主题合并、新的取代矛盾的旧的、删过时与一次性的、相对日期换成
 * 具体日期），压到上限的七成左右，再照常写入新条目。新条目原文由 writeMemory 保存，不经模型改写。
 *
 * 安全：归纳前把当时的全部条目备份到记忆文件同目录的 memory-backups/（保留最近 5 份）；模型输出解析不了、
 * 有条目超长、或归纳后仍放不下新条目，一律放弃归纳、退回原来的拒写，记忆文件不动。
 * 用户在面板里手动添加不走这里（仍直接拒写，由用户自己删改）。
 */

/** 归纳后的目标用量：上限的七成，留出余量，免得之后每写一条都要再归纳一次。 */
const TARGET_RATIO = 0.7
/** 验收线：写入新条目后条数与字数都须低于上限的九成，否则视为没归纳到位（重试，仍不行就按原样拒写）。 */
const ACCEPT_RATIO = 0.9
const TIMEOUT_MS = 90_000
const MAX_TOKENS = 8192
const ATTEMPTS = 2
const KEEP_BACKUPS = 5

export interface ConsolidateStats {
  before: { count: number; used: number }
  after: { count: number; used: number }
  backup: string
  /**
   * 因「等待期间记忆被改动」而整轮没提交时，被改动 / 删除 / 新增的条目。
   *
   * 与 `ok:false` 的 `reason` 一起回传：用户要知道是哪几条变了，否则「没提交」看起来像系统抽风。
   */
  skipped: SkippedEntry[]
}

/** 归纳结果里被**主动跳过**的条目：归纳在等模型返回的那段时间里，用户（或别的会话）动了这条记忆。 */
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

/**
 * 归纳被拒绝提交的原因码（与「模型跑失败」「写盘失败」分开）。
 *
 * 为什么必须是显式的：用户点「一键整理」时看到「已整理」却什么都没变，与看到「期间你改过记忆，
 * 这一轮没提交」是完全不同的两件事——后者他知道该怎么办（再点一次）。
 */
export type ConsolidateRejectCode =
  /** 等待模型期间，已有条目被改 / 被删，或出现了新条目：整轮拒绝（见 `detectConcurrentChange`）。 */
  | 'concurrent-change'
  /** 最终集合超限（条数 / 总预算含 incoming 预留 / 单条长度），不能提交。 */
  | 'over-limit'

/**
 * 归纳期间的并发改动。
 *
 * 判据是「已有 id 被改 / 被删，或出现了 before 里没有的新 id」——**整轮拒绝**，不做局部保全。
 *
 * 为什么不像上游那样逐条跳过：跳过意味着「这一轮归纳仍然写回，只是某几条按用户版本保留」。
 * 那要求调用方（`replaceMemories`）写出的集合恰好等于「模型结果 ∪ 用户改动」，而任何一处漏算
 * 都会静默丢条目（实测：用户改 A、模型把 A+B 合并到 A，候选保留用户 A 却删了 B，ok:true）。
 * 归纳本身是可重试的操作，整轮拒绝后重跑一次就得到「基于用户最新内容」的结果，语义上更干净。
 *
 * 返回值只用于报告（界面要说清是哪几条变了），不参与写入决策。
 */
function detectConcurrentChange(before: MemoryEntry[], current: MemoryEntry[]): { changed: SkippedEntry[]; added: string[] } {
  const was = new Map(before.map((e) => [e.id, e]))
  const now = new Map(current.map((e) => [e.id, e]))
  const changed: SkippedEntry[] = []
  for (const old of before) {
    const cur = now.get(old.id)
    if (!cur) changed.push({ id: old.id, reason: 'deleted', content: null, current: null })
    else if (cur.content !== old.content)
      changed.push({ id: old.id, reason: 'modified', content: null, current: cur.content })
  }
  const added = current.filter((e) => !was.has(e.id)).map((e) => e.id)
  return { changed, added }
}

/** 最终集合能否提交：条数、总预算（含 incoming 预留）、单条长度。不通过就不写盘。 */
function finalSetFits(
  scope: MemoryScope,
  entries: MemoryEntry[],
  incoming: string
): { ok: true } | { ok: false; reason: string } {
  const lim = memoryLimits(scope)
  if (entries.length > lim.maxEntries)
    return { ok: false, reason: `归纳后仍有 ${entries.length} 条，超过上限 ${lim.maxEntries} 条` }
  const tooLong = entries.find((e) => e.content.length > lim.maxChars)
  if (tooLong) return { ok: false, reason: `归纳后有条目超过 ${lim.maxChars} 字（${tooLong.id}）` }
  // incoming 若还要写进去，得给它留出位置：否则「归纳成功」之后紧跟的写入必然再撞一次上限。
  const room = incoming
    ? formatMemoryLine({ id: 'x_00000000', content: incoming, createdAt: 0, updatedAt: 0 }).length
    : 0
  const used = memoryUsage(entries) + room
  if (used > lim.budget)
    return { ok: false, reason: `归纳后仍有 ${used} 字${incoming ? '（已含将写入的新条目）' : ''}，超过预算 ${lim.budget} 字` }
  return { ok: true }
}


type ConsolidateResult =
  | ({ ok: true } & ConsolidateStats)
  | { ok: false; code?: ConsolidateRejectCode; reason: string; changed?: string[] }

/**
 * 一次「纯压缩」的结果——不带任何新增内容，只把现有条目精简。
 *
 * 与 `ConsolidateStats` 的区别：这个模式的用户目标是「腾出空间」，所以必须明确告知
 * **到底腾出没有**，以及**动了几条**。只说「成功」是不够的——模型完全可能原样返回、
 * 什么都没改，用户以为压过了，下次写入照样撞上限。
 */
export interface CondenseStats {
  before: { count: number; used: number }
  after: { count: number; used: number }
  /** 字数减少了多少（负数表示反而变多，通常说明模型没按要求压）。 */
  freed: number
  /**
   * 真的被改动 / 删除的旧条目数。
   *
   * 用来区分「压了」和「模型原样返回」：`freed > 0` 但 `changed === 0` 说明只是文字被微调，
   * 条数没减；`changed === 0 && freed <= 0` 就是**什么都没做**，界面应该如实说「没腾出空间」。
   */
  changed: number
  /** 是否真的腾出了空间（`freed > 0`）。 */
  freedSpace: boolean
  backup: string
  /** 见 `ConsolidateStats.skipped`：整轮未提交时被改动 / 删除的条目。 */
  skipped: SkippedEntry[]
}

/** 纯压缩可能失败的原因（界面按这个分流文案）。 */
export type CondenseFailCode =
  /** 该作用域一条记忆都没有，没有可压的。 */
  | 'empty'
  /** 模型不可用：provider / model 不存在、被停用，或密钥读不出来。`detail` 说明是哪一种。 */
  | 'model-unavailable'
  /** 模型跑失败（网络 / 超时 / 返回不可解析 / 写盘失败）。 */
  | 'failed'
  /** 调用方主动中止。 */
  | 'aborted'
  /** 等待模型期间记忆被改 / 删 / 新增：整轮拒绝，未写盘。 */
  | 'concurrent-change'
  /** 归纳后的集合仍超限（条数 / 预算 / 单条长度）：不提交。 */
  | 'over-limit'
  /**
   * 记忆文件**读不出来**（损坏 / 被占用 / 无权限）。
   *
   * 与 `empty` 必须分开（P2-14）：`empty` 是「确实没有条目」，读失败时用户要做的事完全不同
   * （去检查 / 修复那个文件，而不是「没什么可整理」）。
   */
  | 'readFailed'

export type CondenseResult =
  | ({ ok: true } & CondenseStats)
  | {
      ok: false
      code: CondenseFailCode
      reason: string
      /** 只有 `concurrent-change` 带：被改动 / 删除 / 新增的条目 id。 */
      changed?: string[]
    }

/**
 * 同一份记忆文件同时只跑一次整理：并发撞满的写入共用这一次的结果，之后各自重写。
 *
 * 值是**两种结果类型的联合**：撞上限的写入走 `ConsolidateResult`，用户主动点的纯压缩走 `CondenseResult`。
 * 谁在等就按谁的口径去读（纯压缩那边拿到别人的结果会重新读盘自己判，见 `condense`）。
 */
const inflight = new Map<string, Promise<ConsolidateResult | CondenseResult>>()

/**
 * 写入一条记忆；撞上限时先归纳再写（model 为空 = 不能调模型，按原样拒写）。
 * consolidated：发生过归纳（不论之后写没写成）；failure：归纳没成功的原因。
 *
 * ## 重试为什么要跟「第一次写入前的旧版本」比
 *
 * 归纳期间条目可能被用户改 / 删 / 合并。原实现是「归纳后 id 还在就按 id 更新」，判据只是 id 存在——
 * 于是
 *  - 用户把 A 改成了新内容，归纳结果重试仍按 A 的 id 写入 → **用户改动被覆盖**；
 *  - A 被删掉、模型合并出一个同 id 的新条目 → 按 id 写回 = **把已删除的条目复活**。
 *
 * 现在的判据是「该 id 的内容仍等于第一次写入前的那份」。不等就不写，且**绝不退化成新增**
 * （退化成新增会在记忆里留下一条用户从没见过的条目，还占预算）。无 id 的写入不受影响：
 * 逐字相同即幂等成功，那是既有行为。
 */
export async function writeMemoryWithConsolidation(
  content: string,
  id: string | undefined,
  scope: MemoryScope,
  model: CompactModelConfig | undefined,
  signal?: AbortSignal
): Promise<{ result: MemoryWriteResult; consolidated?: ConsolidateStats; failure?: string }> {
  const first = writeMemory(content, id, scope)
  if (first.ok || (first.code !== 'full' && first.code !== 'budget') || !model) return { result: first }
  /*
   * 归纳前记下「要更新的那条当时是什么样」。`first` 只可能是 full / budget，说明 id 对应的条目**存在**
   * （不存在会走 notFound 提前返回），所以这里能读到一份确定的旧版本。
   */
  const idBefore = id ? listMemories(scope).find((e) => e.id === id) : undefined
  const c = await consolidate(scope, content, id, model, signal)
  if (!c.ok) return { result: first, failure: c.reason }
  if (id) {
    const now = listMemories(scope).find((e) => e.id === id)
    if (!idBefore || !now) {
      // 归纳期间被删 / 被合并掉：按 id 写回等于复活，退化成新增等于凭空造一条。两种都不做。
      return {
        result: {
          ok: false,
          code: 'memory-changed',
          error: `${scopeLabel(scope)}中 id 为 ${id} 的记忆在归纳期间被删除或合并，本次没有写入（可用 memory_read 查看当前记忆后重试）`
        },
        consolidated: c
      }
    }
    if (now.content !== idBefore.content) {
      // 归纳期间被用户改过：他的新内容优先，本次写入作废（不覆盖、也不另存一条）。
      return {
        result: {
          ok: false,
          code: 'memory-changed',
          error: `${scopeLabel(scope)}中 id 为 ${id} 的记忆在归纳期间被改动，本次没有写入以免覆盖你的修改（可重试一次）`
        },
        consolidated: c
      }
    }
  }
  return { result: writeMemory(content, id, scope), consolidated: c }
}

/**
 * **纯压缩**：不新增任何内容，只把现有条目精简一遍腾出空间。
 *
 * 与 `writeMemoryWithConsolidation` 那条路的区别：
 *  - 那条是「写新条目撞上限 → 顺手整理 → 再写新的」，**必须**有 incoming，prompt 里会带上
 *    「即将写入的新记忆」，规则第 3 条是「和新记忆重复的旧条目直接删」。拿它来做纯压缩会出问题——
 *    没有新记忆却让模型「给新记忆腾空间」，它会倾向于多删。
 *  - 这条是用户主动点按钮（导入报告里「一键整理」）。场景是「已经超限了，先把它压下去」，
 *    因此 prompt 只说「精简」，不提「给谁腾空间」，也不引入任何新内容。
 *
 * ⚠️ **破坏性**：会改 / 删用户的记忆条目。所以：
 *  - 归纳前照旧备份到 `memory-backups/`（保留最近 5 份），
 *  - 返回值必须说清压缩前后字数、动了几条、有没有真的腾出空间——不能只说「成功」。
 */
export async function condenseMemories(
  scope: MemoryScope,
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<CondenseResult> {
  const read = readMemories(scope)
  if (read.kind === 'unreadable')
    return { ok: false, code: 'readFailed', reason: `${scopeLabel(scope)}文件读不出来（${read.error}），请先检查该文件` }
  const before = read.entries
  if (before.length === 0) return { ok: false, code: 'empty', reason: '没有可整理的条目' }
  return condense(scope, before, model, signal)
}

/** 与 `consolidate` 同一套「同文件同时只跑一次」的保护。 */
function condense(
  scope: MemoryScope,
  before: MemoryEntry[],
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<CondenseResult> {
  const key = memoryPath(scope)
  const running = inflight.get(key)
  /*
   * 已有归纳在跑（可能来自一次撞上限的写入）→ 等它，然后**按它的结果重新读一遍**再判断。
   *
   * 不能直接把它的 `ConsolidateResult` 当成本次结果返回：那条是「为写入新内容而整理」，
   * 口径不同（它可能已经把新条目算进 after）。这里只借它的执行，结论自己算。
   */
  if (running) {
    return running.then(() => {
      const again = readMemories(scope)
      if (again.kind === 'unreadable')
        return {
          ok: false as const,
          code: 'readFailed' as const,
          reason: `${scopeLabel(scope)}文件读不出来（${again.error}），请先检查该文件`
        }
      if (again.entries.length === 0)
        return { ok: false as const, code: 'empty' as const, reason: '没有可整理的条目' }
      return runCondense(scope, again.entries, model, signal)
    })
  }
  const p = runCondense(scope, before, model, signal).finally(() => inflight.delete(key))
  inflight.set(key, p as unknown as Promise<ConsolidateResult>)
  return p
}

async function runCondense(
  scope: MemoryScope,
  before: MemoryEntry[],
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<CondenseResult> {
  const { system, user } = buildCondensePrompt(scope, before)
  let reason = ''
  let code: CondenseFailCode = 'failed'
  for (let i = 0; i < ATTEMPTS; i++) {
    if (signal?.aborted) return { ok: false, code: 'aborted', reason: '已中止' }
    let text: string
    try {
      text = await ask(model, system, user, signal)
    } catch (e) {
      reason = (e as Error)?.message ?? String(e)
      continue
    }
    const parsed = parseEntries(text, scope, before, '')
    if (!parsed.ok) {
      /*
       * 「归纳后仍接近上限」不是模型跑歪了，而是它给出的集合本身就放不下——重试大概率得到同样结果，
       * 每轮还要多花一次调用。按 `over-limit` 直接返回，与并发冲突分开。
       */
      if (/仍接近上限/.test(parsed.reason))
        return { ok: false, code: 'over-limit', reason: parsed.reason }
      reason = parsed.reason
      continue
    }
    /*
     * 并进「跑的过程中又被写进来的条目」，与 consolidate 同口径：
     * 归纳期间别的写入不能被我这次 replaceMemories 抹掉；期间被改 / 被删的条目按当前状态跳过。
     */
    const cur = readMemories(scope)
    if (cur.kind === 'unreadable') {
      // 读不出来就不知道现在有哪些条目，此时覆盖写等于拿归纳结果抹掉盘上原有内容。
      return { ok: false, code: 'failed', reason: `记忆文件读不出来（${cur.error}），为避免覆盖原有内容，本次没有写回` }
    }
    // 等待模型期间有人动过记忆 → 整轮拒绝（见 detectConcurrentChange 的说明）。
    const drift = detectConcurrentChange(before, cur.entries)
    if (drift.changed.length || drift.added.length)
      return {
        ok: false,
        code: 'concurrent-change',
        reason: `整理期间记忆被改动或新增（${[...drift.changed.map((c) => `${c.id}:${c.reason}`), ...drift.added.map((id) => `${id}:added`)].join('、')}），这一轮结果没有提交，请再整理一次`,
        changed: [...drift.changed.map((c) => c.id), ...drift.added]
      }
    /*
     * 超限不重试：模型再跑一次也可能给出同样的集合，而且每轮都要付一次调用。
     * 直接返回可区分的原因，让用户自己决定（删几条再整理）。
     */
    const fits = finalSetFits(scope, parsed.entries, '')
    if (!fits.ok) return { ok: false, code: 'over-limit', reason: fits.reason }
    const backup = backupMemories(scope, cur.entries)
    if (!replaceMemories(scope, parsed.entries)) {
      return { ok: false, code: 'failed', reason: '整理结果写入失败（磁盘不可写或空间不足）' }
    }
    const usedBefore = memoryUsage(before)
    const usedAfter = memoryUsage(parsed.entries)
    return {
      ok: true,
      before: { count: before.length, used: usedBefore },
      after: { count: parsed.entries.length, used: usedAfter },
      freed: usedBefore - usedAfter,
      changed: countChanged(before, parsed.entries, []),
      freedSpace: usedAfter < usedBefore,
      backup,
      skipped: []
    }
  }
  return { ok: false, code, reason: reason || '整理没有产出可用结果' }
}

/**
 * 有多少条旧条目被改动或删除。
 *
 * 判据是「同 id 的内容变了，或这个 id 在结果里没了」。合并会产生新 id（模型填 null 的条目），
 * 那种情况在 `before` 里找不到对应，按「原条目消失」计——反正对用户来说它就是被改写掉了。
 *
 * `skipped` 里的条目不算：那些是**用户**在归纳等待期间改 / 删的，不是这次归纳的功劳。
 * 算进去的话，`changed === 0 && freed <= 0` 这个「什么都没做」的判据会被用户的并发操作污染。
 */
function countChanged(before: MemoryEntry[], after: MemoryEntry[], skipped: SkippedEntry[] = []): number {
  const now = new Map(after.map((e) => [e.id, e.content]))
  const mine = new Set(skipped.map((s) => s.id))
  let n = 0
  for (const e of before) {
    if (mine.has(e.id)) continue
    if (!now.has(e.id) || now.get(e.id) !== e.content) n++
  }
  return n
}

function consolidate(
  scope: MemoryScope,
  incoming: string,
  replacing: string | undefined,
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<ConsolidateResult> {
  const key = memoryPath(scope)
  const running = inflight.get(key)
  if (running) {
    /*
     * 有人在跑（可能是用户点的纯压缩）。不能直接把它的结果当我的：那是 `CondenseResult` 口径
     * （没算即将写入的新条目）。等它跑完，按它的结果**重新读盘**再走一遍自己的整理——
     * 这样「撞上限的写入」与「手动压缩」同时发生时，两次整理串行、互不覆盖对方的结果。
     */
    return running.then(() => run(scope, incoming, replacing, model, signal))
  }
  const p = run(scope, incoming, replacing, model, signal).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function run(
  scope: MemoryScope,
  incoming: string,
  replacing: string | undefined,
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<ConsolidateResult> {
  const read = readMemories(scope)
  if (read.kind === 'unreadable')
    return { ok: false, reason: `${scopeLabel(scope)}文件读不出来（${read.error}），为避免覆盖原有内容，本次没有归纳` }
  const before = read.entries
  if (before.length === 0) return { ok: false, reason: '没有可归纳的条目' }
  const { system, user } = buildPrompt(scope, before, normalizeMemory(incoming), replacing)
  let reason = ''
  for (let i = 0; i < ATTEMPTS; i++) {
    if (signal?.aborted) return { ok: false, reason: '已中止' }
    let text: string
    try {
      text = await ask(model, system, user, signal)
    } catch (e) {
      reason = (e as Error)?.message ?? String(e)
      continue
    }
    const parsed = parseEntries(text, scope, before, normalizeMemory(incoming))
    if (!parsed.ok) {
      if (/仍接近上限/.test(parsed.reason)) return { ok: false, code: 'over-limit', reason: parsed.reason }
      reason = parsed.reason
      continue
    }
    /*
     * 写回前重新读一次当前状态，逐条校验（见 detectConcurrentChange）：
     * 归纳期间被用户改过 / 删掉的条目不拿归纳结果顶掉，也不复活。
     */
    const cur = readMemories(scope)
    if (cur.kind === 'unreadable') {
      // 读不出来就不知道现在有哪些条目，此时覆盖写等于拿归纳结果抹掉盘上原有内容。
      return { ok: false, reason: `记忆文件读不出来（${cur.error}），为避免覆盖原有内容，本次没有写回` }
    }
    // 等待模型期间有人动过记忆 → 整轮拒绝（见 detectConcurrentChange 的说明）。
    const drift = detectConcurrentChange(before, cur.entries)
    if (drift.changed.length || drift.added.length)
      return {
        ok: false,
        reason: `归纳期间记忆被改动或新增（${[...drift.changed.map((c) => `${c.id}:${c.reason}`), ...drift.added.map((id) => `${id}:added`)].join('、')}），这一轮结果没有提交，请再试一次`,
        changed: [...drift.changed.map((c) => c.id), ...drift.added]
      }
    const fits = finalSetFits(scope, parsed.entries, normalizeMemory(incoming))
    if (!fits.ok) return { ok: false, reason: fits.reason }
    const backup = backupMemories(scope, cur.entries)
    // 写盘成败必须回传：返回 ok:true 而实际没落盘，用户看到的是「旧条目删了、新条目也没进来」，
    // 下一次归纳还会基于同一份满记忆再跑一遍。与 memory.ts 的 saveMemories 同一口径。
    if (!replaceMemories(scope, parsed.entries)) {
      return { ok: false, reason: '归纳结果写入失败（磁盘不可写或空间不足）' }
    }
    return {
      ok: true,
      before: { count: before.length, used: memoryUsage(before) },
      after: { count: parsed.entries.length, used: memoryUsage(parsed.entries) },
      backup,
      skipped: []
    }
  }
  return { ok: false, reason: reason || '归纳没有产出可用结果' }
}

/**
 * 纯压缩的提示词。
 *
 * 与 `buildPrompt` 的**关键区别**：不提「即将写入的新记忆」，规则里也没有「和新记忆重复的删掉」。
 * 拿带 incoming 的那份来做纯压缩，模型会以为要给某条新内容腾位置而多删——这正是用户点这个按钮时
 * 最不希望发生的事（他只想在保住信息的前提下精简）。
 *
 * 目标档位与自动归纳一致（上限的七成）：同一个作用域、同一套上限，没有理由两套标准。
 */
function buildCondensePrompt(scope: MemoryScope, entries: MemoryEntry[]): { system: string; user: string } {
  const lim = memoryLimits(scope)
  const targetChars = Math.floor(lim.budget * TARGET_RATIO)
  const targetCount = Math.floor(lim.maxEntries * TARGET_RATIO)
  const system = [
    `你负责整理用户的长期${scopeLabel(scope)}。它已经写满（条数或总字数超限），需要在不丢失有用信息的前提下精简，腾出后续写入的空间。`,
    '',
    '规则：',
    `1. 同一主题的多条合并成一条。每条一句话，不超过 ${lim.maxChars} 字。`,
    '2. 前后矛盾的以更新日期较新的为准，删掉被取代的旧条目。',
    '3. 删除一次性的任务细节、已经结束的进行中事项和明显过时的内容。',
    '4. 用户纠正过的做法（「做法 + 原因」）和明确表达过的偏好优先保留，其中的原因不要删。',
    '5. **不要为了压缩而删掉仍然有用的信息**。这次没有任何新内容要写进来，你的唯一目标是让同样的信息占更少空间。',
    '6. 只能合并、精简、删除，不得编造原文没有的信息。「昨天」「上周」这类相对时间，按该条的更新日期换成具体日期。',
    '7. 保持原条目的语言。',
    `8. 结果总长不超过 ${targetChars} 字、不超过 ${targetCount} 条（每条按「- [id] 内容」一行计）。`,
    '',
    '只输出 JSON，不要任何其他文字：',
    '{"entries":[{"id":"原条目 id 或 null","content":"…"}]}',
    '保留或由旧条目改写、合并而来的条目，id 填它所来自的旧条目 id（合并时填其中更新日期最早的那条）；无法对应到旧条目的填 null。'
  ].join('\n')
  const day = (t: number): string => (t > 0 ? new Date(t).toISOString().slice(0, 10) : '日期不详')
  const user = [
    `当前${scopeLabel(scope)}（${entries.length} 条，${memoryUsage(entries)} 字，上限 ${lim.budget} 字 / ${lim.maxEntries} 条）：`,
    ...entries.map((e) => `- [${e.id}]（更新于 ${day(e.updatedAt)}）${e.content}`)
  ].join('\n')
  return { system, user }
}

function buildPrompt(
  scope: MemoryScope,
  entries: MemoryEntry[],
  incoming: string,
  replacing: string | undefined
): { system: string; user: string } {
  const lim = memoryLimits(scope)
  const targetChars = Math.floor(lim.budget * TARGET_RATIO)
  const targetCount = Math.floor(lim.maxEntries * TARGET_RATIO)
  const system = [
    '你负责整理用户的长期记忆。记忆已经写满，请在不丢失有用信息的前提下把它归纳精简，给即将写入的新记忆腾出空间。',
    '',
    '规则：',
    `1. 同一主题的多条合并成一条。每条一句话，不超过 ${lim.maxChars} 字。`,
    '2. 前后矛盾的以更新日期较新的为准，删掉被取代的旧条目。',
    '3. 与「即将写入的新记忆」重复、或被它取代的旧条目直接删除。新记忆会另行原样保存，不要把它写进结果。',
    '4. 删除一次性的任务细节、已经结束的进行中事项和明显过时的内容。',
    '5. 用户纠正过的做法（「做法 + 原因」）和明确表达过的偏好优先保留，其中的原因不要删。',
    '6. 只能合并、精简、删除，不得编造原文没有的信息。「昨天」「上周」这类相对时间，按该条的更新日期换成具体日期。',
    '7. 保持原条目的语言。',
    `8. 结果总长不超过 ${targetChars} 字、不超过 ${targetCount} 条（每条按「- [id] 内容」一行计）。`,
    '',
    '只输出 JSON，不要任何其他文字：',
    '{"entries":[{"id":"原条目 id 或 null","content":"…"}]}',
    '保留或由旧条目改写、合并而来的条目，id 填它所来自的旧条目 id（合并时填其中更新日期最早的那条）；无法对应到旧条目的填 null。'
  ].join('\n')
  const day = (t: number): string => (t > 0 ? new Date(t).toISOString().slice(0, 10) : '日期不详')
  const user = [
    `当前${scopeLabel(scope)}（${entries.length} 条，${memoryUsage(entries)} 字）：`,
    ...entries.map((e) => `- [${e.id}]（更新于 ${day(e.updatedAt)}）${e.content}`),
    '',
    replacing ? `即将写入的新记忆（将改写 [${replacing}] 的原内容）：` : '即将写入的新记忆：',
    incoming
  ].join('\n')
  return { system, user }
}

async function ask(model: CompactModelConfig, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let text = ''
  let error = ''
  let broken = false
  try {
    for await (const ev of streamChat(
      { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
      {
        model: model.model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: MAX_TOKENS,
        signal: ctrl.signal
      }
    )) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'error') error = ev.error.message
      else if (ev.type === 'done' && ev.stopReason !== 'end_turn' && ev.stopReason !== 'stop') broken = true
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (error) throw new Error(error)
  if (ctrl.signal.aborted) throw new Error(signal?.aborted ? '已中止' : '归纳请求超时')
  if (broken) throw new Error('归纳输出不完整')
  return text
}

/** 解析并校验模型给出的条目；不合格（解析不了、有条目超长、写入新条目后仍接近上限）一律不用。 */
function parseEntries(
  text: string,
  scope: MemoryScope,
  before: MemoryEntry[],
  incoming: string
): { ok: true; entries: MemoryEntry[] } | { ok: false; reason: string } {
  const lim = memoryLimits(scope)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let raw: unknown
  try {
    raw = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null
  } catch {
    raw = null
  }
  const list = (raw as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) return { ok: false, reason: '归纳结果不是有效的 JSON' }

  const byId = new Map(before.map((e) => [e.id, e]))
  const used = new Set<string>()
  const out: MemoryEntry[] = []
  const now = Date.now()
  for (const item of list) {
    const content = normalizeMemory(typeof item?.content === 'string' ? item.content : '')
    if (!content || content === incoming) continue
    if (content.length > lim.maxChars) return { ok: false, reason: `归纳后有条目超过 ${lim.maxChars} 字` }
    if (out.some((e) => e.content === content)) continue
    const old = typeof item?.id === 'string' && !used.has(item.id) ? byId.get(item.id) : undefined
    if (old) {
      used.add(old.id)
      out.push(old.content === content ? old : { ...old, content, updatedAt: now })
    } else {
      out.push({ id: newMemoryId(scope, [...before, ...out]), content, createdAt: now, updatedAt: now })
    }
  }
  // 写入新条目后仍须低于上限的九成：只删一两条就交差，下一次写入马上又要归纳，白花调用。
  const room = formatMemoryLine({ id: 'x_00000000', content: incoming, createdAt: 0, updatedAt: 0 }).length
  if (out.length + 1 > lim.maxEntries * ACCEPT_RATIO || memoryUsage(out) + room > lim.budget * ACCEPT_RATIO)
    return { ok: false, reason: '归纳后仍接近上限' }
  return { ok: true, entries: out }
}

/** 归纳前的全部条目存一份到记忆文件同目录的 memory-backups/，只留最近几份；返回备份路径。 */
function backupMemories(scope: MemoryScope, entries: MemoryEntry[]): string {
  const dir = join(dirname(memoryPath(scope)), 'memory-backups')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const body = scope.kind === 'project' ? { version: 1, root: scope.root, entries } : { version: 1, entries }
  writeFileAtomic(file, JSON.stringify(body, null, 2))
  const all = readdirSync(dir)
    .filter((f) => /^memory-.+\.json$/.test(f))
    .sort()
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(dir, f), { force: true })
  return file
}
