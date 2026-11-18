/**
 * worktree 的 IPC 协议类型（主进程 model-availability 式的「判定只在主进程」）。
 *
 * 渲染层只消费这些结果，不复算：两套规则迟早漂移，而漂移的后果是静默的
 * （界面说能建、主进程拒绝，或反过来）。
 */

/** 创建前探测的请求。 */
export interface WorktreePrecheckReq {
  repoRoot: string
  /** 起点。缺省 = 主目录此刻的 HEAD（**不是** `--abbrev-ref`，detached 下那是字面量 HEAD）。 */
  baseRef?: string
  branch?: string
  /** 省略 = 按 §6.1 自动生成（spec 空缺的补法，见 precheck.ts 的注释）。 */
  path?: string
  /** 用户在弹窗里确认了「主目录有未提交改动」也继续。 */
  confirmedDirty?: boolean
}

/** 创建请求（比探测多一个确认位）。 */
export interface WorktreeCreateReq extends WorktreePrecheckReq {
  /**
   * 用户勾了「不安装依赖」（spec §3.6）。
   *
   * 为 true 时 deps 直接落 `skipped`（`depsDetail: 'user-skipped'`），**不探测命令是否存在**——
   * 用户已经明确表示不要，再去 `pnpm --version` 是多余动作，而失败还要编个理由。
   */
  skipDeps?: boolean
}

/**
 * 探测成功的结果。
 *
 * 字段与 `precheck.ts` 的 `PrecheckOk` 一一对应；这里重新声明一份而不是 import：
 * `shared/` 不能依赖 `main/`（打包边界），两边的形状由测试锁住。
 */
export interface WorktreePrecheckOk {
  ok: true
  repoRoot: string
  defaultBase: string
  defaultBaseLabel: string
  baseSha: string
  baseLabel: string
  /** null = 主目录 detached，尚未指定合回目标（§3.1 的 0.3）。 */
  targetBranch: string | null
  primaryDetached: boolean
  mergeTargetWarning?: string
  path: string
  branch: string
  slug: string
  dirtyCount: number
  needsConfirm: boolean
  softWarn?: 'many-worktrees'
  existingCount: number
}

export type WorktreePrecheckReason =
  | 'not-a-repo'
  | 'bad-base'
  | 'bad-branch'
  | 'branch-exists'
  | 'path-exists'
  | 'path-too-long'
  | 'path-inside-repo'
  | 'slug-collision'
  | 'no-git'
  | 'error'

export interface WorktreePrecheckFail {
  ok: false
  reason: WorktreePrecheckReason
  /** 给人看的原因（主进程按界面语言出）。 */
  message: string
  /** 可执行的替代（如 branch-exists 时给自动后缀）。 */
  suggestion?: string
}

export interface WorktreeCreateOk {
  ok: true
  record: unknown
}

export interface WorktreeCreateFail {
  ok: false
  reason: string
  message: string
  /** 清理结果：创建为什么失败看 reason/message，这里只说明有没有收拾干净。 */
  cleanup?: {
    worktreeRemoved: boolean
    dirRemoved: boolean
    branchRemoved: boolean
    recordRemoved: boolean
    warnings: string[]
  }
}

/** 会话挂在独立工作区里时，给界面显示标签用。 */
export interface WorktreeBriefView {
  path: string
  branch: string
  targetBranch: string | null
  baseLabel: string
  repoRoot: string
  /** 主目录未提交改动数；与创建弹窗里显示的是同一个数字（A17/A36 要求同源）。 */
  primaryDirtyCount: number
}
/**
 * `worktree:list` 的返回值（快照）。
 *
 * `state` 由主进程算好，渲染层**只消费不复算**（A48）：两套规则迟早漂移，而漂移的表现是静默的——
 * 界面显示「可合并」，点下去必失败。
 */
export type WorktreeState = 'ok' | 'branch-mismatch' | 'dir-missing' | 'prunable'

export interface WorktreeListItem {
  path: string
  compareKey: string
  repoRoot: string
  branch: string
  baseSha: string
  baseLabel: string
  targetBranch: string | null
  createdAt: number
  state: WorktreeState
  /** `branch-mismatch` 时的实际 HEAD 分支名（detached 时为 'HEAD'）。 */
  actualBranch?: string
  deps: 'pending' | 'installing' | 'ready' | 'failed' | 'skipped'
  depsDetail?: string
  /** 关联会话数（`focusRoot` 指向本路径的会话数）。 */
  sessionCount: number
  /** 目录体积；null = 还在统计（界面显示「统计中…」）。 */
  sizeBytes: number | null
  /** 当前持锁者（另一个会话正在这个目录上跑 git 操作）。 */
  lockHolder: { label: string; since: number } | null
}

/** 不受本功能管理的 git 登记项：只读展示，不参与任何操作。 */
export interface UnmanagedWorktree {
  path: string
  branch?: string
  head?: string
  prunable?: boolean
}

export interface WorktreeSnapshot {
  items: WorktreeListItem[]
  unmanaged: UnmanagedWorktree[]
  /** 记录文件本身读坏了：`items` 为空**不代表没有工作区**，界面要提示「记录读不出」。 */
  storeUnreadable: boolean
}

/** 依赖安装的结果（`worktree:install-deps`）。 */
export interface WorktreeInstallResult {
  ok: boolean
  /** 失败原因：`not-found` / `already-installing` / `no-lockfile` / `unsupported-language` / `write-failed`。 */
  reason?: string
  deps?: WorktreeListItem['deps']
}

/**
 * worktree 长操作的进度（`worktree:progress` 推送）。
 *
 * - `waiting-lock`：等 Git 锁超过 5 秒（spec §5.1 第 7 条 / B6）。
 * - `install-deps`：依赖安装进行中（spec §3.6 / B4）。
 */
export type WorktreeProgress =
  | {
      phase: 'waiting-lock'
      holder: { label: string; since: number } | null
    }
  | {
      phase: 'install-deps'
      path: string
      step: string
      elapsedMs: number
    }
