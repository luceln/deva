import { rmSync } from 'fs'
import { runGitRaw } from '../git'
import { publishWorktreeChanged } from '../chat-bus'
import { listRecords, getRecord, removeRecord } from './store'
import { looksLikeOurWorktreeDir, listWorktrees, hasWorktreeEntry } from './git-worktree'
import { withGitLock } from './lock'
import { invalidateSize } from './list'

/**
 * 删一个 worktree：解登记 → 删目录 → 删记录 → 删分支。
 *
 * ## 为什么这个文件必须先于「成员自动建 worktree」存在
 *
 * `deps.ts` 会真装 `node_modules`（几百 MB）。`remove` 缺失时，谁建的都删不掉——
 * 用户手动建的也一样，这是既有缺陷。在那之上再加「程序自动建」，就是**自动制造删不掉的大目录**。
 *
 * ## 顺序不能换（与 `cleanupFailedCreate` 同理，理由在那边写得更细）
 *
 * git 删分支前会检查「这个分支是否被某个 worktree 检出」，登记还在就报
 * `cannot delete branch used by worktree`。所以必须先解登记。
 *
 * ## 与 `cleanupFailedCreate` 的区别
 *
 * 那个的准入凭据是 `intent`（「本次是不是我新建的」），语义是**回滚自己的失败**，
 * `pathExistedAtStart` 为真时绝不删。这个的准入凭据是**用户的明确意图**（点删除 / 显式调用），
 * 删的是 `active` 状态的、用户自己的 worktree，因此：
 *  - 必须查脏，除非调用方显式要求 `force`（那会丢未提交改动）
 *  - 分支只在「没有别的 worktree 检出它」时才删
 *  - 目录只在「看起来确实是我们的 worktree 目录」时才用 `rmSync` 兜底
 *
 * ## 删不掉的地方一律进 `warnings`，不静默
 *
 * 这一整套的教训是「静默失效」：删一半、报告说成功，用户以为干净了，实际还占着几百 MB。
 */

export interface RemoveResult {
  ok: boolean
  /** 为什么没删（仅在 `ok:false` 时有值）。 */
  reason?: 'not-found' | 'dirty' | 'unreadable' | 'remove-failed'
  message?: string
  /** 未提交改动数（`dirty` 时给用户看，决定要不要强制删）。 */
  dirtyCount?: number
  /** 各步骤是否真的做到了。 */
  worktreeRemoved: boolean
  dirRemoved: boolean
  recordRemoved: boolean
  branchRemoved: boolean
  /** 没能做到的部分，逐条说明。**调用方必须展示给用户**，否则「删了」是假的。 */
  warnings: string[]
}

export interface RemoveRequest {
  /** worktree 的绝对路径（`WorktreeRecord.path`）。 */
  path: string
  /**
   * 有未提交改动时也删。
   *
   * ⚠️ **会丢未提交的改动**。默认 `false`，只有用户在界面上确认了才传。
   */
  force?: boolean
  /**
   * 连分支一起删。
   *
   * 默认 `true`：worktree 和它的分支是一体的，留着分支反而让下次创建同名分支失败。
   * 传 `false` 时保留分支（用户还想在别处接着用）。
   */
  deleteBranch?: boolean
}

/**
 * 数一个目录里有多少未提交项（含未跟踪）。
 *
 * 与 `list.ts` 的 `dirtyCountOf` 同一口径（`status --porcelain` 按行数），但那边是 private
 * 且带缓存，这里要为「删之前现查一次」单独实现——缓存会让「刚改完就删」漏判。
 */
async function dirtyCountOf(path: string): Promise<number | null> {
  const r = await runGitRaw(path, ['status', '--porcelain'])
  if (r.code !== 0) return null
  return r.stdout.split('\n').filter((line) => line.trim() !== '').length
}

/** 这个分支还有没有别的 worktree 在检出？有就不能删。 */
async function branchInUseElsewhere(repoRoot: string, branch: string, selfPath: string): Promise<boolean> {
  const r = await runGitRaw(repoRoot, ['worktree', 'list', '--porcelain'])
  if (r.code !== 0) return true // 查不出来：保守当作在用，不删
  let currentPath = ''
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim()
    } else if (line === `branch refs/heads/${branch}` && currentPath && currentPath !== selfPath) {
      return true
    }
  }
  return false
}

/** 删一个 worktree。调用方负责展示 `warnings`。 */
export async function removeWorktree(req: RemoveRequest): Promise<RemoveResult> {
  const empty: RemoveResult = {
    ok: false,
    worktreeRemoved: false,
    dirRemoved: false,
    recordRemoved: false,
    branchRemoved: false,
    warnings: []
  }

  const rec = getRecord(req.path)
  if (!rec) {
    /*
     * 没有记录 ≠ 不能删：git 里可能还有登记（`list.ts` 的 `unmanaged` 就是这种）。
     * 但那种情况下我们不知道它的分支、也不知道它是不是用户自己 `git worktree add` 出来的，
     * 删了可能误伤。所以只删「我们登记的」，其余让用户自己去 git 里处理。
     */
    return {
      ...empty,
      reason: 'not-found',
      message: '没有这个工作区的记录。若它仍在 git 里登记，请用 git worktree remove 处理。'
    }
  }

  const path = rec.path
  const branch = rec.branch

  return withGitLock([rec.repoRoot, path], 'remove', async (): Promise<RemoveResult> => {
    const warnings: string[] = []
    const res: RemoveResult = { ...empty, warnings }

    // ── 0. 脏检查：未提交改动默认拒绝 ──
    const dirty = await dirtyCountOf(path)
    if (dirty === null) {
      // 目录不在 / 读不出来：没有东西会丢，继续往下走（解登记 + 删记录仍然有意义）
      warnings.push('读不出未提交改动数，按无改动处理')
    } else if (dirty > 0 && !req.force) {
      return {
        ...res,
        reason: 'dirty',
        message: `这个工作区有 ${dirty} 处未提交改动，删除会丢失它们。确认要删请勾选强制删除。`,
        dirtyCount: dirty
      }
    } else if (dirty > 0) {
      warnings.push(`强制删除了 ${dirty} 处未提交改动`)
    }

    // ── 1. 解登记 ──
    /*
     * 用 `listWorktrees` + `hasWorktreeEntry`，**不要自己解析 porcelain**：
     * `git worktree list --porcelain` 给的是正斜杠路径（`C:/Users/...`），而记录里的 `rec.path`
     * 是 Windows 原生反斜杠。直接 `===` 比较永远不等，`registered` 恒 false，
     * 于是 `worktree remove` 一次都没被调用——但目录和记录照样被删，**留下一条僵尸登记**。
     * 那正是「报告说删了、git 里还在」的静默失败。
     */
    const entries = await listWorktrees(rec.repoRoot)
    const registered = hasWorktreeEntry(entries, path)

    if (registered) {
      const r = await runGitRaw(rec.repoRoot, ['worktree', 'remove', '--force', path])
      if (r.code === 0) res.worktreeRemoved = true
      else warnings.push(`git worktree remove 失败：${r.stderr.trim() || `code ${r.code}`}`)
    }

    // ── 2. 清残留登记（仅当第 1 步失败，且确实是这条路径）──
    if (registered && !res.worktreeRemoved) {
      /*
       * prune 的合理用途（与 `cleanupFailedCreate` 同一理由）：清掉「目录已不存在」的登记。
       * 这里已经在 1.0 确认过这条登记指向我们要删的路径，不会波及别人的 worktree。
       *
       * 仍然要 prune 一次的理由：`worktree remove` 失败最常见的原因就是目录已被外部删掉，
       * 那种情况下只有 prune 能清掉这条僵尸登记。
       */
      const p = await runGitRaw(rec.repoRoot, ['worktree', 'prune'])
      if (p.code !== 0) warnings.push(`worktree prune 失败：${p.stderr.trim() || `code ${p.code}`}`)
    }

    // ── 3. 删目录（只删「看起来确实是我们的 worktree 目录」）──
    const look = looksLikeOurWorktreeDir(path, rec.repoRoot)
    if (!look.ok) {
      /*
       * 不是我们建的那种形态：可能用户往里面放了别的东西，或者路径被换了。
       * **不 rmSync**——递归删一个来路不明的目录太危险，留给用户自己核对。
       */
      warnings.push(`目录未删（${look.why}）：${path}`)
    } else {
      try {
        rmSync(path, { recursive: true, force: true })
        res.dirRemoved = true
      } catch (e) {
        warnings.push(`删目录失败：${(e as Error)?.message ?? String(e)}`)
      }
    }

    // ── 4. 删记录 ──
    if (removeRecord(path)) res.recordRemoved = true
    else warnings.push('删 worktrees.json 记录失败（磁盘写不进去）')

    // ── 5. 删分支（默认删，但要先确认没被别人检出）──
    const wantBranch = req.deleteBranch !== false
    if (!wantBranch) {
      warnings.push(`分支 ${branch} 保留`)
    } else if (await branchInUseElsewhere(rec.repoRoot, branch, path)) {
      warnings.push(`分支 ${branch} 还被别的工作区检出，保留未删`)
    } else {
      const exists = await runGitRaw(rec.repoRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`
      ])
      if (exists.code === 0) {
        /*
         * **必须 `-D`**：这个分支上的提交通常还没合回主分支，`-d` 会因为「未合并」拒绝。
         * 准入凭据是用户明确要删这个工作区——分支和它是同一次创建的，留着只会让同名分支建不出来。
         *
         * 与失败清理不同，这里**提交可能是有价值的**，所以 `-D` 之前已经把分支名和 HEAD
         * 写进了 warnings（见下），用户事后还能 `git branch <name> <sha>` 找回。
         */
        const headSha = (await runGitRaw(path, ['rev-parse', 'HEAD'])).stdout.trim()
        const del = await runGitRaw(rec.repoRoot, ['branch', '-D', branch])
        if (del.code === 0) {
          res.branchRemoved = true
          if (headSha) warnings.push(`已删除分支 ${branch}（删前它指向 ${headSha.slice(0, 8)}）`)
        } else {
          warnings.push(`删分支失败：${del.stderr.trim() || `code ${del.code}`}`)
        }
      }
    }

    // ── 6. 体积缓存 ──
    // 不失效的话，列表里会继续显示一个已经不存在的目录的体积（用户以为没删掉）。
    invalidateSize(rec.compareKey)
    publishWorktreeChanged()

    const ok = res.recordRemoved
    return { ...res, ok, reason: ok ? undefined : 'remove-failed' }
  })
}

/** 只读：这个路径是不是我们登记的 worktree（界面用它决定是否显示删除按钮）。 */
export function isManagedWorktree(path: string): boolean {
  return getRecord(path) !== null
}

/** 有没有任何记录声称自己在这个 repo 下（孤儿治理用）。 */
export function recordsUnderRepo(repoRoot: string): Array<{ path: string; branch: string }> {
  return listRecords()
    .filter((r) => r.repoRoot === repoRoot)
    .map((r) => ({ path: r.path, branch: r.branch }))
}
