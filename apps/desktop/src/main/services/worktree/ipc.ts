import { ipcMain } from 'electron'
import { createWorktree, precheck } from './create'
import { listRecords } from './store'
import { briefForFocusRoot } from './brief'
import type { WorktreeCreateReq, WorktreePrecheckReq } from '../../../shared/worktree-protocol'

/**
 * worktree 的 IPC。
 *
 * 本步只注册这几个：`precheck`（无副作用，供创建弹窗边输边校验）、`create`、`list`、`brief`。
 * 合并 / 删除 / 依赖安装留给后续步骤——**先不注册空壳**，免得渲染层对着不存在的实现写代码。
 */
export function registerWorktreeIpc(): void {
  ipcMain.handle('worktree:precheck', (_e, req: WorktreePrecheckReq) => precheck(req))
  ipcMain.handle('worktree:create', (_e, req: WorktreeCreateReq) => createWorktree(req))
  ipcMain.handle('worktree:list', () => listRecords())
  /*
   * 会话在 worktree 里跑时，渲染层要知道「这个 focusRoot 是哪个工作区」——**只用于显示标签**。
   * 判定（能不能建、state 是什么）一律在主进程做，渲染层不复算：两套规则迟早漂移。
   */
  ipcMain.handle('worktree:brief', (_e, focusRoot: string | null) => briefForFocusRoot(focusRoot))
}