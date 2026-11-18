/**
 * worktree 列表的视图类型（渲染层侧声明）。
 *
 * ## 为什么不从 `shared/worktree-protocol.ts` import
 *
 * `shared/` 里目前只有创建流程的协议（precheck / create / brief）。列表快照的完整形状
 * （state / deps / sessionCount / sizeBytes / lockHolder / mergeGate）由主进程侧在 T1.2 里补。
 * 两边同时开工时，渲染层不能等 shared 定稿才能写——但也不能各自拍一份形状。
 *
 * 这份类型的依据是 spec §7.5 与 §9.3 里逐字段写明的 `WorktreeView` / `WorktreeSnapshot`，
 * **逐字段照抄，不增不减**。等 shared 侧落地后应当改成 import，届时 typescript 会指出哪一边漂了。
 * 在那之前，契约由 `.deva/qa/check-worktree-view.cjs` 锁住：它比对这里与 spec 的字段名集合。
 */

/** 目录/登记/分支归属的健康度。**与「有没有会话」正交**（§2.5 / A54）。 */
export type WorktreeState = 'ok' | 'dir-missing' | 'prunable' | 'branch-mismatch'

/** 依赖安装状态（§2.2）。**
 * 注意：`skipped` 是「没有 lockfile，无需安装」，与 `ready` 同样可用，但文案不同。 */
export type DepsState = 'pending' | 'installing' | 'ready' | 'failed' | 'skipped'

/** `mergeGate.blocker` 的取值（§7.5）。主进程给，渲染层只用来选文案。 */
export type MergeBlocker = 'target-not-set' | 'source-missing' | 'source-branch-changed' | 'installing'

export interface WorktreeDetail {
  dirExists: boolean
  gitRegistered: boolean
  /** 实际 HEAD 分支；detached 时为 null。 */
  headBranch: string | null
  prunable: boolean
}

export interface WorktreeView {
  path: string
  compareKey: string
  repoRoot: string
  branch: string
  baseSha: string
  baseLabel: string
  /** 主目录 detached 时为 null（§3.1）。 */
  targetBranch: string | null
  createdAt: number
  state: WorktreeState
  /** `state` 不为 ok 时的补充事实，供 UI 直接显示，**不做推断**。 */
  detail: WorktreeDetail
  deps: DepsState
  depsDetail?: string
  /** 关联会话数：只统计主会话（`!parentId && focusRoot === path`），成员不计（§2.5）。 */
  sessionCount: number
  /** 未提交改动数；目录不存在时为 null。 */
  dirtyCount: number | null
  /** 磁盘占用；目录不存在或尚未统计时为 null（显示「统计中…」/「占用未知」）。 */
  sizeBytes: number | null
  /** 当前是否有 Deva 发起的 git 操作占用该路径。 */
  lockHolder: { label: string; since: number } | null
  /** target 检出里有未收尾的合并（§13.10）。非空时卡片显示「合并进行中」。 */
  mergeInProgress: { targetPath: string; unmergedCount: number } | null
  /** 合并可用性：**主进程算好的门**，渲染层不得自行推断（A48 / R13）。 */
  mergeGate: { mayMerge: boolean; blocker?: MergeBlocker }
}

export interface UnmanagedWorktree {
  path: string
  branch: string | null
  prunable: boolean
}

export interface WorktreeSnapshot {
  repoRoot: string
  /** 主检出分支；detached 时 null。 */
  primaryBranch: string | null
  worktrees: WorktreeView[]
  /** git 里登记了但不在 worktrees.json 里的路径：只读展示，不参与任何操作。 */
  unmanaged: UnmanagedWorktree[]
  /** 主仓库的项目记忆根（= repoRoot），用于文案「与主仓库共享记忆」。 */
  memoryRoot: string
}

/** `worktree:changed` 的 payload（§7.5）。故意不带快照：收到就重拉全量。 */
export interface WorktreeChangedEvent {
  repoRoot: string
}
