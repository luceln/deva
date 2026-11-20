import { statSync, realpathSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { runGitRaw } from './git'
import { getSession, listSessions } from './chat-store'
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

/** 终端旧接口只有 cwd：同路径绑定的成员也必须核实，不能绕过身份守卫。 */
export async function assertMemberTerminalDirectory(root: string | null, sessionId?: string): Promise<void> {
  if (sessionId) await assertMemberExecution(sessionId, root)
  if (!root) return
  validExecutionDirectory(root)
  for (const meta of listSessions()) {
    const s = getSession(meta.id)
    if (s?.parentId && s.focusRoot && resolve(s.focusRoot) === resolve(root))
      await assertMemberExecution(s.id, root)
  }
}
