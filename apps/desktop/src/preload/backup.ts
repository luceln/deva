/**
 * preload：备份包的导出 / 还原通道。
 *
 * 独立成模块的理由与 `import.ts` 一致：整块是二开独有功能，搬出去后上游动 `preload/index.ts`
 * 时不会在这些行上产生合并冲突。
 */
import { ipcRenderer } from 'electron'
import type { RestoreProgress } from '../shared/bundle-format'

/** 探包结果：界面据此决定要不要显示口令输入框。 */
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
  /** 导出。会先弹保存对话框；用户取消返回 `code: 'cancel-discard'`。 */
  export: (opts: { passphrase?: string }): Promise<unknown> => ipcRenderer.invoke('backup:export', opts),

  /** 选一个备份包并读出它的概况（不还原）。用户取消返回 `cancel-discard`。 */
  inspect: (): Promise<InspectResult> => ipcRenderer.invoke('backup:inspect'),

  /** 在真正还原前校口令，避免解压完几百 MB 才报错。 */
  checkPassphrase: (path: string, passphrase: string): Promise<{ ok: boolean; code?: string; noSecrets?: boolean; message?: string }> =>
    ipcRenderer.invoke('backup:check-passphrase', { path, passphrase }),

  /** 执行还原。`overwriteConfirmed` 为 false 且目标非空时返回 `cancelled`，界面应确认后重试。 */
  restore: (opts: { path: string; passphrase?: string; overwriteConfirmed?: boolean }): Promise<unknown> =>
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
