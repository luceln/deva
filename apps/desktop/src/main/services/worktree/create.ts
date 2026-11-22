import { mkdirSync, lstatSync } from 'fs'
import { randomUUID } from 'crypto'
import { runGitRaw } from '../git'
import { dirname } from 'path'
import { getDevaHome } from '../config'
import { publishWorktreeChanged } from '../chat-bus'
import { repoKeyOf, compareKeyOfPath } from './paths'
import { upsertRecord, removeRecord, getRecord, getStoreLoadState, listRecords, type WorktreeRecord } from './store'
import {
  precheck,
  nextFreeWorktreePath,
  type PrecheckFail,
  type PrecheckOk,
  type PrecheckRequest
} from './precheck'
import { addWorktree, cleanupFailedCreate, verifyWorktree } from './git-worktree'
import { withGitLock } from './lock'
import { startInstall } from './deps'

/**
 * Step 1-3：创建主流程（spec §3.2-§3.5）。
 *
 * 每一步都可能是最后一步，所以**意图记录先写**（Step 1）：崩溃恢复靠它认出「有一条建了一半的」。
 * 任何一步失败都要走 §3.4 的清理，且清理失败**绝不能掩盖**创建失败的原因（§3.4 第 6 步）。
 */

export interface CreateRequest extends PrecheckRequest {
  /** 用户已确认「主目录有未提交改动」也要建（0.9 的 needsConfirm）。 */
  confirmedDirty?: boolean
  /** 用户勾了「不安装依赖」（§3.6）：deps 直接落 skipped。 */
  skipDeps?: boolean
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
  const skipDeps = req.skipDeps === true
  await afterOuterPrecheckForTest?.()
  return withGitLock([pre.repoRoot, finalPath], 'create', async () => {
    // 锁外快照仅用于选锁键；锁内第一次写意图之前必须重验固定输入。
    const fresh = await precheck({ ...req, path: finalPath, branch: pre.branch })
    if (!fresh.ok) return { ok: false, reason: fresh.reason, message: fresh.message }
    if (fresh.needsConfirm)
      return { ok: false, reason: 'needs-confirm', message: '主目录状态已变化，请确认未提交改动' }
    if (compareKeyOfPath(fresh.repoRoot) !== compareKeyOfPath(pre.repoRoot) ||
        compareKeyOfPath(fresh.path) !== compareKeyOfPath(finalPath) || fresh.branch !== pre.branch)
      return { ok: false, reason: 'stale-precheck', message: '仓库或目标路径已变化，请重新创建' }
    if (getStoreLoadState() === 'corrupt' || getRecord(finalPath) || listRecords().some((r) =>
      compareKeyOfPath(r.repoRoot) === compareKeyOfPath(fresh.repoRoot) && r.branch === fresh.branch))
      return { ok: false, reason: 'record-exists', message: '工作区记录已存在或无法读取，未执行创建' }
    // 独立检查 git 登记；缺失目录的残留登记不能算可复用路径。
    const listed = await runGitRaw(fresh.repoRoot, ['worktree', 'list', '--porcelain', '-z'])
    if (listed.code !== 0)
      return { ok: false, reason: 'state-unreadable', message: '无法核实 Git 工作区登记' }
    const registered = listed.stdout.split('\0').some((line) =>
      (line.startsWith('worktree ') && compareKeyOfPath(line.slice(9)) === compareKeyOfPath(finalPath)) ||
      line === `branch refs/heads/${fresh.branch}`)
    const branchState = await runGitRaw(fresh.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${fresh.branch}`])
    if (branchState.code !== 1)
      return { ok: false, reason: 'branch-unavailable', message: '分支已存在或无法核实其状态' }
    if (registered)
      return { ok: false, reason: 'path-exists', message: '目标路径已有 Git 工作区登记' }
    return doCreate(fresh, finalPath, { skipDeps })
  })
}

/** 可控并发测试接缝：暂停在锁外预检通过后；生产默认无钩子。 */
let afterOuterPrecheckForTest: (() => Promise<void>) | undefined
export function setCreatePrecheckHookForTest(hook?: () => Promise<void>): void {
  afterOuterPrecheckForTest = hook
}

/** 创建的实际步骤（Step 1-3）。**调用方必须已在 `[repoRoot, path]` 的锁内**。 */
async function doCreate(
  pre: PrecheckOk,
  finalPath: string,
  opts: { skipDeps: boolean }
): Promise<CreateOk | CreateFail> {

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
    // 排他 mkdir 是路径归属的凭据；其他进程抢先占用时不能进入破坏性清理。
    mkdirSync(finalPath)
    const st = lstatSync(finalPath)
    baseRecord.intent.ownership = {
      token: randomUUID(), baseSha: pre.baseSha,
      dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs
    }
    if (!upsertRecord(baseRecord)) throw new Error('写入创建归属凭据失败')
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
  // CAS 创建分支，并写唯一 reflog 标记；仅 baseSha 相同不能证明是本请求创建的分支。
  const reserved = await runGitRaw(pre.repoRoot, [
    'update-ref', '--create-reflog', '-m', `deva-create:${baseRecord.intent.ownership!.token}`,
    `refs/heads/${pre.branch}`, pre.baseSha, '0'.repeat(40)
  ])
  const added = reserved.code === 0
    ? await addWorktree(pre.repoRoot, finalPath, pre.branch, pre.baseSha, true)
    : { ok: false, stderr: reserved.stderr || '分支已被其他请求占用' }
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

  /*
   * ── Step 4：依赖安装（§3.6，异步、可降级）──
   *
   * 放在最后、**不 await**：`pnpm install` 冷缓存要跑几分钟，等它就是让创建请求卡住（A27 要求
   * 「依赖装好之前不许当可用」——注意这条说的是**界面不能把没装好依赖的工作区当成可用**，
   * 而不是「创建要等安装完」。工作区本身已可用（能读代码、能开会话），只是依赖还没就位）。
   *
   * 失败只降级成 `deps:'failed'`，**不回滚 worktree**：用户可能已经在里面改文件了。
   */
  startInstall(finalRecord, { skipDeps: opts.skipDeps })

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