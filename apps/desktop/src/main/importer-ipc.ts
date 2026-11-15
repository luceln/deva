import { ipcMain, type BrowserWindow } from 'electron'
import { canImport } from './importer-gate'
import { runImport } from './importer'
import type { GateResult, ImportProgress, ImportReport } from '../shared/import-protocol'

/**
 * 导入的两个 IPC 通道。
 *
 * - `import:probe`：闸门 + 原版数据概况。只读，用于界面置灰按钮、显示「将导入什么」。
 * - `import:run`：真正执行，返回完整报告。
 *
 * 为什么不塞进启动流程：需求明确是**手动触发**。导入要动用户数据、搬上百 MB，不能在用户不知情时发生。
 *
 * 进度用 `webContents.send('import:progress')` 推，**不用轮询**：附件那一步上百 MB，轮询既费事又拿不到中间态。
 *
 * 暴露面：只有这两个通道。原版路径只在主进程内部拼，渲染层永远拿不到可写句柄，也没有任何「写原版」的通道。
 */

/** 进度事件的最小间隔（毫秒）。 */
const PROGRESS_THROTTLE_MS = 100

/**
 * 进度节流：附件那一步是「每个 blob 报一次」，361 个文件就是 361 次 IPC，渲染层会被淹没。
 * 走「每 100ms 最多一次 + 最后一次必发」，既能平滑推进度条，也不会丢掉 100%（丢最后那次会让进度条永远差一截）。
 *
 * 换步骤时立即发（不受节流限制）：步骤名是界面判断「现在在做什么」的唯一依据，晚 100ms 没意义。
 */
function throttledSend(send: (p: ImportProgress) => void): (p: ImportProgress) => void {
  let lastAt = 0
  let lastStep = ''
  let pending: ImportProgress | null = null
  let timer: NodeJS.Timeout | null = null

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

  return (p: ImportProgress): void => {
    // 换步骤 / 收尾：立即发
    if (p.step !== lastStep || p.step === 'done') {
      pending = p
      flush()
      return
    }
    // 同一步骤内且到了总数：最后一次必发（进度条要能走到头）
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
    // 还没到间隔：留一份最新的，到点发（不累积队列，只保留最新态）
    if (!timer) {
      timer = setTimeout(flush, PROGRESS_THROTTLE_MS)
      timer.unref?.()
    }
  }
}

export function registerImportIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('import:probe', (): Promise<GateResult> => canImport())

  ipcMain.handle('import:run', async (): Promise<ImportReport | { error: string }> => {
    const send = throttledSend((p) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('import:progress', p)
    })
    return runImport(send)
  })
}
