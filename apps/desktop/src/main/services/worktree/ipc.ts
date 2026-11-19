import { ipcMain, type BrowserWindow } from 'electron'
import { createWorktree, precheck } from './create'
import { listWorktrees } from './list'
import { retryInstall } from './deps'
import { briefForFocusRoot } from './brief'
import { removeWorktree } from './remove'
import { mergeWorktree, setMergeTarget } from './merge'
import { onWorktreeChanged, onWorktreeProgress, onWorktreeSize } from '../chat-bus'
import type {
  WorktreeCreateReq,
  WorktreeMergeReq,
  WorktreePrecheckReq,
  WorktreeRemoveReq,
  WorktreeSetTargetReq
} from '../../../shared/worktree-protocol'

/**
 * worktree 的 IPC。
 *
 * 注册的通道：`precheck`（无副作用，边输边校验）、`create`、`list`、`install-deps`、`brief`、
 * `remove`、`merge`、`merge-dryrun`、`set-target`，外加两条**主进程 → 渲染层**的推送：
 * `worktree:changed`（列表该重取了）与 `worktree:progress`（等锁 / 装依赖 / 合并的进度）。
 * 重建仍留给后续步骤——**先不注册空壳**，免得渲染层对着不存在的实现写代码。
 *
 * 为什么 `remove` 排在 merge 之前：`deps.ts` 会真装 `node_modules`（几百 MB），没有删除能力时
 * 谁建的都删不掉，是「自动制造删不掉的大目录」。
 *
 * 判定一律在主进程（`list` 返回已算好的 `state`）：渲染层不复算，两套规则迟早漂移（A48）。
 */
export function registerWorktreeIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('worktree:precheck', (_e, req: WorktreePrecheckReq) => precheck(req))
  ipcMain.handle('worktree:create', (_e, req: WorktreeCreateReq) => createWorktree(req))
  /*
   * 快照：`state` / `deps` / `sessionCount` / `sizeBytes` / `lockHolder` 全在这里算好。
   * `sizeBytes` 首次为 null（后台统计中），算完会发 `worktree:size` 让界面增量更新（T1.4b）。
   */
  ipcMain.handle('worktree:list', () => listWorktrees())
  /*
   * 「重试安装」/「重新安装」/「安装依赖」三个入口共用一个通道（§2.2 的转移表）：
   * 三种状态下都进 `installing`，差别只在按钮文案。
   */
  ipcMain.handle('worktree:install-deps', (_e, path: string) => retryInstall(path))
  /*
   * 会话在 worktree 里跑时，渲染层要知道「这个 focusRoot 是哪个工作区」——**只用于显示标签**。
   * 判定（能不能建、state 是什么）一律在主进程做，渲染层不复算：两套规则迟早漂移。
   */
  ipcMain.handle('worktree:brief', (_e, focusRoot: string | null) => briefForFocusRoot(focusRoot))
  /*
   * 删除。`force` 会丢未提交改动，所以默认不带，只有用户在界面上确认过才传。
   * 返回值里必须看 `warnings`：删一半（比如分支被别处检出而保留）时 `ok` 仍可能是 true。
   */
  ipcMain.handle('worktree:remove', (_e, req: WorktreeRemoveReq) => removeWorktree(req))
  /*
   * 合并（spec §4 / §7.1）。加锁 `[repoRoot, sourcePath]`——真合并要写 `.git/` 共享区与 target 检出。
   * 检查阶段**重新跑一遍**、不复用 dryrun 的结果（§7.5）：两次之间用户可能清了改动、agent 也可能又提交了。
   */
  ipcMain.handle('worktree:merge', (_e, req: WorktreeMergeReq) =>
    mergeWorktree(req.path, { stashFirst: req.stashFirst === true })
  )
  /*
   * 预检：只跑 C-1~C6、不执行 merge、**不加锁**（只读，spec §7.1）。
   * 界面用它画四个圆点；`mergeAttempted` 恒 false。
   */
  ipcMain.handle('worktree:merge-dryrun', (_e, req: WorktreeMergeReq) =>
    mergeWorktree(req.path, { dryRun: true })
  )
  /*
   * 写回合并目标（C-1 的出口）。创建时主目录 detached → `targetBranch` 为 null，
   * 用户在合并面板选一个本地分支后调这里，再重新走合并。**不得由主进程自动挑一个**。
   */
  ipcMain.handle('worktree:set-target', (_e, req: WorktreeSetTargetReq) =>
    setMergeTarget(req.path, req.targetBranch)
  )

  /*
   * 把总线上的两条 worktree 事件转给渲染层。
   *
   * 为什么必须有这一段：`publishWorktreeChanged()` 只发在**主进程内部**的总线上，渲染层是
   * 另一个进程，不订阅它就永远收不到。少了这一段的表现是静默的——`sizeBytes` 后台算完了、
   * 界面却一直显示「统计中…」，因为没人告诉它该重取（这正是验收指出的那段「降级探测」）。
   *
   * 窗口可能已销毁（退出收尾 / 托盘驻留时窗口被关）：丢掉即可，绝不因 send 抛错打断发布方。
   */
  onWorktreeChanged(() => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    win.webContents.send('worktree:changed')
  })
  onWorktreeProgress((p) => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    win.webContents.send('worktree:progress', p)
  })
  /*
   * 体积回填走**增量**通道（`worktree:size`），不复用 `worktree:changed`：
   * 后者会让界面整表重拉，而重拉一轮就是 4N+1 次 git——后台逐步算完的 N 个体积会把
   * 「打开一次列表」的开销翻倍（实测 1.8 秒 → 3.6 秒）。这里只带变的那一个字段。
   */
  onWorktreeSize((u) => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    win.webContents.send('worktree:size', u)
  })
}