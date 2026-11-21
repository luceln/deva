/**
 * preload：原版 Deva（DevaPlus 的导入源）数据导入通道。
 *
 * 独立成模块的原因：这整块是二开独有功能（上游从来没有导入器），上游动 `preload/index.ts` 时
 * 与它无关。搬出去后合并冲突不再落在这个文件里，`index.ts` 只留一行展开。
 */
import { ipcRenderer } from 'electron'
import type { GateResult, ImportProgress, ImportReport } from '../shared/import-protocol'

/**
 * 从原版 Deva（~/.deva）导入数据：服务商 / 角色 / 记忆 / 技能 / 会话 / 附件。
 * 只补 DevaPlus 没有的，已存在的一律跳过 —— 天然幂等，点多少次结果一致；原版全程只读。
 * probe 用于按钮置灰（原版在跑 / 找不到源），run 返回逐条结果，onProgress 订阅长任务进度。
 */
export const importApi = {
  probe: (): Promise<GateResult> => ipcRenderer.invoke('import:probe'),
  run: (): Promise<ImportReport | { error: string }> => ipcRenderer.invoke('import:run'),
  /** 订阅 import:progress（附件上百 MB，靠事件推进度而不是轮询），返回取消订阅函数。 */
  onProgress: (cb: (p: ImportProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: ImportProgress): void => cb(p)
    ipcRenderer.on('import:progress', listener)
    return () => ipcRenderer.removeListener('import:progress', listener)
  }
}