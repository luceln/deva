/**
 * importBridge 的桩：把「原版就绪 + 一份受控报告」直接喂给 ImportPane。
 *
 * 真实桥要 `window.deva.import.probe/run` 一整套 IPC，本用例要验的是**报告的呈现**
 * （unrecoverable 用警告、rekeyed 出现在成功面板），与 IPC 无关 → 整模块替换。
 *
 * 外部通过 `window.__setReport(report)` 换报告并重跑一次「开始导入」，即可让结果区出现。
 */
const state = {
  report: null,
  gate: {
    ok: true,
    sourceHome: 'C:\\Users\\demo\\AppData\\Roaming\\Deva',
    summary: {
      sessions: 3,
      compacted: 0,
      memberSessions: 0,
      providers: 2,
      personas: 1,
      memories: 0,
      skills: 0,
      media: 0,
      checkpoints: 0,
      subagents: 0,
      toolResults: 0,
      projects: 0
    }
  }
}

const listeners = new Set()
window.__setReport = (report) => {
  state.report = report
  for (const l of listeners) l()
}
window.__readyPromise = () => Promise.resolve()

export function isImportAvailable() {
  return true
}

export function probeImport() {
  return Promise.resolve(state.gate)
}

export function runImport() {
  // 让测试可以等「结果区出现」：报告在下一拍给出，模拟真实的异步。
  return Promise.resolve(state.report ?? { error: 'no report set' })
}

export function onImportProgress() {
  return () => undefined
}
