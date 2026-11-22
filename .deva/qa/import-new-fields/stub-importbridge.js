/**
 * importBridge 桩：把闸门固定为「原版就绪」，报告由用例经 window.__setReport 注入。
 *
 * 本用例验的是**报告里新字段的呈现**（pluginManaged / indexStale / superseded），与 IPC 无关，
 * 故整模块替换；报告形状仍照 shared/import-protocol.ts 与 shared/chat-protocol.ts 的真实定义。
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

export function isImportAvailable() {
  return true
}

export function probeImport() {
  return Promise.resolve(state.gate)
}

export function runImport() {
  return Promise.resolve(state.report ?? { error: 'no report set' })
}

export function onImportProgress() {
  return () => undefined
}