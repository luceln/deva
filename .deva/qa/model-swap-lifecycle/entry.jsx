import React, { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ModelPanel } from '../../../apps/desktop/src/renderer/src/redesign/ModelPanel'
import { ChatProvider, useChatState } from '../../../apps/desktop/src/renderer/src/store/chat'
import { ModelsProvider } from '../../../apps/desktop/src/renderer/src/store/models'
import { WorkspaceProvider } from '../../../apps/desktop/src/renderer/src/store/workspace'
import { I18nProvider } from '../../../apps/desktop/src/renderer/src/i18n/i18n'
import { ToastProvider } from '../../../apps/desktop/src/renderer/src/components/ToastProvider'
import { DialogProvider } from '../../../apps/desktop/src/renderer/src/components/DialogProvider'
import '../../../apps/desktop/src/renderer/src/styles/tokens.css'
import '../../../apps/desktop/src/renderer/src/styles/app.css'
import '../../../apps/desktop/src/renderer/src/redesign/redesign.css'

let root, host, trace, currentState
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const log = (event, data = {}) => trace.push({ event, ...data })
const wait = async (fn, name) => {
  const end = performance.now() + 6000
  while (!fn()) {
    if (performance.now() > end) throw new Error(`Timed out: ${name}`)
    await new Promise((r) => setTimeout(r, 15))
  }
  await frame()
}
const ref = (sessionId, name, model = 'fixture:old') => ({ sessionId, name, ref: model, kind: 'model-disabled' })
const broken = ref('s1', 'Main')
const snapshot = (stage) => {
  const data = {
    stage,
    brokenRefs: (currentState?.brokenModels.s1 ?? []).map((b) => b.ref),
    dialog: !!document.querySelector('.modal__card'),
    summary: document.querySelector('.cf-swap__result')?.textContent ?? null,
    rows: [...document.querySelectorAll('.cf-swap__row')].map((n) => n.textContent),
    toast: document.querySelector('.toast__msg')?.textContent ?? null
  }
  log('DOM', data)
  return data
}
function ObserveState() {
  const state = useChatState()
  currentState = state
  useLayoutEffect(() => {
    log('store committed', { sessionId: state.currentSessionId, brokenRefs: (state.brokenModels.s1 ?? []).map((b) => b.ref) })
  }, [state.currentSessionId, state.brokenModels])
  return null
}

/** All production providers and store actions are real. Only window.deva IPC is controlled. */
window.runSwapLifecycle = async (scenario = 'mixed', anotherBroken = false) => {
  if (root) flushSync(() => root.unmount())
  host?.remove()
  trace = []
  currentState = null
  const refresh = deferred(), scan = deferred()
  let applying = false, refreshReturned = false
  const failures = []
  const verify = (name, condition) => { if (!condition) failures.push(name); log(condition ? 'PASS' : 'FAIL', { name }) }
  const session = (model) => [{ id: 's1', title: 'Main', createdAt: 1, updatedAt: 2, model }]
  const result = scenario === 'mixed' ? {
    changed: [broken],
    skipped: [ref('s5', 'Kept')],
    failed: [ref('s4', 'Write failed')],
    indexStale: [ref('s2', 'Saved index pending')],
    superseded: [ref('s3', 'Changed meanwhile', 'fixture:other')]
  } : { changed: [broken], skipped: [], failed: [], indexStale: [], superseded: [] }
  const noopEvent = () => () => {}
  window.deva = {
    platform: 'win32',
    config: {
      getSync: () => ({ locale: 'en' }),
      get: async () => ({ models: {
        activeModelId: 'fixture:new', activeEffort: 'default',
        providers: [{ id: 'fixture', name: 'Fixture provider', enabled: true, adapter: 'openai', purpose: 'llm',
          apiHost: 'https://example.invalid', accent: 'var(--accent)', models: [
            { id: 'old', name: 'Old model', enabled: false },
            { id: 'new', name: 'Replacement model', enabled: true },
            { id: 'other', name: 'Current model', enabled: true }
          ] }]
      } }),
      set: async () => ({ ok: true }), onChanged: noopEvent
    },
    secrets: { list: async () => [], available: async () => true },
    chat: {
      listSessions: async () => {
        if (!applying) { log('IPC listSessions initial'); return session('fixture:old') }
        log('IPC listSessions waiting')
        await refresh.promise
        refreshReturned = true
        log('IPC listSessions returned')
        return session('fixture:new')
      },
      attachSession: async (sid) => { log('IPC attachSession', { sid }); return { messages: [], turnId: null, startedAt: null } },
      todos: async () => ({ active: null }),
      markRead: async () => ({ ok: true }),
      setModel: async () => ({ ok: true }),
      onEvent: noopEvent, onSessionsChanged: noopEvent, onRemoteChange: noopEvent,
      contextUsage: async () => ({ used: 100, estimated: true, window: 100000, trigger: 80000 }),
      blockedProviders: async () => [],
      scanModelSwap: async (request) => {
        if (!applying) { log('IPC scan initial', request); return [broken] }
        log('IPC scan waiting', request)
        await scan.promise
        log('IPC scan returned', { refs: anotherBroken ? ['fixture:another-broken'] : [] })
        return anotherBroken ? [ref('s1', 'Main', 'fixture:another-broken')] : []
      },
      applyModelSwap: async (request) => { log('IPC applyModelSwap returned', request); applying = true; return result }
    }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  flushSync(() => root.render(
    <I18nProvider><ToastProvider><DialogProvider><ModelsProvider><WorkspaceProvider><ChatProvider>
      <ObserveState /><ModelPanel />
    </ChatProvider></WorkspaceProvider></ModelsProvider></DialogProvider></ToastProvider></I18nProvider>
  ))
  await wait(() => currentState?.currentSessionId === 's1' && currentState?.brokenModels.s1?.length > 0, 'real scan loads broken')
  const chip = document.querySelector('.cf-mp__chip')
  if (!chip) throw new Error('Missing model chip')
  chip.click()
  await wait(() => document.querySelector('.modal__card [role=combobox]'), 'real chip opens dialog')
  const opened = snapshot('opened')
  document.querySelector('.modal__card [role=combobox]').click()
  await wait(() => document.querySelector('.select-menu__opt:not(.is-disabled)'), 'select options')
  const options = [...document.querySelectorAll('.select-menu__opt:not(.is-disabled)')]
  const replacement = options.find((n) => n.textContent.includes('Replacement model'))
  if (!replacement) throw new Error('Missing replacement fixture model')
  replacement.click()
  await frame()
  const apply = [...document.querySelectorAll('.modal__card button')].find((b) => b.textContent.trim() === 'Switch')
  if (!apply || apply.disabled) throw new Error('Switch action disabled')
  apply.click()
  await wait(() => applying && trace.some((e) => e.event === 'IPC listSessions waiting') && !currentState.brokenModels.s1, 'real action clears broken before refresh settles')
  const cleared = snapshot('broken-cleared-refresh-pending')
  verify('dialog stays mounted while real store clears broken and waits for refresh', cleared.dialog)
  refresh.resolve()
  await wait(() => refreshReturned && trace.some((e) => e.event === 'IPC scan waiting'), 'real action waits for rescan')
  const scanning = snapshot('rescan-pending')
  verify('dialog stays mounted until the rescan returns', scanning.dialog)
  scan.resolve()
  await wait(() => trace.some((e) => e.event === 'IPC scan returned'), 'rescan returned')
  await frame()
  const settled = snapshot('action-settled')
  verify('result summary stays visible after apply action resolves', !!settled.summary)
  verify('result uses the original request scope', trace.filter((e) => e.event === 'IPC applyModelSwap returned').length === 1 && trace.find((e) => e.event === 'IPC applyModelSwap returned').fromRef === 'fixture:old')
  if (scenario === 'mixed') {
    verify('saved-index-pending item is visible', settled.rows.some((s) => s.includes('Saved index pending') && s.includes('Saved')))
    verify('superseded item and its current model are visible', settled.rows.some((s) => s.includes('Changed meanwhile') && s.includes('Current model')))
    verify('write-failed item is visible', settled.rows.some((s) => s.includes('Write failed') && s.includes('Switch failed')))
    verify('skipped item count stays visible', settled.summary?.includes('1 skipped'))
  }
  const done = [...document.querySelectorAll('.modal__card button')].find((b) => b.textContent.trim() === 'Done')
  if (done) { done.click(); await frame() }
  const closed = snapshot('user-done')
  verify('user can close the result explicitly', !!done && !closed.dialog)
  const evidence = { scenario, anotherBroken, failures, opened, cleared, scanning, settled, closed, trace }
  window.swapLifecycleEvidence = evidence
  return evidence
}
