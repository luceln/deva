import { mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import { writeFileAtomic } from './atomic-write'
import { getSession, save, verifyMemberBindingSnapshot, verifyMemberMirrorSaved, verifyMemberTransactionMarker, type StoredSession } from './chat-store'
export interface MemberWorktreeBindingSnapshot {
  focusRoot: string | null
  revision: number
  identity?: StoredSession['memberWorktreeIdentity']
  recovery?: StoredSession['memberWorktreeRecovery']
  mirrorRoot: string | null
}
export interface MemberWorktreeBindingTransaction {
  operationId: string
  attemptedRoot: string | null
  at: number
  phase: 'prepared' | 'committed'
  before: MemberWorktreeBindingSnapshot
  after: MemberWorktreeBindingSnapshot
}

export type MemberBindingWritePhase =
  | 'forward-sub' | 'forward-main' | 'rollback-sub' | 'rollback-main'
  | 'recover-sub' | 'recover-main' | 'begin-journal' | 'commit-journal'
let failureHook: ((phase: MemberBindingWritePhase, sessionId: string) => boolean) | undefined

/** 故障注入只在 QA 显式启用；true 表示跳过指定阶段的写盘。 */
export function setMemberBindingFailureHookForTest(
  hook?: (phase: MemberBindingWritePhase, sessionId: string) => boolean
): void { failureHook = hook }
function injectedFailure(phase: MemberBindingWritePhase, sessionId: string): boolean {
  return failureHook?.(phase, sessionId) === true
}

function safeId(id: string): string { return id.replace(/[^A-Za-z0-9_-]/g, '') }
function journalPath(sessionId: string): string {
  return join(getDevaHome(), 'data', 'chats', `.member-binding-${safeId(sessionId)}.json`)
}
export type MemberBindingJournalRead =
  | { status: 'absent' }
  | { status: 'ok'; transaction: MemberWorktreeBindingTransaction }
  | { status: 'corrupt' }
export function readMemberBindingTransaction(sessionId: string): MemberBindingJournalRead {
  try {
    const parsed = JSON.parse(readFileSync(journalPath(sessionId), 'utf8')) as MemberWorktreeBindingTransaction
    if (!parsed || typeof parsed.operationId !== 'string' || !parsed.before || !parsed.after ||
        (parsed.phase !== 'prepared' && parsed.phase !== 'committed')) return { status: 'corrupt' }
    return { status: 'ok', transaction: parsed }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'corrupt' }
    const embedded = getSession(sessionId)?.memberBindingTransaction
    if (!embedded) return { status: 'absent' }
    if (typeof embedded.operationId !== 'string' || !embedded.before || !embedded.after ||
        (embedded.phase !== 'prepared' && embedded.phase !== 'committed')) return { status: 'corrupt' }
    return { status: 'ok', transaction: embedded }
  }
}
// Journal filenames are keyed by session id; keep this wrapper explicit to avoid ever deriving a session from paths.
export function beginMemberBindingTransaction(sessionId: string, tx: MemberWorktreeBindingTransaction): boolean {
  if (injectedFailure('begin-journal', sessionId)) return false
  try {
    mkdirSync(join(getDevaHome(), 'data', 'chats'), { recursive: true })
    writeFileAtomic(journalPath(sessionId), JSON.stringify(tx, null, 2))
    return true
  } catch { return false }
}
export function commitMemberBindingTransaction(sessionId: string, tx: MemberWorktreeBindingTransaction): boolean {
  if (injectedFailure('commit-journal', sessionId)) return false
  tx.phase = 'committed'
  try { writeFileAtomic(journalPath(sessionId), JSON.stringify(tx, null, 2)); return true }
  catch { tx.phase = 'prepared'; return false }
}
function clearTransaction(sessionId: string): boolean {
  try { rmSync(journalPath(sessionId), { force: true }); return true } catch { return false }
}

function snapshotOf(s: StoredSession, mirrorRoot: string | null): MemberWorktreeBindingSnapshot {
  return { focusRoot: s.focusRoot ?? null, revision: s.memberBindingRevision ?? 0,
    identity: s.memberWorktreeIdentity, recovery: s.memberWorktreeRecovery, mirrorRoot }
}
function snapshotMatches(s: StoredSession, snap: MemberWorktreeBindingSnapshot): boolean {
  return verifyMemberBindingSnapshot(s.id, { focusRoot: snap.focusRoot, revision: snap.revision,
    identity: snap.identity, recovery: snap.recovery })
}
function restoreMemory(s: StoredSession, snap: MemberWorktreeBindingSnapshot): void {
  s.focusRoot = snap.focusRoot
  s.memberBindingRevision = snap.revision
  if (snap.identity) s.memberWorktreeIdentity = snap.identity; else delete s.memberWorktreeIdentity
  if (snap.recovery) s.memberWorktreeRecovery = snap.recovery; else delete s.memberWorktreeRecovery
  delete s.memberBindingTransaction
}

/** 写会话 JSON 后独立回读；save=false 可能仅因索引失败，不能误判JSON未提交。 */
function persistSub(s: StoredSession, snap: MemberWorktreeBindingSnapshot, phase: MemberBindingWritePhase): boolean {
  if (injectedFailure(phase, s.id)) return false
  save(s.id)
  return snapshotMatches(s, snap)
}
function persistMain(main: StoredSession, subId: string, snap: MemberWorktreeBindingSnapshot, phase: MemberBindingWritePhase): boolean {
  if (injectedFailure(phase, main.id)) return false
  save(main.id)
  return verifyMemberMirrorSaved(main.id, subId, snap.mirrorRoot)
}
function persistSnapshot(
  sub: StoredSession, main: StoredSession, subId: string,
  snap: MemberWorktreeBindingSnapshot, subPhase: MemberBindingWritePhase, mainPhase: MemberBindingWritePhase
): boolean {
  const childSaved = persistSub(sub, snap, subPhase)
  const mainSaved = persistMain(main, subId, snap, mainPhase)
  return childSaved && mainSaved
}

/** 恢复日志总是先核实两份磁盘快照；未能核实时调用者必须保持执行不可用。 */
export function recoverMemberBindingTransaction(sessionId: string): boolean {
  const journal = readMemberBindingTransaction(sessionId)
  if (journal.status === 'absent') return true
  if (journal.status === 'corrupt') return false
  const tx = journal.transaction
  const sub = getSession(sessionId)
  const main = sub?.parentId ? getSession(sub.parentId) : undefined
  if (!sub || !main || !main.members?.some((m) => m.sessionId === sessionId)) return false
  const desired = tx.phase === 'committed' ? tx.after : tx.before
  const currentChildMatches = snapshotMatches(sub, desired)
  const currentMirrorMatches = verifyMemberMirrorSaved(main.id, sessionId, desired.mirrorRoot)
  if (currentChildMatches && currentMirrorMatches) {
    delete sub.memberBindingTransaction
    save(sub.id)
    if (!verifyMemberTransactionMarker(sub.id, undefined)) return false
    return clearTransaction(sessionId)
  }

  // prepared/部分提交一律回到旧绑定；committed 若有任一侧不符也回滚到旧绑定。
  restoreMemory(sub, tx.before)
  const ref = main.members.find((m) => m.sessionId === sessionId)!
  ref.root = tx.before.mirrorRoot
  const restored = persistSnapshot(sub, main, sessionId, tx.before, 'recover-sub', 'recover-main')
  if (!restored) return false
  return clearTransaction(sessionId)
}

/** 当前内存值的 before/after 双份快照，用于会话与主名单的跨文件原子性。 */
export function makeMemberBindingSnapshot(s: StoredSession, mirrorRoot: string | null): MemberWorktreeBindingSnapshot {
  return snapshotOf(s, mirrorRoot)
}
export function bindingSnapshotMatches(s: StoredSession, snap: MemberWorktreeBindingSnapshot): boolean {
  return snapshotMatches(s, snap)
}
export function persistBindingSnapshot(
  sub: StoredSession, main: StoredSession, snap: MemberWorktreeBindingSnapshot,
  subPhase: MemberBindingWritePhase, mainPhase: MemberBindingWritePhase
): boolean {
  return persistSnapshot(sub, main, sub.id, snap, subPhase, mainPhase)
}
export function restoreBindingMemory(s: StoredSession, main: StoredSession, snap: MemberWorktreeBindingSnapshot): void {
  restoreMemory(s, snap)
  const ref = main.members?.find((m) => m.sessionId === s.id)
  if (ref) ref.root = snap.mirrorRoot
}
export function clearMemberBindingTransaction(sessionId: string): boolean { return clearTransaction(sessionId) }
export function hasUncertainMemberBinding(sessionId: string): boolean {
  return readMemberBindingTransaction(sessionId).status !== 'absent'
}
