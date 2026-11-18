import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { getDevaHome } from '../config'
import { publishWorktreeChanged } from '../chat-bus'
import { repoKeyOf } from './paths'
import { upsertRecord, removeRecord, type WorktreeRecord } from './store'
import {
  precheck,
  nextFreeWorktreePath,
  type PrecheckFail,
  type PrecheckOk,
  type PrecheckRequest
} from './precheck'
import { addWorktree, cleanupFailedCreate, verifyWorktree } from './git-worktree'
import { withGitLock } from './lock'

/**
 * Step 1-3：创建主流程（spec §3.2-§3.5）。
 *
 * 每一步都可能是最后一步，所以**意图记录先写**（Step 1）：崩溃恢复靠它认出「有一条建了一半的」。
 * 任何一步失败都要走 §3.4 的清理，且清理失败**绝不能掩盖**创建失败的原因（§3.4 第 6 步）。
 */

export interface CreateRequest extends PrecheckRequest {
  /** 用户已确认「主目录有未提交改动」也要建（0.9 的 needsConfirm）。 */
  confirmedDirty?: boolean
}

export interface CreateOk {
  ok: true
  record: WorktreeRecord
}

export interface CreateFail {
  ok: false
  reason: string
  message: string
  /** 清理结果。创建失败的原因在 reason/message 里，这里只说明「有没有收拾干净」。 */
  cleanup?: {
    worktreeRemoved: boolean
    dirRemoved: boolean
    branchRemoved: boolean
    recordRemoved: boolean
    warnings: string[]
  }
}

/**
 * 创建一个工作区。
 *
 * **不抛错**：IPC 边界抛错会变成一句看不出原因的失败，而这里每一条失败都有明确分类。
 */
export async function createWorktree(req: CreateRequest): Promise<CreateOk | CreateFail> {
  // ── Step 0：探测（无副作用）──
  const pre = await precheck(req)
  if (!pre.ok) return { ok: false, reason: pre.reason, message: pre.message }
  // 0.9：脏改动需确认。这里再挡一次——界面可能没走弹窗直接调了 create
  if (pre.needsConfirm)
    return {
      ok: false,
      reason: 'needs-confirm',
      message: `主目录有 ${pre.dirtyCount} 处未提交改动，请先确认`
    }

  // 路径若与已有记录撞键，等价于「已存在」：0.7 已按文件系统判过，这里再按记录判一次
  const finalPath = pre.path

  /*
   * 从这里开始一律走 Git 锁（spec §5.2 的创建那一行：`[repoRoot, 目标 path]`）。
   *
   * **锁只包一层**：`addWorktree` / `cleanupFailedCreate` 内部都**不**再调 `withGitLock`——
   * 它们都在本函数的锁内执行，内层再加同一把锁就是死锁（§5.1 明令禁止嵌套）。
   */
  return withGitLock([pre.repoRoot, finalPath], 'create', () => doCreate(pre, finalPath))
}

/** 创建的实际步骤（Step 1-3）。**调用方必须已在 `[repoRoot, path]` 的锁内**。 */
async function doCreate(pre: PrecheckOk, finalPath: string): Promise<CreateOk | CreateFail> {

  /*
   * ── Step 1：写意图（phase: 'creating'）──
   *
   * 顺序不能颠倒：先落盘再动 git。这样「进程在 add 中途被杀」时，重启的清扫能凭 phase:'creating'
   * 找到它，并按 intent 精确判断该删什么。
   *
   * 落盘失败 → 直接失败，此时还没建分支、没建目录，**无副作用**（spec §3.2）。
   */
  const now = Date.now()
  const baseRecord: WorktreeRecord = {
    schemaVersion: 1,
    path: finalPath,
    compareKey: '', // upsertRecord 会归一化后填
    repoRoot: pre.repoRoot,
    repoKey: repoKeyOf(pre.repoRoot),
    branch: pre.branch,
    baseSha: pre.baseSha,
    baseLabel: pre.baseLabel,
    targetBranch: pre.targetBranch,
    createdAt: now,
    phase: 'creating',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'pending'
  }
  if (!upsertRecord(baseRecord))
    return {
      ok: false,
      reason: 'record-write-failed',
      message: '写不进工作区记录（worktrees.json），已中止，未创建任何东西'
    }

  // 父目录不存在时 git 会自己建，但「父目录本身」也要在受信根内（0.11 已登记）
  try {
    mkdirSync(dirname(finalPath), { recursive: true })
  } catch (e) {
    // 建父目录失败：还没建分支，清理只需要删记录
    const cleanup = await cleanupFailedCreate({
      repoRoot: pre.repoRoot,
      path: finalPath,
      branch: pre.branch,
      intent: baseRecord.intent
    })
    cleanup.recordRemoved = removeRecord(finalPath)
    return {
      ok: false,
      reason: 'mkdir-failed',
      message: `建不了工作区目录：${(e as Error)?.message ?? String(e)}`,
      cleanup
    }
  }

  /*
   * ── Step 2：git worktree add ──
   *
   * `cwd = repoRoot`（不是当前会话的 focusRoot）：A7 要求「永远从主检出取 HEAD」，
   * 从别处执行就可能造出 n 层单分支树。
   */
  const added = await addWorktree(pre.repoRoot, finalPath, pre.branch, pre.baseSha)
  if (!added.ok) {
    const cleanup = await cleanupFailedCreate({
      repoRoot: pre.repoRoot,
      path: finalPath,
      branch: pre.branch,
      intent: baseRecord.intent
    })
    cleanup.recordRemoved = removeRecord(finalPath)
    return {
      ok: false,
      reason: 'add-failed',
      message: `git worktree add 失败：${added.stderr || '未知错误'}`,
      cleanup
    }
  }

  // ── Step 3：校验与定稿 ──
  const verified = await verifyWorktree(finalPath, pre.baseSha, pre.branch)
  if (!verified.ok) {
    /*
     * 校验不符 → 清理 → 整体失败。
     * **不允许**「先成功再修正」（例如强行 reset 到 baseSha）——那是拿用户的钱包赌我们的实现正确。
     */
    const cleanup = await cleanupFailedCreate({
      repoRoot: pre.repoRoot,
      path: finalPath,
      branch: pre.branch,
      intent: baseRecord.intent
    })
    cleanup.recordRemoved = removeRecord(finalPath)
    return {
      ok: false,
      reason: 'verify-failed',
      message: `创建工作区后校验不符：${verified.why ?? '未知原因'}`,
      cleanup
    }
  }

  // 定稿：phase → active
  const finalRecord: WorktreeRecord = { ...baseRecord, phase: 'active' }
  if (!upsertRecord(finalRecord)) {
    // 记录写不进 → 清理 → 失败。理由：内存有、磁盘没有的记录会在重启后变成 unmanaged 孤儿（§3.5）
    const cleanup = await cleanupFailedCreate({
      repoRoot: pre.repoRoot,
      path: finalPath,
      branch: pre.branch,
      intent: baseRecord.intent
    })
    cleanup.recordRemoved = removeRecord(finalPath)
    return {
      ok: false,
      reason: 'record-write-failed',
      message: '工作区已建好但记录写不进磁盘，已回滚，避免重启后变成孤儿',
      cleanup
    }
  }

  // 让 worktree 列表刷新（§7.3）
  publishWorktreeChanged()
  return { ok: true, record: finalRecord }
}

/** 自动生成一个不撞的路径（供 IPC 层在未指定 path 时用）。 */
export function suggestPath(repoRoot: string, branch: string): string {
  const { slugifyBranch } = require('./paths') as typeof import('./paths')
  return nextFreeWorktreePath(repoRoot, slugifyBranch(branch || 'worktree'))
}

export { precheck }
export type { PrecheckFail, PrecheckRequest }
export { getDevaHome }