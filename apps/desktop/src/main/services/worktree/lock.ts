import { normalizeWorktreePath } from './paths'
import { publishWorktreeProgress } from '../chat-bus'

/**
 * 按工作目录粒度串行化 git 写操作（spec §5）。
 *
 * ## 边界（**必读，这不是强隔离**，spec §5.3 要求写进代码）
 *
 * **本锁只约束 Deva 自己发起的 git 操作。用户在外部终端手跑的 `git merge` 完全不受它约束。**
 *
 * - Deva 侧：本模块把这些写入串行化，同一进程内不会互相踩（这才是它的全部承诺）。
 * - 用户侧：终端里 `git commit` 与 Deva 的合并并发时，由 **git 自己的 `.git/index.lock`** 兜底，
 *   一方会拿到 `fatal: Unable to create '.../index.lock': File exists`。这条错误**原样透出**给用户，
 *   这里**不做重试、不做自动清理**——静默删掉别人的 `index.lock` 是数据损坏级操作。
 * - 界面上的「另一个会话正在提交」提示只覆盖 **Deva 会话之间**。跨到用户终端时只能给 git 的原始报错。
 * - **不跨进程**：锁是进程内的 `Map` 闭包变量，不落盘。将来若开多窗口 / 多实例，本锁失效，
 *   那时需要 `--git-common-dir` 下的租约文件做跨进程锁。**本次不做**，但这段前提必须留着，
 *   否则后来人会把它当成全局互斥。
 *
 * ## 为什么按路径分锁而不是一把全局大锁
 *
 * 两个互不相关的工作区同时 commit 不该互相排队——那会让「开三个会话并行干活」反而不如单会话顺。
 * 所以按 `compareKey` 分桶，只有真正碰同一份 `.git` 的操作才排队。
 * 而**写 `.git/` 共享区**的操作（创建 / 删除 / 合并 / 重建 / 清理登记）同时持 `repoRoot` 那把锁（§5.2）。
 */

/** 等锁超过这个时长就发一条进度事件，让界面别看起来像冻住了（§5.1 第 7 条 / B6）。 */
const WAIT_NOTICE_MS = 5000

/** 每个 compareKey 的队尾：新调用挂到它之后，前一个完成才轮到自己。 */
const tail = new Map<string, Promise<void>>()

/** 当前持锁者（供 UI 显示「另一个会话正在提交」）。 */
const holder = new Map<string, { label: string; since: number }>()

/**
 * 按工作目录粒度串行化 git 写操作。
 *
 * `paths` 会被归一化、去重、**按码点升序排序**后依次获取；全部拿到才执行 `fn`；无论成功失败都释放。
 *
 * ⚠️ **禁止嵌套调用**：内层会永远拿不到同一把锁 → 死锁。需要多把锁时**一次传全部路径**。
 * 代码审查按 `grep -n 'withGitLock' main/` 核调用点是否嵌套。
 *
 * ⚠️ **不得在持有锁期间 await 用户交互**（不弹对话框、不等 IPC 回包）。锁内只做 git 调用——
 * 否则一次「等用户点确认」会把整个仓库的写操作卡住。
 */
export async function withGitLock<T>(paths: string[], label: string, fn: () => Promise<T>): Promise<T> {
  const keys = lockKeysOf(paths)
  const releases: Array<() => void> = []
  try {
    // 按序获取（顺序已排序，避免两个调用方以不同顺序拿锁而互相等成死锁）
    for (const key of keys) releases.push(await acquire(key))
    // 全部拿到后登记占用者：中途失败不登记，免得 UI 显示一个没真正持锁的人
    const now = Date.now()
    for (const key of keys) holder.set(key, { label, since: now })
    return await fn()
  } finally {
    // 逆序释放（与获取相反），并清掉占用者
    for (const key of keys.reverse()) holder.delete(key)
    for (const release of releases.reverse()) release()
  }
}

/** 当前某路径上的占用者（供 UI 提示「另一个会话正在提交」）。 */
export function gitLockHolder(path: string): { label: string; since: number } | null {
  let key: string
  try {
    key = normalizeWorktreePath(path).compareKey
  } catch {
    return null
  }
  return holder.get(key) ?? null
}

/**
 * 归一化 → 去重 → **按码点升序排序**。
 *
 * 不用 `localeCompare`：locale 会影响比较结果，两个调用方可能得到不同顺序，
 * 于是 A 等 B 的锁、B 等 A 的锁——死锁。码点比较是确定的。
 */
function lockKeysOf(paths: string[]): string[] {
  const set = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    try {
      set.add(normalizeWorktreePath(p).compareKey)
    } catch {
      // 归一化不了的畸形路径跳过：锁的目的是串行化对同一目录的写入，
      // 没法判等的路径本来就不会命中任何人的锁。
    }
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 挂到队尾并等前一个完成；返回**释放函数**。
 *
 * 实现方式：每个 key 有一条 `tail` Promise 链。`prev` 是当前队尾，我把新队尾设为
 * 「我的 gate Promise」，并把自己接在 `prev` 之后——于是下一位拿到的是我的 gate，只有我释放（resolve 它）
 * 才会轮到它。链式结构保证严格串行，不依赖任何计时。
 */
function acquire(key: string): Promise<() => void> {
  const prev = tail.get(key) ?? Promise.resolve()

  let openGate!: () => void
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  tail.set(key, gate)

  const waited = Date.now()
  /*
   * 等超过 5 秒就发一条进度事件（不取消等待，只是让界面能说「正在等另一个会话的 git 操作完成」）。
   * 定时器在拿到锁后必须清掉，否则每次慢调用都会在之后多出一条迟到的通知。
   */
  const timer = setTimeout(() => {
    const current = holder.get(key)
    publishWorktreeProgress({
      phase: 'waiting-lock',
      holder: current ? { label: current.label, since: current.since } : null
    })
  }, WAIT_NOTICE_MS)

  return prev.then(() => {
    clearTimeout(timer)
    void waited
    return () => {
      // 队列已空（我还是队尾）时清掉这条，免得 Map 无限增长
      if (tail.get(key) === gate) tail.delete(key)
      openGate()
    }
  })
}