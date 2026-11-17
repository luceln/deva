/**
 * 「从原版 Deva 导入数据」的渲染层侧 IPC 桥。
 *
 * 类型全部来自 `shared/import-protocol.ts`（主进程 / preload / 渲染层三方共用），这里只再导出 + 兜错，
 * 免得调用方满仓库追 shared 的层级，也免得在渲染层另抄一份形状导致两边漂移。
 *
 * 通道只有两个，名字固定（主进程 importer-ipc.ts 注册）：
 *  - `import:probe`：查闸门 + 原版数据概览，决定按钮能否点、面板上显示什么数字。只读。
 *  - `import:run`  ：真正执行导入，返回 ImportReport（或 { error } 表示整轮没跑起来）。
 *  - `import:progress`：长任务（附件上百 MB）的进度推送。**用事件，不轮询**——轮询既拿不到阶段明细，
 *    又会在复制大目录时空转。
 *
 * 判定与闸门全部交给主进程：原版在不在跑是「独占打开 lockfile」的结论，渲染层复现不了也不该复现。
 */

import type { GateResult, ImportProgress, ImportReport } from '../../../shared/import-protocol'

export type {
  AssocReport,
  Failure,
  GateResult,
  ImportProgress,
  ImportReport,
  MergeStat,
  SecretsStat,
  SourceSummary,
  StepStat
} from '../../../shared/import-protocol'

/**
 * preload 把 `import` 挂在 window.deva 下（与 skills 同一层）。这里保持可选：
 * 旧版 preload 还没带这个通道时，界面应显示「还没接通」而不是崩在 undefined 上。
 */
interface ImportBridge {
  probe?: () => Promise<GateResult>
  run?: () => Promise<ImportReport | { error: string }>
  onProgress?: (cb: (p: ImportProgress) => void) => () => void
}

const bridge = (): ImportBridge => ((window.deva as unknown as { import?: ImportBridge })?.import ?? {})

/** 主进程是否已把导入通道接上（没接上时面板只说明一句，不摆点了没反应的按钮）。 */
export function isImportAvailable(): boolean {
  const b = bridge()
  return typeof b.probe === 'function' && typeof b.run === 'function'
}

/** 查闸门 + 概览。探测本身出错时折算成 no-source：拿不到结论就不能让用户以为可以导。 */
export async function probeImport(): Promise<GateResult> {
  const fn = bridge().probe
  if (!fn) return { ok: false, code: 'no-source', message: '' }
  try {
    return await fn()
  } catch (e) {
    return { ok: false, code: 'no-source', message: (e as Error)?.message ?? String(e) }
  }
}

/** 执行导入。抛错时折算成一份只有一条失败的报告，界面走同一套「失败可见」的展示。 */
export async function runImport(): Promise<ImportReport | { error: string }> {
  const fn = bridge().run
  if (!fn) return { error: 'import-unavailable' }
  try {
    return await fn()
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e) }
  }
}

/** 订阅进度事件，返回取消订阅函数（仿 skills.onChanged）。 */
export function onImportProgress(cb: (p: ImportProgress) => void): () => void {
  const fn = bridge().onProgress
  return fn ? fn(cb) : (): void => undefined
}
