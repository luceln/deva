import { statSync, readdirSync, lstatSync } from 'fs'
import { join } from 'path'
import { runGitRaw } from '../git'
import { listRecords, type WorktreeRecord } from './store'
import { compareKeyOfPath, repoKeyOf, isInsideRoot } from './paths'
import { parseWorktreeList, type WorktreeEntry } from './git-worktree'
import { trustRoot } from '../fs-guard'
import { gitLockHolder } from './lock'
import { publishWorktreeSize } from '../chat-bus'

/**
 * `worktree:list` 的快照与 `state` 计算（spec §2.1）。
 *
 * ## 为什么 `state` 只在主进程算
 *
 * 渲染层若能自己从「目录在不在 + 分支名」推一遍，两套规则迟早就漂移，而漂移的表现是静默的：
 * 界面显示「可合并」，点下去必失败（C2）；或者界面显示「已缺失」而记录其实还好。
 * 所以这里算出确定值，界面只负责显示与按 `state` 决定哪些按钮可用。
 *
 * ## `state` 判定顺序不能改（§2.1 的短路表）
 *
 * 每条的顺序都有理由，尤其前两条：`prunable` 是 git 给出的**确定信号**，比我们自己判「目录不在」更强，
 * 两者同时成立时按更强的展示，用户才看得到「清理登记」这个出口。
 *
 * ## `unmanaged` 不参与任何操作
 *
 * `git worktree list` 里有、`worktrees.json` 里没有的路径（用户自己 `add` 的、或记录被删的）
 * 只进 `unmanaged` 只读展示：不自动纳管、不自动删。这样四种 `state` 的语义才保持干净。
 */

/*
 * 快照类型定义在 `shared/worktree-protocol.ts`：渲染层与主进程共用同一份。
 * 这里只 re-export，不另写一份——两份定义会漂移，而漂移的表现是静默的（界面读到一个不存在的字段）。
 */
export type {
  WorktreeState,
  WorktreeListItem,
  UnmanagedWorktree,
  WorktreeSnapshot,
  MergeGate,
  MergeBlocker
} from '../../../shared/worktree-protocol'
import type {
  WorktreeState,
  WorktreeListItem,
  UnmanagedWorktree,
  WorktreeSnapshot,
  MergeGate
} from '../../../shared/worktree-protocol'

/** 一次 `git worktree list` 的结果，按 repoRoot 复用（同仓库的多条记录只查一次）。 */
interface RepoGitState {
  /** 这个状态属于哪个主检出（判断「哪一条是主检出」要用它，不能用 repoKey——那是 sha1 摘要）。 */
  repoRoot: string
  entries: WorktreeEntry[]
  /** 解析出的 prunable 路径集合（`git worktree list --porcelain` 的 `prunable` 行）。 */
  prunableKeys: Set<string>
}

/** 解析 porcelain 输出里的 `prunable` 行（parseWorktreeList 不收集它，这里单独扫）。 */
function prunableKeysOf(stdout: string): Set<string> {
  const keys = new Set<string>()
  let curPath: string | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length).trim()
    else if (line.startsWith('prunable') && curPath) {
      try {
        keys.add(compareKeyOfPath(curPath))
      } catch {
        /* 畸形路径：跳过 */
      }
    }
  }
  return keys
}

async function repoGitState(repoRoot: string): Promise<RepoGitState> {
  const r = await runGitRaw(repoRoot, ['worktree', 'list', '--porcelain'])
  if (r.code !== 0) return { repoRoot, entries: [], prunableKeys: new Set() }
  return { repoRoot, entries: parseWorktreeList(r.stdout), prunableKeys: prunableKeysOf(r.stdout) }
}

/** 目录是否存在（`lstat` 三态：读不出时按「不存在」处理——它同样不可用）。 */
function dirExists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

/**
 * 某个 worktree 此刻的 HEAD 分支——**从 `git worktree list --porcelain` 的条目直接读**，
 * 不再为每条记录单独跑一次 `rev-parse --abbrev-ref HEAD`。
 *
 * ## 为什么可以省掉这次 git（实测过）
 *
 * `--porcelain` 的 `branch refs/heads/<x>` 行读的就是该工作区自己的 HEAD 文件，所以：
 * - 在 worktree 里 `git checkout wt/other` 后，porcelain 的 branch 行随之变成 `wt/other`；
 * - detached 时 porcelain 给 `detached` 行、**没有** `branch` 行，而 `rev-parse --abbrev-ref HEAD`
 *   返回的是字面量 `HEAD`——两者等价（`state` 判定要的正是「它不是 record.branch」）。
 *
 * 唯一的前提是**目录存在**：目录被删后 porcelain 给的仍是最后一次登记的信息，不能用。
 * 调用方已经用 `exists && entry` 守着这一点，与改之前「目录不在就不问 HEAD」一致。
 *
 * 收益：每条记录少一次 git 调用（本机每次约 60-100ms，几乎全是进程启动）。
 */
function headBranchFromEntry(entry: WorktreeEntry | undefined): string | null {
  if (!entry) return null
  // detached 在 porcelain 里没有 branch 行，而 rev-parse 会返回字面量 'HEAD'
  if (entry.detached) return 'HEAD'
  return entry.branch ?? null
}

/**
 * 判定 `state`（§2.1 的短路表，**顺序不可改**）。
 *
 * 抽成纯函数是为了让测试能逐条构造四种情形，不必真的去删目录 / 切分支。
 */
export function computeState(input: {
  record: Pick<WorktreeRecord, 'path' | 'branch'>
  dirExists: boolean
  /** 该路径在 `git worktree list` 里是否登记；`undefined` = 没登记。 */
  gitEntry: WorktreeEntry | undefined
  /** 是否被 git 标记 prunable。 */
  prunable: boolean
  headBranch: string | null
}): { state: WorktreeState; actualBranch?: string } {
  const { record, dirExists: dir, gitEntry, prunable, headBranch } = input
  // 1. 目录不在 + git 明确标记 prunable → prunable（更强的信号排最前）
  if (!dir && prunable) return { state: 'prunable' }
  // 2. 目录不在 → dir-missing
  if (!dir) return { state: 'dir-missing' }
  // 3. 目录在但登记丢了（被外部 prune）→ dir-missing（不新造第五种状态）
  if (dir && gitEntry === undefined) return { state: 'dir-missing' }
  // 4. 目录在 + 登记在 + HEAD 不是 record.branch（含 detached：那时 headBranch 是 'HEAD'）→ mismatch
  if (dir && (headBranch === null || headBranch !== record.branch))
    return { state: 'branch-mismatch', actualBranch: headBranch ?? undefined }
  // 5. 其余
  return { state: 'ok' }
}

/** 每个 worktree 的会话数：按 `focusRoot` 归一化后计数。 */
function sessionCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  let sessions: Array<{ focusRoot?: string | null }> = []
  try {
    // 延迟 require 避免与 chat-store 形成模块环（chat-store 不依赖本模块，但保持单向更稳）
    const store = require('../chat-store') as typeof import('../chat-store')
    sessions = store.listSessions()
  } catch {
    return counts
  }
  for (const s of sessions) {
    const root = s.focusRoot
    if (!root) continue
    try {
      const key = compareKeyOfPath(root)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    } catch {
      /* 畸形路径跳过 */
    }
  }
  return counts
}

// ── sizeBytes 异步统计（T1.4b）──

/**
 * 体积缓存：`compareKey` → 字节数。
 *
 * 为什么必须缓存 + 后台算：一个装好依赖的 worktree 有几十万文件、几百 MB，同步算一次能让
 * `worktree:list` 卡几秒。而列表是界面最常刷新的东西（每次 `worktree:changed` 都会重取）。
 */
const sizeCache = new Map<string, number>()
/** 正在算的路径（防重复起任务：列表刷新很频繁，不去重会同时起十个遍历）。 */
const sizeInFlight = new Set<string>()

/** 目录体积（递归；读不出的子项跳过，不因一个权限问题放弃整棵树）。 */
function dirSizeSync(path: string, budget = { files: 0 }): number {
  let total = 0
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(path, e.name)
    if (e.isDirectory()) total += dirSizeSync(p, budget)
    else {
      try {
        total += statSync(p, { throwIfNoEntry: false })?.size ?? 0
      } catch {
        /* 单个文件读不出：跳过 */
      }
    }
    budget.files++
  }
  return total
}

/**
 * 该工作区的未提交改动数（spec §7.7 的「N 个未提交改动」）。
 *
 * ## 为什么这里要跑 `git status`，而 `mergeGate` 不跑
 *
 * 两者目的不同：`mergeGate` 只判「能不能点合并」，轻量三判据就够（§7.5 明确不许跑 status，
 * 否则 5 个工作区就是 5 次调用）；而 `dirtyCount` 是**要显示给用户看的数字**，没有捷径——
 * 不跑 git 就不知道有几个改动。所以这里如实跑一次，用 `-z` 只要条目数不解析路径。
 *
 * 目录不在时返回 null（无法统计），不去对不存在的路径跑 git。
 */
async function dirtyCountOf(path: string): Promise<number | null> {
  const r = await runGitRaw(path, ['status', '--porcelain', '-z'])
  if (r.code !== 0) return null
  if (!r.stdout) return 0
  // `-z` 用 \0 分隔条目；末尾可能有一个多余的 \0
  return r.stdout.split('\0').filter((s) => s.length > 0).length
}

/**
 * 轻量合并可用性门（spec §7.5）。
 *
 * **只看三样：`state` / `deps` / `targetBranch`。** 不跑 `status`，不做 C1~C6——
 * 那些在用户点开合并面板时由 `worktree:merge-dryrun` 做（那时跑 6 次 git 只为一个面板，值得）。
 *
 * 判据顺序有理由（先说最根本的）：
 * 1. `targetBranch` 为空 → 没目标分支，合并无从谈起（C-1，§4.2）；
 * 2. `state` 不可用 → source 不能作为合并源（目录没了 / 被切到别的分支）；
 * 3. `deps === 'installing'` → 文件系统正在被动，git 会看到半装的文件（不是 C1~C6 的项，是 UI 层判断）。
 */
export function computeMergeGate(input: {
  state: WorktreeState
  deps: string
  targetBranch: string | null
}): MergeGate {
  if (!input.targetBranch) return { mayMerge: false, blocker: 'target-not-set' }
  // dir-missing / prunable 对用户都是「这个工作区用不了」
  if (input.state === 'dir-missing' || input.state === 'prunable')
    return { mayMerge: false, blocker: 'source-missing' }
  // branch-mismatch 是「能用，但不在自己的分支上」——另一个出口（先切回）
  if (input.state === 'branch-mismatch')
    return { mayMerge: false, blocker: 'source-branch-changed' }
  if (input.deps === 'installing') return { mayMerge: false, blocker: 'installing' }
  return { mayMerge: true }
}

/**
 * target 检出里是否有未收尾的合并（spec §13.10）。**每次从 git 现算，不落盘。**
 *
 * 为什么不能落盘：用户在终端里手跑 `git merge --abort` 后，落盘状态立刻过期，
 * 界面会一直显示「合并中」，用户以为卡死。
 *
 * 找 target 检出与 C4 同源（§4.2）：`git worktree list --porcelain` 里
 * `branch refs/heads/<targetBranch>` **恰好一条**。0 条（没检出）或多条（有歧义，C4 会拒）
 * 都不算「合并进行中」。
 */
async function mergeInProgressOf(
  targetBranch: string | null,
  entries: WorktreeEntry[]
): Promise<{ targetPath: string; unmergedCount: number } | null> {
  if (!targetBranch) return null
  const matches = entries.filter((e) => e.branch === targetBranch)
  if (matches.length !== 1) return null
  const targetPath = matches[0].path
  // MERGE_HEAD 存在 = 有未收尾的 merge（`-q --verify`：不存在时不往 stderr 写 fatal）
  const head = await runGitRaw(targetPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  if (head.code !== 0) return null
  /*
   * 未合并文件数用 `diff --diff-filter=U` 而不是解析 `status`：
   * 前者输出就是纯路径列表，不受 porcelain 格式变化影响（后者要区分 XY 两列语义）。
   */
  const unmerged = await runGitRaw(targetPath, ['diff', '--name-only', '--diff-filter=U'])
  const unmergedCount =
    unmerged.code === 0 ? unmerged.stdout.split('\n').filter((l) => l.trim()).length : 0
  /*
   * 确认「合并进行中」就把 targetPath 登记进受信根。
   *
   * 这条路径与 merge.ts 里那次 trustRoot 是**两回事**，不能省：卡片上「解决冲突」按钮直接
   * 用 `mergeInProgress.targetPath` 去调 `fs:reveal-folder` / `git:merge-abort`，
   * 用户完全可能从没打开过合并面板。那条通道用 `isInsideRoot()` 判定，未受信就返回
   * `{ ok: false }` 且不提示——表现正是「点了没反应，冲突还在」。
   */
  trustRoot(targetPath)
  return { targetPath, unmergedCount }
}

/**
 * 取体积：命中缓存直接给；否则返回 null 并在后台算，算完发 `worktree:changed` 让界面重取。
 *
 * 这就是 T1.4b 的判据：首次 `null`（界面显示「统计中…」），算完发事件再刷新。
 */
function sizeBytesOf(path: string, compareKey: string): number | null {
  const cached = sizeCache.get(compareKey)
  if (cached !== undefined) return cached
  if (!sizeInFlight.has(compareKey)) {
    sizeInFlight.add(compareKey)
    /*
     * `setImmediate` 而不是直接算：本函数在 `worktree:list` 的同步路径上被调用，
     * 直接算就等于把遍历塞回列表请求里。推到下一轮事件循环，请求先返回 null。
     */
    setImmediate(() => {
      let bytes = 0
      try {
        bytes = dirSizeSync(path)
      } catch {
        bytes = 0
      } finally {
        sizeCache.set(compareKey, bytes)
        sizeInFlight.delete(compareKey)
        /*
         * 发**增量**而不是 `publishWorktreeChanged()`：后者会让界面整表重拉，
         * 而重拉本身就是 4N+1 次 git（见 chat-bus 里 WorktreeSizeUpdate 的注释）。
         * 体积是纯附加信息，只补这一个字段就够。
         */
        publishWorktreeSize({ compareKey, sizeBytes: bytes })
      }
    })
  }
  return null
}

/** 测试用：清掉体积缓存（生产不需要——目录体积不会自己变小）。 */
export function clearSizeCacheForTest(): void {
  sizeCache.clear()
  sizeInFlight.clear()
}

/** 记录被删/重建后，旧体积要作废。 */
export function invalidateSize(compareKey: string): void {
  sizeCache.delete(compareKey)
}

/**
 * 并发上限。
 *
 * 为什么不无限并发：每个 git 调用是一个**进程**（本机 76ms 起，见 bench），
 * N 大时一次 list 会同时起 3N 个进程——不是线程而是真进程，Windows 上创建进程不便宜，
 * 超过这个数量后收益递减而调度开销上升。8 是实测的折中（8 次 status 并行 265ms vs 串行 602ms）。
 */
const GIT_CONCURRENCY = 8

/**
 * 限并发跑一批异步任务，结果顺序与输入一致。
 *
 * **单条失败不影响其它条**：每个 worker 只处理一个任务，某个任务抛错时只让它自己那份变
 * `undefined`，worker 继续取下一个。这样「一个坏掉的工作区」不会把整张列表拖垮
 * ——这是并行化最容易引入的回归（串行时抛错会直接中断，并行时若不 catch 会变成 unhandled rejection）。
 *
 * `labelOf` 只用于日志：出问题时要能立刻知道是哪一条，只打序号还得回去数一遍。
 */
async function runLimited<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  labelOf?: (i: number) => string
): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = new Array(tasks.length).fill(undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      try {
        results[i] = await tasks[i]()
      } catch (e) {
        /*
         * 单条失败：留 undefined（**不给假状态**，见 listWorktrees 里 finalItems 的注释），
         * 其余照常。这里把 label 打出来，排查时不用回去数序号。
         */
        const who = labelOf ? labelOf(i) : `#${i}`
        console.warn(`[worktree] list 单项失败（${who}）：`, (e as Error)?.message ?? e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return results
}

/**
 * 生成快照（`worktree:list` 的实现）。
 *
 * ## 为什么全并行（性能修复）
 *
 * 这个函数原来对每条记录**串行**跑 `rev-parse HEAD` + `status` + `rev-parse MERGE_HEAD`，
 * 加上每个仓库一次 `worktree list`，共 `4N+1` 次 git。而一次 git 调用的成本**几乎全是进程启动**
 * （本机 76ms；`status` 里真正扫描工作区只占 24ms，18000 个文件也只到 189ms）。
 * 所以串行时每加一个 worktree 就加约 350ms，5 个就要 1.2 秒——**列表从 N=1 就开始慢**。
 *
 * 这些调用全是只读（`status` / `rev-parse` / `worktree list`），且 `runGitRaw` 已设
 * `GIT_OPTIONAL_LOCKS=0`（连 git 的可选锁都不取），并发读是安全的。改成并行后
 * 总耗时约等于「最慢的那一次」而不是「全部相加」。
 *
 * `worktree list` 仍然是**每个仓库一次**（按 repoKey 去重后并行），不会变成 N 份。
 */
export async function listWorktrees(): Promise<WorktreeSnapshot> {
  const records = listRecords()
  const counts = sessionCounts()

  /*
   * 第一段并行：按 repoRoot 去重后各自跑一次 `git worktree list`。
   * 先去重再并发——同一个仓库的多条记录共用一个结果，不能因为并发就查 N 次。
   */
  const repoRootByKey = new Map<string, string>()
  for (const rec of records) {
    try {
      const key = repoKeyOf(rec.repoRoot)
      if (!repoRootByKey.has(key)) repoRootByKey.set(key, rec.repoRoot)
    } catch {
      /* 归一化失败：这条记录不会有 repoState，state 会落到 dir-missing */
    }
  }
  const repoKeys = [...repoRootByKey.keys()]
  const repoStates = await runLimited(
    repoKeys.map((k) => () => repoGitState(repoRootByKey.get(k)!)),
    GIT_CONCURRENCY
  )
  const perRepo = new Map<string, RepoGitState>()
  repoKeys.forEach((k, i) => {
    const st = repoStates[i]
    if (st) perRepo.set(k, st)
  })

  /*
   * 第二段并行：每条记录一个任务，任务内部再并行它需要的 git 调用。
   *
   * 两个层次都并行是有意的：外层让不同 worktree 之间并发（这才是 N 大时的收益来源），
   * 内层让同一条记录的 HEAD / status / MERGE_HEAD 并发（N 小时也有收益）。
   * 两层的总并发仍然受 `runLimited` 的上限约束，不会因为嵌套而失控。
   */
  /*
   * `mergeInProgress` 按 **targetPath 去重**：多个 worktree 常常 `targetBranch` 相同
   * （默认都是主分支），而 target 检出是同一个目录——对同一个目录重复跑
   * `rev-parse MERGE_HEAD` + `diff --diff-filter=U` 是纯浪费，8 个 worktree 就是 16 次 git。
   * 去重后只需 2 次。缓存生命周期 = 本次 list（合并状态随时会变，不跨调用缓存）。
   */
  const mergeByTarget = new Map<
    string,
    Promise<{ targetPath: string; unmergedCount: number } | null>
  >()
  const mergeInProgressCached = (
    targetBranch: string | null,
    entries: WorktreeEntry[]
  ): Promise<{ targetPath: string; unmergedCount: number } | null> => {
    if (!targetBranch) return Promise.resolve(null)
    const matches = entries.filter((e) => e.branch === targetBranch)
    // 0 条 / 多条都不算「合并进行中」，无需缓存
    if (matches.length !== 1) return Promise.resolve(null)
    const targetPath = matches[0].path
    const hit = mergeByTarget.get(targetPath)
    if (hit) return hit
    const p = mergeInProgressOf(targetBranch, entries)
    mergeByTarget.set(targetPath, p)
    return p
  }

  const items = await runLimited(
    records.map((rec) => async () => {
      const exists = dirExists(rec.path)
      let entry: WorktreeEntry | undefined
      let prunable = false
      let repoState: RepoGitState | undefined
      try {
        repoState = perRepo.get(repoKeyOf(rec.repoRoot))
        entry = repoState?.entries.find((e) => {
          try {
            return compareKeyOfPath(e.path) === rec.compareKey
          } catch {
            return false
          }
        })
        prunable = repoState?.prunableKeys.has(rec.compareKey) ?? false
      } catch {
        /* 归一化失败：当作没登记，state 会落到 dir-missing */
      }
      /*
       * 两条只读调用并发（`headBranch` 不再单独跑 git，直接从 porcelain 条目读）。
       *
       * ## `dirtyCount === null` 同时是「git 在这个目录里能不能跑」的探针
       *
       * `status` 在目录存在的前提下失败，只有一种原因：这个工作区自己的 git 坏了
       * （`.git` 文件被删/改名、磁盘上的 gitdir 指向失效等）。此时 **porcelain 里那条 branch
       * 是主仓库登记中的旧值**，不能当「它还在自己的分支上」的证据——改之前这里会真去跑
       * `rev-parse`，那种情况返回 null → `branch-mismatch`；改之后若不判这一下就会变成 `ok`，
       * 界面显示「正常」，用户完全看不出工作区已经坏了。
       *
       * 所以：status 失败 ⇒ 不信任 porcelain 的 branch，按 null 交上去（落 `branch-mismatch`，
       * 与改之前一致）。不额外跑 git——status 本来就要跑。
       */
      const [dirtyCount, mergeInProgress] = await Promise.all([
        exists ? dirtyCountOf(rec.path) : Promise.resolve(null),
        mergeInProgressCached(rec.targetBranch, repoState?.entries ?? [])
      ])
      const gitUsable = exists && dirtyCount !== null
      const headBranch = exists && entry ? (gitUsable ? headBranchFromEntry(entry) : null) : null
      const { state, actualBranch } = computeState({
        record: rec,
        dirExists: exists,
        gitEntry: entry,
        prunable,
        headBranch
      })
      const item: WorktreeListItem = {
        path: rec.path,
        compareKey: rec.compareKey,
        repoRoot: rec.repoRoot,
        branch: rec.branch,
        baseSha: rec.baseSha,
        baseLabel: rec.baseLabel,
        targetBranch: rec.targetBranch,
        createdAt: rec.createdAt,
        state,
        ...(actualBranch !== undefined ? { actualBranch } : {}),
        deps: rec.deps,
        ...(rec.depsDetail !== undefined ? { depsDetail: rec.depsDetail } : {}),
        sessionCount: counts.get(rec.compareKey) ?? 0,
        sizeBytes: exists ? sizeBytesOf(rec.path, rec.compareKey) : 0,
        lockHolder: gitLockHolder(rec.path),
        dirtyCount,
        mergeInProgress,
        mergeGate: computeMergeGate({ state, deps: rec.deps, targetBranch: rec.targetBranch }),
        /*
         * 「是否在创建时那个根内」。用 `createdUnderRoot`（创建时冻结）而不是当前根，
         * 理由同 `remove.ts` 的 `blockDirRemovalOutsideRoot`：用户改根不该让历史记录集体变红。
         *
         * 老记录（`undefined`）**不给 `insideRoot`**，让界面知道「无法判断」而不是「在根外」。
         */
        ...(rec.createdUnderRoot === undefined || rec.createdUnderRoot === ''
          ? {}
          : { insideRoot: isInsideRoot(rec.createdUnderRoot, rec.path), createdUnderRoot: rec.createdUnderRoot })
      }
      return item
    }),
    GIT_CONCURRENCY,
    // 日志里带上路径：只打序号的话排查还得回去数
    (i) => records[i]?.path ?? `#${i}`
  )

  /*
   * 单条任务的异常（理论上不该发生——里面的 git 调用都自带失败兜底）**不兜假状态**：
   * 直接把那条从 items 里滤掉，让 `runLimited` 的 `console.warn`（带路径）去留现场。
   *
   * ## 为什么不兜「dir-missing」这样的保守值（上一版的做法）
   *
   * 那个兜底会把一个**目录其实存在**的工作区显示成「工作区目录已缺失」，还给它「重建」按钮。
   * 用户会照着点——等 P2 的 rebuild 接通后，那就是「对一个存在的目录执行 git worktree add」。
   * 一句错的文案 + 一个可执行的危险动作，比少一行更糟；而且它把一个**程序 bug** 伪装成了
   * **正常的产品状态**，排查时完全看不出异常。
   *
   * ## 那「工作区凭空消失」会让用户以为被删了吗
   *
   * 会有一点，但两害相权：消失 + warn 是可以查的（日志里有路径），假状态是查不出来的
   * （没有日志，界面看起来一切正常）。且这条路本来就只在代码有 bug 时才走到。
   */
  const finalItems = items.filter((it): it is WorktreeListItem => it !== undefined)

  // unmanaged：git 登记里有、记录里没有的
  const managed = new Set(records.map((r) => r.compareKey))
  const unmanaged: UnmanagedWorktree[] = []
  for (const [, state] of perRepo) {
    let primaryKey: string | null = null
    try {
      primaryKey = compareKeyOfPath(state.repoRoot)
    } catch {
      primaryKey = null
    }
    for (const e of state.entries) {
      let key: string
      try {
        key = compareKeyOfPath(e.path)
      } catch {
        continue
      }
      if (managed.has(key)) continue
      /*
       * 主检出不是「未管理工作区」——它就是仓库本身（`git worktree list` 的第一条永远是它）。
       * 把它塞进 unmanaged 会让界面上每条记录旁边都多出一个「未管理」的假条目。
       * 判据是**路径比较键相等**（不是 `repoKeyOf`——那是 sha1 摘要，永远不相等）。
       */
      if (primaryKey !== null && key === primaryKey) continue
      unmanaged.push({
        path: e.path,
        ...(e.branch !== undefined ? { branch: e.branch } : {}),
        ...(e.head !== undefined ? { head: e.head } : {}),
        ...(state.prunableKeys.has(key) ? { prunable: true } : {})
      })
    }
  }

  return {
    items: finalItems,
    unmanaged,
    storeUnreadable: getStoreUnreadable()
  }
}

/** 记录文件读坏了（此时 items 为空不代表没有工作区）。 */
function getStoreUnreadable(): boolean {
  try {
    const store = require('./store') as typeof import('./store')
    return store.getStoreLoadState() === 'corrupt'
  } catch {
    return false
  }
}