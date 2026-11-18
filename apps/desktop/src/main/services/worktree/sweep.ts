import { listRecords, removeRecord, upsertRecord, type WorktreeRecord } from './store'
import { cleanupFailedCreate } from './git-worktree'
import { withGitLock } from './lock'

/**
 * 启动清扫（崩溃恢复，spec §2.4）。
 *
 * 主进程启动、注册 worktree IPC **之前**跑一次。它要处理两种「上次没跑完」的残留：
 *
 * 1. `phase === 'creating'`：进程在建工作区中途被杀（Step 1 写了意图、Step 2/3 没跑完）。
 *    这些要按 §3.4 的清理算法**回滚掉**——`intent` 是判定「本次新建」的唯一凭据，
 *    绝不能因为「目录里现在有什么」去猜（那会把用户原本就有的目录判成本次新建）。
 * 2. `deps === 'installing'`：依赖装到一半进程就没了。改成 `failed` + `aborted-by-restart`，
 *    让界面能说清「为什么这一条停在中途」，而不是永远转圈。
 *
 * ## 明确不做的事
 *
 * - **不做任何 `git worktree prune`**（spec §2.4 第 4 条 / A33）：用户目录被外部删除后，
 *   那条登记是**用户资产的痕迹**，静默 prune 掉等于替用户做决定。`prunable` 只标记给用户看。
 *   （注意：§3.4 创建失败清理里那一条 prune 是允许的，两者不是同一件事——那里 prune 的是
 *   我们**自己刚创建、且已确认属于本次尝试**的登记。）
 * - **不删 worktrees.json**（第 1 条）：文件解析失败时只当空表用，文件原样留着等人工处理。
 *   删掉它就是销毁唯一能人工救回的东西。
 */

export interface SweepResult {
  /** 回滚掉的 creating 记录数。 */
  creatingRolledBack: number
  /** 回滚失败（保留记录等下次再试）的条数。 */
  creatingKept: number
  /** 改成 failed 的 installing 记录数。 */
  depsMarkedFailed: number
  warnings: string[]
}

/**
 * 执行一次清扫。**绝不抛错**：它在启动路径上，抛出去会让应用起不来。
 *
 * 返回结构化结果供日志与测试核对。
 */
export async function sweepOnStartup(): Promise<SweepResult> {
  const res: SweepResult = {
    creatingRolledBack: 0,
    creatingKept: 0,
    depsMarkedFailed: 0,
    warnings: []
  }
  let records: WorktreeRecord[]
  try {
    records = listRecords()
  } catch (e) {
    // store 自己已经把「读失败」记成 corrupt 并会拒绝写入；这里再兜一层，别让启动挂掉
    res.warnings.push(`读记录失败：${(e as Error)?.message ?? String(e)}`)
    return res
  }

  for (const rec of records) {
    // ── 建到一半的：按 §3.4 回滚 ──
    if (rec.phase === 'creating') {
      try {
        /*
         * 每条清扫单独持锁（`[repoRoot, path]`，与创建/删除同一对路径）。
         *
         * 为什么在**这里**加而不是 `cleanupFailedCreate` 内部：那个函数也被 `createWorktree` 在锁内调用，
         * 内部再加同一把锁就是死锁（§5.1 禁止嵌套）。所以锁只加在编排层——沿用到它的两个调用点各加各的。
         *
         * 用 `continue` 而不是整轮批量持锁：一条记录卡住不该把其余全堵住，
         * 且这里逐条处理本来就是串行的。
         */
        const cleanup = await withGitLock([rec.repoRoot, rec.path], 'prune', () =>
          cleanupFailedCreate({
            repoRoot: rec.repoRoot,
            path: rec.path,
            branch: rec.branch,
            // 唯一凭据：Step 0 的探测结果（崩溃恢复时 Step 0 早已不在内存里）
            intent: rec.intent
          })
        )
        // spec：清理成功或部分成功都删掉记录。只有「清理本身抛错」才保留。
        for (const w of cleanup.warnings) res.warnings.push(`[${rec.branch}] ${w}`)
        /*
         * 记录必须删掉，即便清理有 warning：留着它下次启动又会来清一遍，
         * 而它已经不可能变 active（创建意图从未完成）——留着只会让界面上多一条永远建不成的条目。
         * 真正的残留（删不掉的目录 / 分支）由 cleanup.warnings 记进日志，人工可查。
         */
        if (!removeRecord(rec.path)) {
          res.warnings.push(`[${rec.branch}] 记录删不掉（worktrees.json 写失败），下次启动再试`)
        }
        res.creatingRolledBack++
      } catch (e) {
        // 清理抛错 → 保留记录，下次启动再试（spec 明确要求）
        res.creatingKept++
        res.warnings.push(`[${rec.branch}] 清理失败，保留记录待下次启动：${(e as Error)?.message ?? String(e)}`)
      }
      continue
    }

    // ── 依赖装到一半的：改 failed，说明是重启中断 ──
    if (rec.deps === 'installing') {
      const next: WorktreeRecord = {
        ...rec,
        deps: 'failed',
        depsDetail: 'aborted-by-restart',
        depsUpdatedAt: Date.now()
      }
      if (upsertRecord(next)) res.depsMarkedFailed++
      else res.warnings.push(`[${rec.branch}] 依赖状态改写失败（worktrees.json 写不进）`)
    }
  }

  if (res.warnings.length) {
    console.warn('[worktree] 启动清扫有问题：', res.warnings.join('；'))
  }
  return res
}