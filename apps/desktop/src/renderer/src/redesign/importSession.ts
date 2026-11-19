/**
 * 「设置 › 导入」的运行态：**跨 ImportPane 挂载存活**。
 *
 * 为什么不住在 ImportPane 里：设置面板按 `section` 条件渲染，切到「模型」页时
 * `ImportPane` 被卸载、局部 state 全清空。用户点「去设置 › 模型重填」处理完再切回来，
 * 刚跑完的那份报告（哪些失败了、要重填哪几条密钥）就没了——报告本身就是用户下一步的行动清单。
 *
 * 所以状态提到模块级：
 *  - 报告、失败展开态、整轮错误、阶段、进度 —— 都留在这里，卸载再挂载照样读得到；
 *  - **不落盘**：用户选的是「提到父层」。关掉应用可以丢，切页面不能丢；
 *  - `phase === 'running'` 时卸载，运行**不中断**：ImportPane 一卸载就 aliveRef 归 false，
 *    原来那份实现会在跑完之后把结果直接丢掉（`if (!aliveRef.current) return`）。这里改成
 *    运行结果一律落进本模块，界面回来时自然看到。
 *
 * 状态变化用 `subscribe` 广播：ImportPane 挂载时订阅。这比把一堆 setState 逐层传下来轻，
 * 也避免 SettingsPane 变成导入逻辑的宿主（它只该管页签）。
 */

import {
  isImportAvailable,
  onImportProgress,
  probeImport,
  runImport,
  type GateResult,
  type ImportProgress,
  type ImportReport
} from './importBridge'

/** 展开看明细的步骤（结果里「跳过了哪些」）。 */
export type RowStepKey = string

export type ImportPhase = 'idle' | 'running' | 'done'

export interface ImportSessionState {
  /** 闸门结果：null = 还没探测完。 */
  gate: GateResult | null
  probing: boolean
  phase: ImportPhase
  /** 长任务进度（附件上百 MB 时用）。 */
  progress: ImportProgress | null
  report: ImportReport | null
  /** 整轮没跑起来的原因（空串 = 没有）。 */
  runError: string
  /** 展开看明细的步骤。 */
  expanded: Set<RowStepKey>
  /** 失败清单是否展开成「全部」。 */
  failAll: boolean
  /**
   * 这一轮是否已在本次会话里跑过（不论成功失败）。
   * 用来区分「从没进来过」（首次进页要自动探测）与「跑过又切走再回来」（只恢复展示）。
   */
  touched: boolean
}

const initial = (): ImportSessionState => ({
  gate: null,
  probing: false,
  phase: 'idle',
  progress: null,
  report: null,
  runError: '',
  expanded: new Set(),
  failAll: false,
  touched: false
})

let state: ImportSessionState = initial()
const listeners = new Set<() => void>()

/** 进度事件的常驻订阅（模块级挂一次，不随 ImportPane 卸载而断）。 */
let unsubProgress: (() => void) | null = null

function emit(): void {
  for (const fn of listeners) fn()
}

function patch(next: Partial<ImportSessionState>): void {
  state = { ...state, ...next }
  emit()
}

/** 读当前快照（ImportPane 用 useSyncExternalStore 消费）。 */
export function getImportSession(): ImportSessionState {
  return state
}

export function subscribeImportSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 探一次闸门（只读）。已就绪时不再重复探——`刷新状态` 按钮要能主动重探，走 `probe(true)`。
 *
 * 为什么默认不重探：每次切回导入页都探测会打一次 IPC、又让概览数字闪一下；
 * 而闸门结论（原版在不在跑）在分钟级内不会变，用户真要更新会点「刷新状态」。
 */
export function probeImportGate(force = false): void {
  if (!isImportAvailable()) return
  if (!force && state.gate !== null) return
  patch({ probing: true })
  void probeImport().then((r) => {
    patch({ gate: r, probing: false })
  })
}

/**
 * 跑一轮导入。
 *
 * 与旧实现的差别：结果**不再看组件是否还活着**——跑完一律写进模块状态。
 * 用户切走再回来能看到完整报告，而不是「跑完了但什么都没显示」。
 */
export function runImportSession(): void {
  if (!isImportAvailable()) return
  if (state.phase === 'running') return
  if (state.gate?.ok !== true) return
  patch({
    phase: 'running',
    progress: null,
    report: null,
    runError: '',
    expanded: new Set(),
    touched: true
  })
  void runImport().then((r) => {
    if ('error' in r) {
      // 整轮没跑起来（闸门在 run 开头又拦了一次 / 已有导入在进行）：回到 idle 并把原因摆出来，
      // 而不是给一份空报告让人以为「什么都没导」。
      patch({ phase: 'idle', progress: null, runError: r.error })
      probeImportGate(true)
      return
    }
    patch({ report: r, phase: 'done', progress: null })
    probeImportGate(true)
  })
}

/** 展开 / 收起某一步的明细。 */
export function toggleImportStep(step: RowStepKey): void {
  const n = new Set(state.expanded)
  if (n.has(step)) n.delete(step)
  else n.add(step)
  patch({ expanded: n })
}

/** 失败清单展开 / 收起「全部」。 */
export function setImportFailAll(v: boolean): void {
  patch({ failAll: v })
}

/**
 * 订阅进度。挂载时调用（幂等：第二次不出第二个订阅）。
 * 走模块级而不在 ImportPane 里订阅，是为了「跑的过程中切走页面」也能继续收到进度。
 */
export function attachImportProgress(): void {
  if (unsubProgress || !isImportAvailable()) return
  unsubProgress = onImportProgress((p) => {
    // 只在跑的时候吃进度：跑完后残留的最后一拍不该覆盖已定格的界面。
    if (state.phase === 'running') patch({ progress: p })
  })
}

/**
 * 一键整理记忆跑完 / 记忆被改动后，把报告里那批记忆失败**重新对一遍**：
 * 条目已被删/合并掉的，从失败清单里摘掉；全摘干净了，失败区块自然消失。
 *
 * 为什么不重跑整个导入：重跑一遍是几十秒、还会覆盖用户刚整理好的结果；
 * 这里只是拿最新的记忆快照去核「这几条还在不在」，纯本地判断。
 */
export function dropResolvedMemoryFailures(remaining: Set<string>): void {
  if (!state.report) return
  const failed = state.report.memories.failed
  const kept = failed.filter((f) => remaining.has(f.id))
  if (kept.length === failed.length) return
  const next: ImportReport = {
    ...state.report,
    memories: { ...state.report.memories, failed: kept },
    // 顶层 failures 里还有一份副本（importer.ts 会把 memorie 的 failed 也 push 进去）。
    failures: state.report.failures.filter((f) => f.step !== 'memories' || remaining.has(f.id))
  }
  patch({ report: next })
}

/** 单元测试 / 调试用：把状态复位到初始（不影响已注册的订阅）。 */
export function __resetImportSession(): void {
  state = initial()
  emit()
}
