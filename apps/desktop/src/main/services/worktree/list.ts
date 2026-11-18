import { statSync, readdirSync, lstatSync } from 'fs'
import { join } from 'path'
import { runGitRaw } from '../git'
import { listRecords, type WorktreeRecord, type DepsState } from './store'
import { compareKeyOfPath, repoKeyOf } from './paths'
import { parseWorktreeList, type WorktreeEntry } from './git-worktree'
import { gitLockHolder } from './lock'
import { publishWorktreeChanged } from '../chat-bus'

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

/** 四种 state（§2.1）。渲染层按它决定按钮可用性，不自行推断（A48）。 */
export type WorktreeState = 'ok' | 'branch-mismatch' | 'dir-missing' | 'prunable'

/** 快照里的一条（渲染层消费）。 */
export interface WorktreeListItem {
  path: string
  compareKey: string
  repoRoot: string
  branch: string
  baseSha: string
  baseLabel: string
  targetBranch: string | null
  createdAt: number
  state: WorktreeState
  /** `branch-mismatch` 时的实际 HEAD 分支名（detached 时为 'HEAD'）。 */
  actualBranch?: string
  deps: DepsState
  depsDetail?: string
  /** 关联会话数（`focusRoot` 指向本路径的会话）。 */
  sessionCount: number
  /** 目录体积；null = 还在统计（界面显示「统计中…」）。 */
  sizeBytes: number | null
  /** 当前持锁者（另一个会话正在这个目录上跑 git 操作）。 */
  lockHolder: { label: string; since: number } | null
}

/** 不受本功能管理的 git 登记项（只读展示）。 */
export interface UnmanagedWorktree {
  path: string
  branch?: string
  head?: string
  prunable?: boolean
}

export interface WorktreeSnapshot {
  items: WorktreeListItem[]
  unmanaged: UnmanagedWorktree[]
  /** 记录文件本身读坏了：此时 `items` 为空但**不代表没有工作区**，界面要提示「记录读不出」。 */
  storeUnreadable: boolean
}

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

/** 某个 worktree 目录此刻的 HEAD 分支（detached 时 git 返回字面量 `HEAD`）。 */
async function headBranchOf(path: string): Promise<string | null> {
  const r = await runGitRaw(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (r.code !== 0) return null
  const b = r.stdout.trim()
  return b || null
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
        publishWorktreeChanged()
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
 * 生成快照（`worktree:list` 的实现）。
 *
 * 一次调用只对每个 repoRoot 跑一次 `git worktree list`（同仓库的多条记录共用），
 * 每条记录再各自 `rev-parse` 一次 HEAD——这是 §2.1 规定的输入，别省。
 */
export async function listWorktrees(): Promise<WorktreeSnapshot> {
  const records = listRecords()
  const counts = sessionCounts()

  // 按 repoRoot 分组，减少 git 调用
  const perRepo = new Map<string, RepoGitState>()
  for (const rec of records) {
    let key: string
    try {
      key = repoKeyOf(rec.repoRoot)
    } catch {
      continue
    }
    if (!perRepo.has(key)) perRepo.set(key, await repoGitState(rec.repoRoot))
  }

  const items: WorktreeListItem[] = []
  for (const rec of records) {
    const exists = dirExists(rec.path)
    let entry: WorktreeEntry | undefined
    let prunable = false
    try {
      const repoState = perRepo.get(repoKeyOf(rec.repoRoot))
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
    // 目录不在就不必去问 HEAD（那条命令必失败）
    const headBranch = exists && entry ? await headBranchOf(rec.path) : null
    const { state, actualBranch } = computeState({
      record: rec,
      dirExists: exists,
      gitEntry: entry,
      prunable,
      headBranch
    })
    items.push({
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
      lockHolder: gitLockHolder(rec.path)
    })
  }

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
    items,
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