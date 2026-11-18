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