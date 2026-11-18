import { readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { runGitRaw } from '../git'
import { normalizeWorktreePath } from './paths'

/**
 * git worktree 的底层操作与**失败清理算法**（spec §3.4）。
 *
 * 单独成文件的原因：清理算法有六步、每步的准入条件都不同，混在创建流程里会看不清「什么情况下删什么」。
 * 而这里一旦删错就是删用户的目录——这是本功能最危险的一段代码。
 */

/** add 的超时：新建工作区只写工作区文件、不复制对象库，60 秒是宽裕上限（spec §3.3）。 */
const ADD_TIMEOUT = 60_000

export interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  bare?: boolean
  detached?: boolean
}

/**
 * 解析 `git worktree list --porcelain`。
 *
 * 为什么不用 `--porcelain` 之外的输出：普通输出会为了对齐而折行，路径里有空格时更难拆。
 * porcelain 是「一行一个字段、空行分隔条目」的稳定格式。
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      if (cur) out.push(cur)
      cur = null
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const val = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) out.push(cur)
      cur = { path: val }
    } else if (cur) {
      if (key === 'HEAD') cur.head = val
      else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '')
      else if (key === 'bare') cur.bare = true
      else if (key === 'detached') cur.detached = true
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 列出全部 worktree。失败回空数组（调用方据 code 判成败时用 listWorktreesRaw）。 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const r = await runGitRaw(repoRoot, ['worktree', 'list', '--porcelain'])
  return r.code === 0 ? parseWorktreeList(r.stdout) : []
}

/** 某个路径是否已登记为 worktree（比较用归一化键，别用字符串相等）。 */
export function hasWorktreeEntry(entries: WorktreeEntry[], path: string): boolean {
  let key: string
  try {
    key = normalizeWorktreePath(path).compareKey
  } catch {
    return false
  }
  return entries.some((e) => {
    try {
      return normalizeWorktreePath(e.path).compareKey === key
    } catch {
      return false
    }
  })
}

/**
 * Step 2：`git worktree add -b <branch> <path> <baseSha>`。
 *
 * - `cwd = repoRoot`：spec 明确要求（A7 —— 起点永远来自主检出，不来自任何会话的 focusRoot）。
 * - 参数作为独立 argv，不经 shell（与 git.ts 的既有约定一致）。
 * - **不加 `--force`**：加了会覆盖已存在路径，直接违反 A22。
 * - 不额外传 env：`GIT_OPTIONAL_LOCKS=0` 对 add 的影响已实测无影响（见 git.ts 的注释）。
 */
export async function addWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  baseSha: string
): Promise<{ ok: boolean; stderr: string }> {
  const r = await runGitRaw(repoRoot, ['worktree', 'add', '-b', branch, path, baseSha], ADD_TIMEOUT)
  return { ok: r.code === 0, stderr: r.stderr.trim() }
}

/** 目录是否「看起来是本次 git 建的」（spec §3.4 第 3 步的准入判据之一）。 */
function looksLikeOurWorktreeDir(path: string, repoRoot: string): { ok: boolean; why: string } {
  let entries: string[]
  try {
    const st = statSync(path, { throwIfNoEntry: false })
    if (!st) return { ok: true, why: 'already-gone' }
    if (!st.isDirectory()) return { ok: false, why: 'not-a-directory' }
  } catch (e) {
    // 读不出状态：不知道里面有什么，**不删**
    return { ok: false, why: `stat-failed:${(e as NodeJS.ErrnoException)?.code}` }
  }
  try {
    entries = readdirSync(path) as string[]
  } catch (e) {
    return { ok: false, why: `readdir-failed:${(e as NodeJS.ErrnoException)?.code}` }
  }
  // 空目录：git add 可能刚建了目录就失败，允许删
  if (entries.length === 0) return { ok: true, why: 'empty' }
  /*
   * 非空：只认「有 .git 文件且首行指向本仓库的 .git/worktrees/<name>」。
   * 这条防的是「并发进程恰好在这个路径上建了东西」——那种情况下绝不能删。
   */
  try {
    const gitFile = join(path, '.git')
    const first = readFileSync(gitFile, 'utf8').split('\n')[0] ?? ''
    if (!first.startsWith('gitdir: ')) return { ok: false, why: 'no-git-file' }
    const target = first.slice('gitdir: '.length).trim().replace(/\\/g, '/')
    const repoGit = join(normalizeWorktreePath(repoRoot).path, '.git', 'worktrees').replace(/\\/g, '/')
    if (!target.startsWith(repoGit + '/')) return { ok: false, why: `gitdir-not-ours:${target}` }
    return { ok: true, why: 'gitdir-match' }
  } catch {
    return { ok: false, why: 'unreadable-git-file' }
  }
}

export interface CleanupResult {
  worktreeRemoved: boolean
  dirRemoved: boolean
  branchRemoved: boolean
  recordRemoved: boolean
  warnings: string[]
}

/**
 * **失败清理算法（spec §3.4，六步逐字实现）**。
 *
 * 准入凭据只有 `intent`：
 *  - `intent.branchExistedAtStart === false` 才允许删分支；
 *  - `intent.pathExistedAtStart === false` 才允许删目录。
 *
 * **不得**用「现在目录里有什么」替代这个凭据：那会把「用户原本就有的目录」判成本次新建。
 * `intent` 恒为 false（Step 0 已拒绝已存在的情形），但仍记录它——崩溃恢复时 Step 0 早已不在内存里。
 *
 * 顺序必须是「先解登记 → 再删目录 → 再删分支」（spec 给了理由）：git 删分支会检查「该分支是否被
 * 某个 worktree 检出」，登记还在就报 `cannot delete branch used by worktree`。
 */
export async function cleanupFailedCreate(opts: {
  repoRoot: string
  path: string
  branch: string
  intent: { branchExistedAtStart: boolean; pathExistedAtStart: boolean }
}): Promise<CleanupResult> {
  const warnings: string[] = []
  const res: CleanupResult = {
    worktreeRemoved: false,
    dirRemoved: false,
    branchRemoved: false,
    recordRemoved: false,
    warnings
  }

  // ── 第 1 步：解登记 ──
  const entries = await listWorktrees(opts.repoRoot)
  const registered = hasWorktreeEntry(entries, opts.path)
  if (registered) {
    const r = await runGitRaw(opts.repoRoot, ['worktree', 'remove', '--force', opts.path])
    if (r.code === 0) res.worktreeRemoved = true
    // 失败不阻断：目录可能已经不在了，git 会报 validation failed
    else warnings.push(`worktree remove 失败：${r.stderr.trim() || `code ${r.code}`}`)
  }

  // ── 第 2 步：清残留登记（**仅在确认登记指向本次路径时**）──
  if (registered && !res.worktreeRemoved) {
    /*
     * 这条 prune 是允许的，理由（spec §3.4 要求写进代码）：
     * A33 禁止的是「用户目录被外部删除后静默 prune 掉登记」——那是**用户资产的登记**。
     * 这里 prune 的是**我们刚创建、且已确认属于本次尝试**的登记（上面的 `registered` 就是那个确认），
     * 且 git 的 prune 只会清除「目录已不存在」的登记，不会影响任何活着的 worktree。
     *
     * **不得扩大到常规路径**：非失败清理的代码路径里不许调 prune。
     */
    const p = await runGitRaw(opts.repoRoot, ['worktree', 'prune'])
    if (p.code !== 0) warnings.push(`worktree prune 失败：${p.stderr.trim() || `code ${p.code}`}`)
  }

  // ── 第 3 步：删目录（仅当本次新建 且 看起来确实是我们的）──
  if (opts.intent.pathExistedAtStart) {
    // 用户原本就有的目录：**绝对不删**
    warnings.push('目标路径在创建前已存在，保留未删')
  } else {
    const look = looksLikeOurWorktreeDir(opts.path, opts.repoRoot)
    if (!look.ok) {
      warnings.push(`目录未删（${look.why}），保留给用户核对：${opts.path}`)
    } else {
      try {
        // 同步删除：清理路径不用异步，避免进程在清理中途退出（spec §3.4 第 3 步）
        rmSync(opts.path, { recursive: true, force: true })
        res.dirRemoved = true
      } catch (e) {
        warnings.push(`删目录失败：${(e as Error)?.message ?? String(e)}`)
      }
    }
  }

  // ── 第 4 步：删分支（必须 -D）──
  if (opts.intent.branchExistedAtStart) {
    warnings.push('分支在创建前已存在，保留未删')
  } else {
    const exists = await runGitRaw(opts.repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${opts.branch}`
    ])
    if (exists.code === 0) {
      /*
       * **必须 `-D`**：`-d` 在「分支未合并」时会拒绝，而失败路径上这个分支正是未合并的
       * （spec 实测：两个 add 失败场景都留下了孤儿分支）。准入凭据已确认这分支由本次创建，
       * `-D` 不造成任何用户资产损失。
       */
      const del = await runGitRaw(opts.repoRoot, ['branch', '-D', opts.branch])
      if (del.code === 0) res.branchRemoved = true
      else warnings.push(`删分支失败：${del.stderr.trim() || `code ${del.code}`}`)
    }
  }

  return res
}

/** Step 3 校验：HEAD 与分支必须与我们记录的一致。 */
export async function verifyWorktree(
  path: string,
  baseSha: string,
  branch: string
): Promise<{ ok: boolean; why?: string }> {
  const head = await runGitRaw(path, ['rev-parse', 'HEAD'])
  if (head.code !== 0) return { ok: false, why: `rev-parse HEAD 失败：${head.stderr.trim()}` }
  if (head.stdout.trim() !== baseSha) return { ok: false, why: `HEAD 不符：${head.stdout.trim()} ≠ ${baseSha}` }
  const cur = await runGitRaw(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (cur.code !== 0) return { ok: false, why: `rev-parse --abbrev-ref 失败：${cur.stderr.trim()}` }
  if (cur.stdout.trim() !== branch) return { ok: false, why: `分支不符：${cur.stdout.trim()} ≠ ${branch}` }
  return { ok: true }
}