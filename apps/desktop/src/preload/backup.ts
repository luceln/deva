/**
 * preload：备份包的导出 / 还原通道。
 *
 * 单独成模块的理由与 `import.ts` 一致：主功能不该为了加一组通道去改动 `preload/index.ts`
 * 里已经稳定的那部分。
 */
import { ipcRenderer } from 'electron'
import type { RestoreProgress } from '../shared/bundle-format'

/** 探包结果：界面据此展示「里面有什么」以及是否需要提示含密钥。 */
export type InspectResult =
  | {
      ok: true
      path: string
      exportedAt: string
      appVersion: string
      platform: string
      files: number
      bytes: number
      hasSecrets: boolean
      excluded: string[]
      symlinks: number
    }
  | { ok: false; code: string; message?: string }

export const backupApi = {
  /** 导出前先弹保存对话框；用户取消返回 `code: 'cancel-discard'`。 */
  export: (): Promise<unknown> => ipcRenderer.invoke('backup:export'),

  /** 选一个备份包，只读它的概览（不解压到磁盘）。用户取消返回 `cancel-discard`。 */
  inspect: (): Promise<InspectResult> => ipcRenderer.invoke('backup:inspect'),

  /** 执行还原。`overwriteConfirmed` 为 false 且目标非空时返回 `cancelled`，界面确认后可再调。 */
  restore: (opts: { path: string; overwriteConfirmed?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('backup:restore', opts),

  onExportProgress: (cb: (p: { step: string; done: number; total: number }) => void): (() => void) => {
    const l = (_e: unknown, p: { step: string; done: number; total: number }): void => cb(p)
    ipcRenderer.on('backup:export-progress', l)
    return () => ipcRenderer.removeListener('backup:export-progress', l)
  },

  onRestoreProgress: (cb: (p: RestoreProgress) => void): (() => void) => {
    const l = (_e: unknown, p: RestoreProgress): void => cb(p)
    ipcRenderer.on('backup:restore-progress', l)
    return () => ipcRenderer.removeListener('backup:restore-progress', l)
  }
}
