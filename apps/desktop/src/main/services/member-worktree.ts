import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'
import { lstatSync, realpathSync } from 'fs'
import { dirname, basename, join } from 'path'
import { getSession, save, verifyMemberBindingSaved } from './chat-store'
import { recoverMemberBindingTransaction } from './member-binding-transaction'
import { historyLocked } from './chat-state'
import { setMemberFolder } from './chat-members'
import { activeMember, pendingMemberBindings } from './member-binding-state'
import { validExecutionDirectory, verifyMemberWorktree } from './member-worktree-guard'
import { runGitRaw } from './git'
import { precheck } from './worktree/precheck'
import { createWorktree } from './worktree/create'
import { getRecord, getStoreLoadState } from './worktree/store'
import type {
  MemberWorktreeState, MemberWorktreeStateResult, MemberWorktreeRejected, MemberWorktreeReason,
  MemberWorktreePrecheckReq, MemberWorktreePrecheckResult, MemberWorktreeBindReq,
  MemberWorktreeBindResult, MemberWorktreeCancelReq, MemberWorktreeCancelResult,
  MemberWorktreeRetryBindReq, MemberWorktreeRecovery
} from '../../shared/member-worktree-protocol'

// 预检中的取消也必须生效，不能等 create 开始才识别；仅保存最近用户请求，避免无限增长。
const cancelledRequests = new Set<string>()
const requestKey = (sessionId: string, requestId: string): string => JSON.stringify([sessionId, requestId])

const reject = (reason: MemberWorktreeReason, message?: string): MemberWorktreeRejected =>
  ({ ok: false, status: 'rejected', reason, ...(message ? { message } : {}) })
const normalized = (p: string): string => {
  const value = resolve(realpathSync.native(p))
  return process.platform === 'win32' ? value.toLowerCase() : value
}
/** Resolve missing suffixes through the nearest existing ancestor; permission errors and dangling links throw. */
function inspectIntentPath(path: string): { absent: boolean; key: string } {
  let cursor = resolve(path)
  const suffix: string[] = []
  for (;;) {
    try { lstatSync(cursor) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const parent = dirname(cursor)
      if (parent === cursor) throw e
      suffix.unshift(basename(cursor))
      cursor = parent
      continue
    }
    const canonical = join(realpathSync.native(cursor), ...suffix)
    return { absent: suffix.length > 0, key: process.platform === 'win32' ? canonical.toLowerCase() : canonical }
  }
}

async function settleUnstartedIntent(sessionId: string,
  owner?: { requestId: string; cancelled: boolean }): Promise<boolean> {
  const s = getSession(sessionId)
  const recovery = s?.memberWorktreeRecovery
  if (!s || !recovery) return true
  const ownsIntent = (): boolean => {
    const member = activeMember(sessionId)
    return getSession(sessionId) === s && s.memberWorktreeRecovery === recovery &&
      pendingMemberBindings.get(sessionId) === owner && !owner?.cancelled &&
      !!member && !member.ref.removed && !historyLocked(sessionId) &&
      (s.memberBindingRevision ?? 0) === recovery.expectedRevision &&
      (s.focusRoot ?? null) === recovery.sourceFocusRoot
  }
  if (!ownsIntent()) return false
  if (recovery.phase === 'created') return true
  try {
    if (getStoreLoadState() === 'corrupt') return false
    const record = getRecord(recovery.checkoutRoot)
    if (record) {
      if (record.branch !== recovery.branch || normalized(record.repoRoot) !== normalized(recovery.repoRoot)) return false
      if (record.phase !== 'active') return false
      recovery.phase = 'created'
      recovery.checkoutRoot = record.path
      save(s.id)
      return verifyMemberBindingSaved(s)
    }
    const target = inspectIntentPath(recovery.checkoutRoot)
    if (!target.absent) return false
    const branch = await runGitRaw(recovery.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${recovery.branch}`])
    if (branch.code !== 1) return false
    const worktrees = await runGitRaw(recovery.repoRoot, ['worktree', 'list', '--porcelain', '-z'])
    if (worktrees.code !== 0 || worktrees.stdout.split('\0').some((field) =>
      field.startsWith('worktree ') && inspectIntentPath(field.slice('worktree '.length)).key === target.key)) return false
    // Git probes await: do not let cancellation, removal, rebinding or an old callback clear a newer intent.
    if (!ownsIntent() || getRecord(recovery.checkoutRoot) || !inspectIntentPath(recovery.checkoutRoot).absent) return false
    // Only clear the session intent. Never remove paths, branches, or worktree registrations here.
    delete s.memberWorktreeRecovery
    save(s.id)
    if (verifyMemberBindingSaved(s)) return true
    s.memberWorktreeRecovery = recovery
    return false
  } catch { return false }
}
/**
 * A newer intent owns the session: an older callback must discard its result instead of clearing,
 * rewriting, or downgrading that intent to pending. A cleared intent is not "newer" — plain rebinds
 * already delete it and late results must still report created-unbound/stale (see memberwt gate).
 */
function intentReplaced(sessionId: string, recovery: MemberWorktreeRecovery): boolean {
  const current = getSession(sessionId)?.memberWorktreeRecovery
  return !!current && current !== recovery
}

/** Both the current pending entry and the requestId must still be the ones this callback started with. */
function ownsOperation(sessionId: string, recovery: MemberWorktreeRecovery,
  operation: { requestId: string; cancelled: boolean }): boolean {
  const pending = pendingMemberBindings.get(sessionId)
  return !!pending && pending === operation && pending.requestId === operation.requestId &&
    !intentReplaced(sessionId, recovery)
}

function state(sessionId: string): MemberWorktreeState | null {
  const s = getSession(sessionId)
  if (!s?.parentId) return null
  return { sessionId, revision: s.memberBindingRevision ?? 0, focusRoot: s.focusRoot ?? null,
    identity: s.memberWorktreeIdentity,
    recovery: s.memberWorktreeRecovery, pending: pendingMemberBindings.has(sessionId) }
}
function eligibility(sessionId: string, revision: number): MemberWorktreeRejected | null {
  if (!recoverMemberBindingTransaction(sessionId)) return reject('binding-uncertain')
  const m = activeMember(sessionId)
  if (!m) return reject('not-member')
  if (m.ref.removed) return reject('member-removed')
  if ((m.sub.memberBindingRevision ?? 0) !== revision) return reject('stale')
  if (historyLocked(sessionId)) return reject('busy')
  return null
}

/** 预检显式 sourceRoot，不通过先改 focusRoot 传递用户选择。 */
export async function precheckMemberWorktree(req: MemberWorktreePrecheckReq): Promise<MemberWorktreePrecheckResult> {
  if (!req || typeof req.sessionId !== 'string' || !Number.isSafeInteger(req.expectedRevision) ||
      typeof req.sourceRoot !== 'string' || !isAbsolute(req.sourceRoot) || !req.create)
    return reject('invalid-request')
  const blocked = eligibility(req.sessionId, req.expectedRevision)
  if (blocked) return blocked
  if (pendingMemberBindings.has(req.sessionId)) return reject('pending')
  try {
    validExecutionDirectory(req.sourceRoot)
    const source = realpathSync.native(req.sourceRoot)
    const top = await runGitRaw(source, ['rev-parse', '--show-toplevel'])
    if (top.code !== 0) return reject('source-unavailable', top.stderr)
    const checkout = realpathSync.native(top.stdout.trim())
    if (normalized(req.create.repoRoot) !== normalized(checkout)) return reject('identity-mismatch')
    const relativePath = relative(checkout, source)
    if (relativePath === '..' || relativePath.startsWith('..\\') || relativePath.startsWith('../') || isAbsolute(relativePath))
      return reject('identity-mismatch')
    const checked = await precheck({ ...req.create, repoRoot: checkout })
    if (!checked.ok) return reject('create-failed', checked.message)
    return { ok: true, revision: req.expectedRevision, sourceFocusRoot: source,
      sourceCheckoutRoot: checkout, relativePath, precheck: checked }
  } catch (e) { return reject('source-unavailable', (e as Error).message) }
}

export async function memberWorktreeState(sessionId: string): Promise<MemberWorktreeStateResult> {
  await settleUnstartedIntent(sessionId)
  const snapshot = state(sessionId)
  return snapshot ? { ok: true, state: snapshot } : reject('not-member')
}

function unbound(sessionId: string, r: MemberWorktreeRecovery, reason: MemberWorktreeReason): MemberWorktreeBindResult {
  const s = getSession(sessionId)
  // A newer intent must never be rewritten by this older callback's result.
  if (intentReplaced(sessionId, r)) return reject('stale')
  let saved = false
  if (s) {
    s.memberWorktreeRecovery = { ...r, reason }
    save(s.id)
    saved = verifyMemberBindingSaved(s)
  }
  return { ok: false, status: 'created-unbound', reason: saved ? reason : 'bind-write-failed',
    checkoutRoot: r.checkoutRoot, operationId: r.operationId, binding: saved ? state(sessionId) : null }
}

/** 校验后到同步提交之间不 await，避免检查通过后起轮/改绑插入。 */
async function finishBinding(sessionId: string, recovery: MemberWorktreeRecovery,
  request?: { requestId: string; cancelled: boolean }): Promise<MemberWorktreeBindResult> {
  const focusRoot = resolve(recovery.checkoutRoot, recovery.relativePath)
  try {
    const rec = getRecord(recovery.checkoutRoot)
    if (!rec || rec.phase !== 'active' || rec.branch !== recovery.branch ||
        normalized(rec.repoRoot) !== normalized(recovery.repoRoot))
      return unbound(sessionId, recovery, 'identity-mismatch')
    await verifyMemberWorktree(recovery, focusRoot)
  } catch (e) {
    return unbound(sessionId, recovery, (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'execution-root-missing' : 'identity-mismatch')
  }
  const blocked = eligibility(sessionId, recovery.expectedRevision)
  if (blocked) return unbound(sessionId, recovery, blocked.reason)
  if (request && request.cancelled) return unbound(sessionId, recovery, 'cancelled')
  // A late success callback must not mutate a newer intent, but plain rebinds keep created-unbound.
  if (intentReplaced(sessionId, recovery)) return unbound(sessionId, recovery, 'stale')
  const s = getSession(sessionId)!
  if ((s.focusRoot ?? null) !== recovery.sourceFocusRoot) return unbound(sessionId, recovery, 'stale')
  setMemberFolder(s, focusRoot, {
    checkoutRoot: recovery.checkoutRoot,
    repoRoot: recovery.repoRoot,
    branch: recovery.branch,
    relativePath: recovery.relativePath
  })
  /*
   * 不再靠 `setMemberFolder` 的返回值判断成败——它现在只管落盘，不再自报结果。
   * 改为**回读磁盘**核对：绑定跨了多个文件（子会话的 focusRoot/identity + 主会话 members 里的 root），
   * 「函数没抛错」不代表两处都写对了。`verifyMemberBindingSaved` 读的就是盘上那份。
   */
  if (!verifyMemberBindingSaved(s)) return unbound(sessionId, recovery, 'bind-write-failed')
  return { ok: true, status: 'bound', revision: s.memberBindingRevision!, checkoutRoot: recovery.checkoutRoot, focusRoot }
}

export async function bindMemberWorktree(req: MemberWorktreeBindReq): Promise<MemberWorktreeBindResult> {
  if (!req || typeof req.requestId !== 'string' || !req.requestId.trim()) return reject('invalid-request')
  const checked = await precheckMemberWorktree(req)
  if (cancelledRequests.has(requestKey(req.sessionId, req.requestId))) return reject('cancelled')
  if (!checked.ok) return checked
  // 预检有异步窗口，取得 pending 前必须再次核验。
  const blocked = eligibility(req.sessionId, req.expectedRevision)
  if (blocked) return blocked
  if (pendingMemberBindings.has(req.sessionId)) return reject('pending')
  const s = getSession(req.sessionId)!
  if (s.memberWorktreeRecovery) {
    if (!await settleUnstartedIntent(s.id) || s.memberWorktreeRecovery)
      return reject('pending', '已有未完成或无法核实的工作区操作，请先恢复或处理，避免重复创建')
  }
  // Settlement also awaits Git; reacquire eligibility before taking ownership or creating assets.
  const afterSettlement = eligibility(req.sessionId, req.expectedRevision)
  if (afterSettlement) return afterSettlement
  if (pendingMemberBindings.has(s.id)) return reject('pending')
  if (cancelledRequests.has(requestKey(s.id, req.requestId))) return reject('cancelled')
  if (checked.precheck.needsConfirm) return reject('dirty-confirmation-required')
  const operation = { requestId: req.requestId, cancelled: false }
  const recovery: MemberWorktreeRecovery = {
    operationId: randomUUID(), expectedRevision: req.expectedRevision,
    sourceFocusRoot: s.focusRoot ?? null,
    createdAt: Date.now(), phase: 'intent', reason: 'create-failed',
    checkoutRoot: checked.precheck.path, repoRoot: checked.precheck.repoRoot,
    branch: checked.precheck.branch, relativePath: checked.relativePath
  }
  pendingMemberBindings.set(s.id, operation)
  s.memberWorktreeRecovery = recovery
  try {
    // 创建前先持久化意图：进程中断后可以在相同路径核实事实，不重复 create。
    // save=false 也可能仅代表索引失败；是否存在意图以会话JSON回读为准。
    save(s.id)
    if (!verifyMemberBindingSaved(s)) {
      delete s.memberWorktreeRecovery
      save(s.id)
      if (!verifyMemberBindingSaved(s)) s.memberWorktreeRecovery = recovery
      return reject('bind-write-failed')
    }
    if (operation.cancelled) return unbound(s.id, recovery, 'cancelled')
    const result = await createWorktree({ ...req.create, repoRoot: recovery.repoRoot,
      path: recovery.checkoutRoot, branch: recovery.branch, skipDeps: true })
    if (!ownsOperation(s.id, recovery, operation)) return reject('stale')
    if (!result.ok) {
      recovery.reason = 'create-failed'
      const record = getRecord(recovery.checkoutRoot)
      if (record?.phase === 'active') {
        recovery.phase = 'created'
        recovery.checkoutRoot = record.path
        save(s.id)
        if (!verifyMemberBindingSaved(s)) return unbound(s.id, recovery, 'bind-write-failed')
        return unbound(s.id, recovery, result.reason === 'needs-confirm' ? 'dirty-confirmation-required' : 'create-failed')
      }
      if (record?.phase === 'creating') return unbound(s.id, recovery, 'create-failed')
      // 创建接口失败可能已做过清理；仅在严格证实无登记/路径/分支时清意图，未知资产保留原样。
      if (!await settleUnstartedIntent(s.id, operation)) {
        if (!ownsOperation(s.id, recovery, operation)) return reject('stale')
        return unbound(s.id, recovery, 'create-failed')
      }
      return reject(result.reason === 'needs-confirm' ? 'dirty-confirmation-required' : 'create-failed', result.message)
    }
    recovery.phase = 'created'
    recovery.checkoutRoot = result.record.path
    return await finishBinding(s.id, recovery, operation)
  } catch (e) {
    // An old callback must not overwrite a newer operation, even when creation throws.
    if (!ownsOperation(s.id, recovery, operation)) return reject('stale')
    // 意外失败保留意图，state/retry-bind 走身份核实，绝不再建第二份。
    return unbound(s.id, recovery, 'create-failed')
  } finally {
    if (pendingMemberBindings.get(s.id) === operation) pendingMemberBindings.delete(s.id)
  }
}

export function cancelMemberWorktree(req: MemberWorktreeCancelReq): MemberWorktreeCancelResult {
  if (!req || typeof req.sessionId !== 'string' || typeof req.requestId !== 'string') return reject('invalid-request')
  const snapshot = state(req.sessionId)
  if (!snapshot) return reject('not-member')
  cancelledRequests.add(requestKey(req.sessionId, req.requestId))
  if (cancelledRequests.size > 256) cancelledRequests.delete(cancelledRequests.values().next().value!)
  const p = pendingMemberBindings.get(req.sessionId)
  const cancelled = !p || p.requestId === req.requestId
  if (cancelled && p) p.cancelled = true
  return { ok: true, cancelled, state: state(req.sessionId)! }
}

export async function retryMemberWorktreeBind(req: MemberWorktreeRetryBindReq): Promise<MemberWorktreeBindResult> {
  if (!req || typeof req.sessionId !== 'string' || typeof req.operationId !== 'string' ||
      !Number.isSafeInteger(req.expectedRevision)) return reject('invalid-request')
  const blocked = eligibility(req.sessionId, req.expectedRevision)
  if (blocked) return blocked
  if (pendingMemberBindings.has(req.sessionId)) return reject('pending')
  const recovery = getSession(req.sessionId)?.memberWorktreeRecovery
  if (!recovery || recovery.operationId !== req.operationId) return reject('recovery-not-found')
  // 旧 revision 不能由 retry 默默覆盖；用户需要重新选择/处理旧工作区。
  if (recovery.expectedRevision !== req.expectedRevision) return reject('stale')
  const operation = { requestId: req.operationId, cancelled: false }
  pendingMemberBindings.set(req.sessionId, operation)
  try { return await finishBinding(req.sessionId, recovery, operation) }
  finally { if (pendingMemberBindings.get(req.sessionId) === operation) pendingMemberBindings.delete(req.sessionId) }
}

export function registerMemberWorktreeIpc(): void {
  ipcMain.handle('chat:member-worktree-precheck', (_e, req: MemberWorktreePrecheckReq) => precheckMemberWorktree(req))
  ipcMain.handle('chat:member-worktree-bind', (_e, req: MemberWorktreeBindReq) => bindMemberWorktree(req))
  ipcMain.handle('chat:member-worktree-cancel', (_e, req: MemberWorktreeCancelReq) => cancelMemberWorktree(req))
  ipcMain.handle('chat:member-worktree-state', (_e, req: { sessionId: string }) => memberWorktreeState(req?.sessionId))
  ipcMain.handle('chat:member-worktree-retry-bind', (_e, req: MemberWorktreeRetryBindReq) => retryMemberWorktreeBind(req))
}
