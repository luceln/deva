/**
 * preload：git worktree（并行工作区）通道。
 *
 * 独立成模块的原因：worktree 是二开独有功能（`main/services/worktree/` 一整套上游都没有），
 * 通道数又是 `preload/index.ts` 里最大的一块。搬出去后上游改动这个文件时不会再和它打架。
 */
import { ipcRenderer } from 'electron'
import type {
  WorktreeBriefView,
  WorktreeCreateFail,
  WorktreeCreateOk,
  WorktreeCreateReq,
  WorktreeInstallResult,
  WorktreePrecheckFail,
  WorktreePrecheckOk,
  WorktreePrecheckReq,
  WorktreeProgress,
  WorktreeMergeReq,
  WorktreeRemoveReq,
  WorktreeRemoveResult,
  WorktreeRebuildResult,
  WorktreeSetTargetReq,
  WorktreeSetTargetResult,
  WorktreeSizeUpdate,
  WorktreeSnapshot,
  MergeResult
} from '../shared/worktree-protocol'

/**
 * 工作区（git worktree，spec §1、§4）。
 *
 * 判定一律在主进程（`main/services/worktree/`），渲染层只消费结果——两套规则迟早漂移，
 * 而漂移的后果是静默的：界面说能建、主进程拒绝，或反过来。
 */
export const worktreeApi = {
  /** 创建前探测（**无副作用**：不建目录、不建分支、不写记录）。 */
  precheck: (req: WorktreePrecheckReq): Promise<WorktreePrecheckOk | WorktreePrecheckFail> =>
    ipcRenderer.invoke('worktree:precheck', req),
  /** 创建（Step 1 写意图 → Step 2 add → 失败清理 → Step 3 校验定稿）。 */
  create: (req: WorktreeCreateReq): Promise<WorktreeCreateOk | WorktreeCreateFail> =>
    ipcRenderer.invoke('worktree:create', req),
  /**
   * 全部已登记的工作区的**快照**（`state` / `deps` / `sessionCount` / `sizeBytes` / `lockHolder`
   * 都由主进程算好）。
   *
   * `sizeBytes` 首次可能是 null（后台统计中）：算完主进程会推 `onChanged`，届时重取即可。
   * 别在渲染层自己写「降级探测」——那只是 `onChanged` 没接上时的权宜，会让体积永远停在「统计中…」。
   */
  list: (): Promise<WorktreeSnapshot> => ipcRenderer.invoke('worktree:list'),
  /**
   * 删除一个工作区：解登记 → 删目录 → 删记录 → 删分支。
   *
   * 破坏性操作：`force` 会丢未提交改动，只有用户确认后才传。
   * 返回值里 `ok:true` 不代表全删干净（分支可能被别处检出而保留），**必须看 `warnings`**。
   */
  remove: (req: WorktreeRemoveReq): Promise<WorktreeRemoveResult> =>
    ipcRenderer.invoke('worktree:remove', req),
  /** 重建：目录被外部删掉后从原分支重新检出。成功与否由主进程回读核对，界面不自行判断。 */
  rebuild: (req: WorktreeRemoveReq): Promise<WorktreeRebuildResult> =>
    ipcRenderer.invoke('worktree:rebuild', req),
  /**
   * 合并（spec §4）。检查阶段**重新跑一遍**，不复用 `mergeDryRun` 的结论——
   * 两次之间用户可能清了改动、agent 也可能又提交了，复用旧结论等于跳过检查。
   *
   * `stashFirst` 是**用户在 C5 提示上显式选的**「先存起来再合并」：
   * 不传就绝不 stash（自动 stash 是明确禁止项）。走过时会带 `stash`（含 pop 是否冲突、
   * 哪些文件原本 staged 现在变回 unstaged）。
   *
   * 返回里 `ok:true` 但 `upToDate:true` 表示目标分支已包含全部提交（没有合并提交，别显示 SHA）。
   * `ok:false` 时 `message` 是 git 原文（**唯一不本地化**的字符串），`checks` 恒 4 项。
   */
  merge: (req: WorktreeMergeReq): Promise<MergeResult> =>
    ipcRenderer.invoke('worktree:merge', req),
  /**
   * 合并预检：只跑 C-1~C6，**不执行 merge、不加锁**（只读）。
   *
   * 用户点开合并面板时用它拿四项结果画四个圆点。`mergeAttempted` 恒 false；
   * 成功分支的 `upToDate` 已经判好，别自己从 `sourceSha` 推。
   */
  mergeDryRun: (req: WorktreeMergeReq): Promise<MergeResult> =>
    ipcRenderer.invoke('worktree:merge-dryrun', req),
  /**
   * 写回合并目标分支（C-1 的出口）：创建时主目录 detached → `targetBranch` 为 null，
   * 合并面板只出选择器。用户选一个**本地**分支后调这里，再重新走合并。
   *
   * 远端分支不能作目标：它没被检出，无法作为 merge 的 cwd。
   */
  setTarget: (req: WorktreeSetTargetReq): Promise<WorktreeSetTargetResult> =>
    ipcRenderer.invoke('worktree:set-target', req),
  /**
   * 安装依赖（「重试安装」/「重新安装」/「安装依赖」三个入口共用）。
   *
   * 立刻返回、不等安装完成（安装几分钟）：成功发起后进度走 `onProgress`，
   * 终态（ready / failed）等 `onChanged` 重取列表。
   */
  installDeps: (path: string): Promise<WorktreeInstallResult> =>
    ipcRenderer.invoke('worktree:install-deps', path),
  /** 某个 focusRoot 对应的边界信息；不是工作区则 null。只用于显示标签。 */
  brief: (focusRoot: string | null): Promise<WorktreeBriefView | null> =>
    ipcRenderer.invoke('worktree:brief', focusRoot),
  /**
   * 订阅「列表该重取了」。
   *
   * 主进程在会改变快照的任何事之后发它：依赖装完、`sizeBytes` 后台算完、创建/删除成功。
   * 少了它，`sizeBytes` 会永远停在 null（界面显示「统计中…」），用户以为体积算不出来。
   */
  onChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('worktree:changed', listener)
    return () => ipcRenderer.removeListener('worktree:changed', listener)
  },
  /**
   * 订阅「某个工作区的体积算好了」（增量）。
   *
   * 收到后按 `compareKey` 就地把那一条的 `sizeBytes` 补上，**不要重拉列表**——
   * 整表重拉一轮是 4N+1 次 git，后台逐步回填 N 个体积会让打开列表的开销翻倍。
   */
  onSize: (cb: (u: WorktreeSizeUpdate) => void): (() => void) => {
    const listener = (_e: unknown, u: WorktreeSizeUpdate): void => cb(u)
    ipcRenderer.on('worktree:size', listener)
    return () => ipcRenderer.removeListener('worktree:size', listener)
  },
  /** 订阅长操作进度（等锁超过 5 秒 / 依赖安装中）。 */
  onProgress: (cb: (p: WorktreeProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: WorktreeProgress): void => cb(p)
    ipcRenderer.on('worktree:progress', listener)
    return () => ipcRenderer.removeListener('worktree:progress', listener)
  }
}

export type WorktreeApi = typeof worktreeApi