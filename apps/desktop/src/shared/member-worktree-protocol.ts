import type { WorktreeCreateReq, WorktreePrecheckOk } from './worktree-protocol'

/** 用户专用接口；不暴露给 create_member/member_send 工具。 */
export interface MemberWorktreeIdentity {
  checkoutRoot: string
  repoRoot: string
  branch: string
  relativePath: string
  /** 绑定前成员原本所在的目录（「返回原目录」要用它）。 */
  sourceRoot?: string
}

export interface MemberWorktreeRecovery extends MemberWorktreeIdentity {
  operationId: string
  expectedRevision: number
  sourceFocusRoot: string | null
  createdAt: number
  /** 先记创建意图再调用 Git；重启后通过登记与身份校验确认是否已创建。 */
  phase: 'intent' | 'creating' | 'created'
  reason: MemberWorktreeReason
}

export interface MemberWorktreeState {
  sessionId: string
  revision: number
  focusRoot: string | null
  identity?: MemberWorktreeIdentity
  pending: boolean
  recovery?: MemberWorktreeRecovery
  /** 会话记录的绑定与实际目录状态对不上（目录被移走、身份不符等）。
   *  为 true 时界面不能当作正常绑定继续操作，需走恢复流程。 */
  bindingInconsistent?: boolean
}

export type MemberWorktreeReason =
  | 'not-member' | 'member-removed' | 'busy' | 'pending' | 'stale'
  | 'source-unavailable' | 'dirty-confirmation-required' | 'create-failed'
  | 'binding-unreadable' | 'cancelled' | 'execution-root-missing'
  | 'identity-mismatch' | 'bind-write-failed' | 'recovery-not-found'
  | 'binding-uncertain' | 'invalid-request'
  /** 返回原目录时，原目录已不可用（被删、不再是同一个仓库、或身份对不上）。 */
  | 'original-unavailable'

export interface MemberWorktreePrecheckReq {
  sessionId: string
  expectedRevision: number
  /** 用户在确认框主动选择的源目录，可不同于当前 focusRoot；也允许首次未挂载成员提供。 */
  sourceRoot: string
  /** repoRoot 必须是 sourceRoot 所属 checkout 根；后端重新解析并核验，不信任客户端值。
   * relativePath 始终由后端从 sourceRoot 推导，不通过提前 setFocus 改绑来传递选择。 */
  create: WorktreeCreateReq
}
export interface MemberWorktreeBindReq extends MemberWorktreePrecheckReq {
  requestId: string
}
export interface MemberWorktreeCancelReq { sessionId: string; requestId: string }
export interface MemberWorktreeStateReq { sessionId: string }
export interface MemberWorktreeRetryBindReq {
  sessionId: string
  expectedRevision: number
  operationId: string
}
export interface MemberWorktreeReturnOriginalReq {
  sessionId: string
  expectedRevision: number
}
export type MemberWorktreeReturnOriginalResult = MemberWorktreeRejected | {
  ok: true
  revision: number
  focusRoot: string
}

export interface MemberWorktreeRejected {
  ok: false
  status: 'rejected'
  reason: MemberWorktreeReason
  message?: string
}
export type MemberWorktreePrecheckResult = MemberWorktreeRejected | {
  ok: true
  revision: number
  sourceFocusRoot: string
  sourceCheckoutRoot: string
  relativePath: string
  precheck: WorktreePrecheckOk
}
export type MemberWorktreeBindResult = MemberWorktreeRejected | {
  ok: true
  status: 'bound'
  revision: number
  checkoutRoot: string
  focusRoot: string
} | {
  ok: false
  status: 'created-unbound'
  reason: MemberWorktreeReason
  checkoutRoot: string
  operationId: string
  /** 持久化回读失败时为 null，不能伪报已恢复或旧绑定。 */
  binding: MemberWorktreeState | null
}
export type MemberWorktreeStateResult = MemberWorktreeRejected | { ok: true; state: MemberWorktreeState }
export type MemberWorktreeCancelResult = MemberWorktreeRejected | {
  ok: true
  /** false 表示没有匹配的进行中请求；取消不会撤销已经提交的绑定。 */
  cancelled: boolean
  state: MemberWorktreeState
}
