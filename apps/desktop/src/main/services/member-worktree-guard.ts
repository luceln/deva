import { statSync, realpathSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { runGitRaw } from './git'
import { getSession } from './chat-store'
import { readMemberBindingTransaction, recoverMemberBindingTransaction } from './member-binding-transaction'
import { activeMember, pendingMemberBindings } from './member-binding-state'
import type { MemberWorktreeIdentity } from '../../shared/member-worktree-protocol'

function key(p: string): string {
  const path = resolve(realpathSync.native(p))
  return process.platform === 'win32' ? path.toLowerCase() : path
}
export function validExecutionDirectory(root: string): void {
  if (!statSync(root).isDirectory()) throw new Error('绑定的工作目录不是目录，请重新选择')
}

/** 校验只读，不 checkout、不修复路径，不回落到其他执行根。 */
export async function verifyMemberWorktree(identity: MemberWorktreeIdentity, focusRoot: string): Promise<void> {
  validExecutionDirectory(identity.checkoutRoot)
  validExecutionDirectory(focusRoot)
  const expected = resolve(identity.checkoutRoot, identity.relativePath)
  const rel = relative(key(identity.checkoutRoot), key(focusRoot))
  if (key(expected) !== key(focusRoot) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
    throw new Error('成员执行子目录与独立工作区身份不符')
  const top = await runGitRaw(identity.checkoutRoot, ['rev-parse', '--show-toplevel'])
  const common = await runGitRaw(identity.checkoutRoot, ['rev-parse', '--git-common-dir'])
  const repoCommon = await runGitRaw(identity.repoRoot, ['rev-parse', '--git-common-dir'])
  const branch = await runGitRaw(identity.checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (top.code !== 0 || common.code !== 0 || repoCommon.code !== 0 || branch.code !== 0 ||
      key(top.stdout.trim()) !== key(identity.checkoutRoot) ||
      key(resolve(identity.checkoutRoot, common.stdout.trim())) !== key(resolve(identity.repoRoot, repoCommon.stdout.trim())) ||
      branch.stdout.trim() !== identity.branch)
    throw new Error('成员独立工作区已失效：仓库、检出根或分支与绑定时不一致，请重新选择工作目录')
}

export async function assertMemberExecution(sessionId: string | undefined, executionRoot?: string | null): Promise<void> {
  if (!sessionId) return
  const session = getSession(sessionId)
  if (!session?.parentId) return
  const transaction = readMemberBindingTransaction(sessionId)
  if (transaction.status !== 'absent') {
    // 即使能成功恢复，也让当前起轮/工具失败；不能让触发恢复的旧上下文立刻派发。
    const recovered = recoverMemberBindingTransaction(sessionId)
    if (!recovered) throw new Error('成员目录绑定状态无法恢复核实，已停止执行；保留恢复日志，请处理后重试')
    throw new Error('成员目录绑定状态曾发生不一致，已拒绝本次执行；旧绑定已恢复，请重新发起')
  }
  const member = activeMember(sessionId)
  if (!member || member.ref.removed) throw new Error('成员已移除，不能继续执行')
  if (pendingMemberBindings.has(sessionId)) throw new Error('成员正在创建或绑定独立工作区，请稍后再执行')
  const root = session.focusRoot ?? null
  if (executionRoot !== undefined && executionRoot !== root)
    throw new Error('成员工作目录已变更，本轮仍持有旧目录，请重新发起任务')
  if (root) {
    try {
      validExecutionDirectory(root)
      if (session.memberWorktreeIdentity) await verifyMemberWorktree(session.memberWorktreeIdentity, root)
    } catch (e) {
      throw new Error(`成员绑定工作区不可用，不会回落其他目录：${(e as Error).message}`)
    }
  } else if (session.memberWorktreeIdentity) {
    throw new Error('成员独立工作区绑定不完整，请重新选择')
  }
}

/**
 * 终端只按显式所属会话校验；无 sessionId 的旧调用保留目录存在性校验，不扫描同路径的其他会话。
 *
 * `sessionId` 为什么仍可选（这是有意为之，不是漏改）：
 * - 唯一现有调用方是 `MergePanel` 的「在工作区开终端」——那是在 git worktree 里开，
 *   没有所属会话可传；
 * - 旧实现按 cwd 反查所有同路径的成员会话，每次建终端都要遍历全部会话，而且同一路径
 *   被多个会话共用时会误判。
 *
 * 代价要说清楚：**传了 sessionId 才有成员守卫**。将来给成员会话开终端时必须传，
 * 漏传则只剩目录存在性检查（不会报错，静默变弱）。为此 `TerminalCreateOptions.sessionId`
 * 的注释里写明了这条契约；`terminal.ts` 里也把取到的 sessionId 记进 executionRoots，
 * 让 dispose/写入路径复用同一个归属。
 */
export async function assertMemberTerminalDirectory(root: string | null, sessionId?: string): Promise<void> {
  if (sessionId) {
    const session = getSession(sessionId)
    if (!session) throw new Error('终端所属会话不存在，已停止创建')
    if (session.parentId) await assertMemberExecution(sessionId, root)
  }
  if (root) validExecutionDirectory(root)
}
