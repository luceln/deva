import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readFile } from 'fs/promises'
import { unzipSync } from 'fflate'
import { MANIFEST_NAME, SECRETS_ENC_NAME, type RestoreProgress } from '../shared/bundle-format'
import { exportBundle } from './services/bundle-export'
import { restoreBundle, RestoreError } from './services/bundle-import'
import { validateManifest } from './services/bundle-manifest'
import { summarizeExcluded } from './services/bundle-manifest'
import { acquireLock, releaseLock } from './importer-lock'
import { getDevaHome } from './services/config'

/**
 * 备份包的导出 / 还原通道。
 *
 * 与 `import:*` 并列而不是合并：两者语义不同（补缺 vs 复原），界面入口也分开。
 * 合并成一条会逼着两边都接受自己不用的状态码，最终受害的是错误提示的精确度。
 *
 * 锁复用 `importer-lock.ts`：导出读 home、还原写 home，都不该与「从原版导入」同时跑。
 * 一个进程在搬文件、另一个在整目录覆盖，结果是两边都写出半截数据。
 */

const PROGRESS_THROTTLE_MS = 100

function throttle<T extends { done: number; total: number; step: string }>(
  send: (p: T) => void
): (p: T) => void {
  let lastAt = 0
  let lastStep = ''
  let timer: NodeJS.Timeout | null = null
  let pending: T | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) return
    const p = pending
    pending = null
    lastAt = Date.now()
    lastStep = p.step
    send(p)
  }

  return (p: T): void => {
    // 换步骤 / 收尾立即发：步骤名是界面判断「在做什么」的唯一依据，晚 100ms 没意义
    if (p.step !== lastStep || p.step === 'done') {
      pending = p
      flush()
      return
    }
    const finished = p.total > 0 && p.done >= p.total
    if (finished) {
      pending = p
      flush()
      return
    }
    pending = p
    if (Date.now() - lastAt >= PROGRESS_THROTTLE_MS) {
      flush()
      return
    }
    if (!timer) {
      timer = setTimeout(flush, PROGRESS_THROTTLE_MS)
      timer.unref?.()
    }
  }
}

export function registerBackupIpc(getWindow: () => BrowserWindow | null): void {
  /** 导出：先弹保存对话框拿路径，再跑。 */
  ipcMain.handle(
    'backup:export',
    async () => {
      const win = getWindow()
      const stamp = new Date().toISOString().slice(0, 10)
      const picked = win
        ? await dialog.showSaveDialog(win, {
            title: '导出备份',
            defaultPath: `devaplus-backup-${stamp}.dbk`,
            filters: [{ name: 'DevaPlus 备份包', extensions: ['dbk'] }]
          })
        : { canceled: true, filePath: undefined }
      if (picked.canceled || !picked.filePath) return { ok: false, code: 'cancel-discard', message: '' }

      const lock = acquireLock(getDevaHome())
      if ('busy' in lock) {
        return {
          ok: false,
          code: 'busy',
          message: `已有导入 / 导出正在进行。若确认没有在跑，可删除锁文件后重试：${lock.busy}`
        }
      }
      try {
        const send = throttle<{ step: string; done: number; total: number }>((p) => {
          const w = getWindow()
          if (w && !w.isDestroyed()) w.webContents.send('backup:export-progress', p)
        })
        return await exportBundle({
          targetPath: picked.filePath,
          onProgress: (done, total) => send({ step: 'export', done, total })
        })
      } finally {
        releaseLock(getDevaHome(), lock.fd)
      }
    }
  )

  /**
   * 探包：用户选好文件后，先看看这是什么包、多大、里面有没有密钥。
   *
   * 为什么单独一条而不是让 `backup:restore` 自己去探：界面要在用户点「还原」**之前**
   * 就把包内容摆出来，让他知道这一下会拿回什么、覆盖多少 —— 而不是点完之后才看到摘要。
   */
  ipcMain.handle('backup:inspect', async () => {
    const win = getWindow()
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: '选择备份包',
          properties: ['openFile'],
          filters: [{ name: 'DevaPlus 备份包', extensions: ['dbk', 'zip'] }]
        })
      : { canceled: true, filePaths: [] as string[] }
    if (picked.canceled || !picked.filePaths?.length) return { ok: false, code: 'cancel-discard' }

    const p = picked.filePaths[0]
    try {
      const buf = await readFile(p)
      const entries = unzipSync(new Uint8Array(buf))
      const raw = entries[MANIFEST_NAME]
      if (!raw) return { ok: false, code: 'not-a-bundle', message: '这个包里没有 manifest.json，不是本应用导出的备份包' }
      const parsed = validateManifest(JSON.parse(Buffer.from(raw).toString('utf8')))
      if (!parsed.ok) return { ok: false, code: 'not-a-bundle', message: parsed.reason }
      const m = parsed.manifest
      return {
        ok: true,
        path: p,
        exportedAt: m.exportedAt,
        appVersion: m.appVersion,
        platform: m.platform,
        files: m.files.length,
        bytes: m.files.reduce((a, f) => a + f.size, 0),
        hasSecrets: m.hasSecrets && Boolean(entries[SECRETS_ENC_NAME]),
        excluded: m.excluded,
        symlinks: m.symlinks.length
      }
    } catch (e) {
      return {
        ok: false,
        code: 'not-a-bundle',
        message: `解不开这个文件（可能不是备份包，或已损坏）：${(e as Error)?.message ?? e}`
      }
    }
  })

  /** 还原：路径与确认由界面先问，这里只执行。 */
  ipcMain.handle(
    'backup:restore',
    async (_e, opts: { path: string; overwriteConfirmed?: boolean }) => {
      const lock = acquireLock(getDevaHome())
      if ('busy' in lock) {
        return {
          ok: false,
          code: 'busy',
          message: `已有导入 / 导出正在进行。若确认没有在跑，可删除锁文件后重试：${lock.busy}`
        }
      }
      try {
        const send = throttle<RestoreProgress>((p) => {
          const w = getWindow()
          if (w && !w.isDestroyed()) w.webContents.send('backup:restore-progress', p)
        })
        return await restoreBundle({
          bundlePath: opts.path,
          overwriteConfirmed: opts.overwriteConfirmed,
          onProgress: send
        })
      } finally {
        releaseLock(getDevaHome(), lock.fd)
      }
    }
  )
}

// 让未使用的导入不触发 lint（RestoreError 由 restoreBundle 内部使用并翻成结果码）
void RestoreError
void summarizeExcluded
