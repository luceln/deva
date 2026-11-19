import { existsSync, mkdirSync } from 'fs'
import { runGitRaw } from '../git'
import { publishWorktreeChanged } from '../chat-bus'
import { getRecord } from './store'
import { hasWorktreeEntry, listWorktrees } from './git-worktree'
import { withGitLock } from './lock'
import { invalidateSize } from './list'

/**
 * 重建一个「目录已经不在了」的 worktree（spec T3.3 / A34）。
 *
 * ## 什么时候用
 *
 * 用户手工 `rm -rf` 了 worktree 目录，或者被系统清理工具带走。此时记录和分支都还在，
 * 只有目录没了（列表里显示 `state: 'dir-missing'`）。重建 = 从**原分支**重新检出到原路径。
 *
 * ## A34 的硬要求：不得「提示成功但目录不存在」
 *
 * 这是本文件存在的唯一理由。重建有三处会**静默假成功**：
 *  1. `git worktree add` 退出码 0，但路径被写成别的地方（路径归一化差异）
 *  2. 退出码 0，但目录建了一半就被外部清掉
 *  3. 我们复用了创建流程的 `addWorktree`，它带 `-b`（新建分支）——重建时分支已存在，
 *     带 `-b` 会直接失败；若有人「顺手」改成忽略错误继续往下走，就变成假成功
 *
 * 所以重建结束后**必须回读**：目录在不在、HEAD 是不是该分支、登记有没有。三项都过才算成功。
 * 任一项不过 → `ok: false` + 明确原因，绝不返回成功。
 *
 * ## 为什么不用 `addWorktree`
 *
 * 它固定带 `-b`（新建分支）。重建的分支**必须已存在**（`record.branch` 创建后永不改），
 * 带 `-b` 会报 `a branch named 'x' already exists`。这里直接用 `worktree add <path> <branch>`
 * （检出已有分支），语义正好相反。
 */

export interface RebuildResult {
  ok: boolean
  /** 为什么没重建成功（`ok:false` 时给）。 */
  reason?: 'not-found' | 'dir-exists' | 'branch-missing' | 'installing' | 'add-failed' | 'verify-failed'
  message?: string
  /** 重建后回读到的实际状态，供调用方核对（`ok:true` 时也带上，证明真的建成了）。 */
  path?: string
  branch?: string
  /** 重建后目录确实存在、HEAD 确实在该分支上。**这是 A34 的判据本身，不是附带信息。** */
  verified?: boolean
  /** 没能做到的部分，逐条说明。调用方必须展示。 */
  warnings: string[]
}

/**
 * 重建 worktree 到它记录里的原路径与原分支。
 *
 * @param req.path worktree 路径（记录主键，内部会归一化比较）
 */
export async function rebuildWorktree(req: { path: string }): Promise<RebuildResult> {
  const rec = getRecord(req.path)
  if (!rec) {
    return {
      ok: false,
      reason: 'not-found',
      message: '没有这个工作区的记录，无法重建。',
      warnings: []
    }
  }

  return withGitLock([rec.repoRoot, rec.path], 'rebuild', async (): Promise<RebuildResult> => {
    const warnings: string[] = []

    /*
     * ── 0. 依赖正在装：拒绝 ──
     * 与 `remove` 同一理由：安装进程正在往这个目录写，重建会先删/再建，等于把安装现场掀了。
     * 这里不是「装完再重建更好」，而是**此刻重建必然留下一个半装状态**。
     */
    if (rec.deps === 'installing') {
      return {
        ok: false,
        reason: 'installing',
        message: '依赖正在安装，等它结束或失败后再重建。',
        warnings
      }
    }

    // ── 1. 目录还在就不叫重建 ──
    /*
     * 不「先删再建」：目录在却要重建，说明用户真正想要的是「重置到干净状态」，
     * 那是另一件事（会丢未提交改动），不能用重建这个无争议的动作悄悄做掉。
     */
    if (existsSync(rec.path)) {
      return {
        ok: false,
        reason: 'dir-exists',
        message: `目录还在（${rec.path}），不需要重建。要重置请先删除再重建。`,
        warnings
      }
    }

    // ── 2. 分支必须还在：不在就没东西可检出 ──
    /*
     * 分支被手工删掉时，`worktree add <path> <branch>` 会报 `invalid reference`。
     * 先查一次是为了给出**能看懂**的原因（「分支 X 已被删除」），而不是让用户对着 git 的英文报错猜。
     * 注意这里不试图「从 baseSha 重新造一个分支」——那会造出一个和原来同名的分支但丢掉之后所有提交，
     * 属于自作主张。
     */
    const br = await runGitRaw(rec.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${rec.branch}`])
    if (br.code !== 0 || !br.stdout.trim()) {
      return {
        ok: false,
        reason: 'branch-missing',
        message: `分支 ${rec.branch} 已被删除，无法重建。`,
        warnings
      }
    }

    // ── 3. 清掉可能残留的僵尸登记 ──
    /*
     * 目录被外部删掉时，git 里那条登记通常还在（`worktree list` 仍列出它）。
     * 这种僵尸登记会让 `worktree add` 报 `already registered`。
     * 用 prune 清掉——它的作用正是「清掉目录已不存在的登记」，不会波及别的 worktree。
     */
    const before = await listWorktrees(rec.repoRoot)
    if (hasWorktreeEntry(before, rec.path)) {
      const p = await runGitRaw(rec.repoRoot, ['worktree', 'prune'])
      if (p.code !== 0) {
        warnings.push(`清理残留登记失败：${p.stderr.trim() || `code ${p.code}`}`)
      }
    }

    // ── 4. 建 ──
    const parent = rec.path.slice(0, rec.path.lastIndexOf('/')) || rec.path
    try {
      mkdirSync(parent, { recursive: true })
    } catch (e) {
      // 父目录建不出来时 add 必然失败，但先把原因记下来（add 的报错会指向父目录不存在，不够直白）
      warnings.push(`建父目录失败：${(e as Error)?.message ?? String(e)}`)
    }

    const add = await addWorktreeExistingBranch(rec.repoRoot, rec.path, rec.branch)
    if (!add.ok) {
      return {
        ok: false,
        reason: 'add-failed',
        message: add.stderr || 'git worktree add 失败',
        warnings
      }
    }

    /*
     * ── 5. 回读验证（A34 的核心，不可省）──
     *
     * `git worktree add` 退出码 0 **不等于**「目录现在能用」：
     * 目录可能建在别处、可能被外部立刻清掉、登记可能没写进去。
     * 三项都要回读，任一不过就是失败——这里返回成功就是 A34 要抓的那个 bug。
     */
    const dirOk = existsSync(rec.path)
    const head = await runGitRaw(rec.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const headOk = head.code === 0 && head.stdout.trim() === rec.branch
    const after = await listWorktrees(rec.repoRoot)
    const regOk = hasWorktreeEntry(after, rec.path)

    if (!dirOk || !headOk || !regOk) {
      const why: string[] = []
      if (!dirOk) why.push('目录不存在')
      if (!headOk) why.push(`HEAD 不在 ${rec.branch}（实际 ${head.stdout.trim() || '读不出'}）`)
      if (!regOk) why.push('git 登记里没有这条')
      return {
        ok: false,
        reason: 'verify-failed',
        message: `重建后核对不通过：${why.join('；')}`,
        path: rec.path,
        branch: rec.branch,
        verified: false,
        warnings
      }
    }

    // 体积缓存要失效：目录是新建的，旧缓存要么是 0 要么是删除前的值，都不可信
    invalidateSize(rec.path)
    publishWorktreeChanged()

    return {
      ok: true,
      path: rec.path,
      branch: rec.branch,
      verified: true,
      warnings
    }
  })
}

/**
 * 把**已有**分支检出到指定路径。
 *
 * 与 `addWorktree`（`git-worktree.ts`）的区别只有一点：不带 `-b`。
 * 那个函数用于创建（新建分支），这里用于重建（分支已存在）。**不要合并成一个带可选 `-b` 的函数**：
 * 两者的前置条件互斥，合成一个就得靠布尔参数区分，而「该不该新建分支」正是最容易传错的那个参数。
 */
async function addWorktreeExistingBranch(
  repoRoot: string,
  path: string,
  branch: string
): Promise<{ ok: boolean; stderr: string }> {
  const r = await runGitRaw(repoRoot, ['worktree', 'add', path, branch])
  return { ok: r.code === 0, stderr: r.stderr.trim() }
}
