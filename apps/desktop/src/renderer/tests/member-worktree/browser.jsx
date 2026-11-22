// Production component with controlled IPC boundaries, not an Electron/Git end-to-end test.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { I18nProvider } from '../../src/i18n/i18n'
import { DialogProvider } from '../../src/components/DialogProvider'
import { MemberWorktreePanel } from '../../src/redesign/MemberWorktreePanel'
import { MemberWorktreeDialog } from '../../src/redesign/MemberWorktreeDialog'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'

let root
let host
const tick = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const button = (text) => {
  const matches = [...document.querySelectorAll('button')].filter((el) => el.textContent.trim() === text)
  assert(matches.length === 1, `Expected one button: ${text}; found ${matches.length}`)
  return matches[0]
}
const click = async (text) => { button(text).click(); await tick() }
const toggle = async (selector) => {
  const input = document.querySelector(selector)
  assert(!!input, `Missing checkbox: ${selector}`)
  input.click()
  await tick()
}

window.runMemberWorktreeChecks = async (locale = 'en') => {
  const results = []
  const verify = (name, condition) => { assert(condition, name); results.push(name) }
  const labels = locale === 'en'
    ? { check: 'Check worktree', create: 'Create and use', choose: 'Choose folder…', folder: 'Use selected folder', retry: 'Retry binding' }
    : { check: '检查独立工作区', create: '创建并使用', choose: '选择目录…', folder: '使用所选目录', retry: '重试绑定' }
  const calls = { precheck: [], create: [], use: [], close: 0, retry: [] }
  let picker = null
  const target = {
    ok: true, repoRoot: 'E:/Canonical', defaultBase: 'main', defaultBaseLabel: 'main',
    baseSha: 'a'.repeat(40), baseLabel: 'main', targetBranch: 'main', primaryDetached: false,
    path: 'E:/Worktrees/member-1', branch: 'member-1', slug: 'member-1', dirtyCount: 2,
    needsConfirm: true, existingCount: 0
  }
  const checked = { ok: true, revision: 3, sourceRoot: 'E:/Canonical/packages/界面', sourceCheckoutRoot: 'E:/Canonical', relativePath: 'packages/界面', precheck: target }
  window.deva = {
    platform: 'win32', config: { getSync: () => ({ locale }), set: async () => {} },
    fs: { openFolder: async () => picker },
    git: { status: async (path) => ({ isRepo: path !== 'E:/plain', root: 'e:\\canonical', branch: 'main', staged: [], unstaged: [], conflicts: [] }) }
  }
  const props = {
    open: true, name: 'Renderer', sessionId: 'mem-real-1', expectedRevision: 3,
    busy: false, focusRoot: 'e:\\CANONICAL\\packages\\界面',
    onClose: () => { calls.close++ }, onBound: () => {},
    onUseDirectory: async (path) => { calls.use.push(path) },
    onPrecheck: async (draft) => { calls.precheck.push(draft); return checked },
    onCreateAndBind: async (draft) => { calls.create.push(draft); return { status: 'rejected', message: 'real IPC error' } },
    onRetryBind: async (...args) => { calls.retry.push(args); return { status: 'rejected', message: 'stale' } }
  }
  const mount = async (overrides = {}) => {
    if (root) flushSync(() => root.unmount())
    host?.remove()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    flushSync(() => root.render(<I18nProvider><DialogProvider><MemberWorktreePanel {...props} {...overrides} /></DialogProvider></I18nProvider>))
    await tick()
  }
  await mount()
  verify('independent mode defaults off', document.querySelectorAll('.cf-mwt__toggle input').length === 1 && !document.querySelector('.cf-mwt__toggle input').checked)
  await click(labels.choose)
  verify('picker cancellation preserves source without completing', document.querySelector('.cf-mwt__source code').textContent === props.focusRoot && !calls.close && !calls.use.length)
  await toggle('.cf-mwt__toggle input')
  verify('new branch is not copied from existing branch', document.querySelectorAll('.cf-mwt__grid input').length === 2 && document.querySelectorAll('.cf-mwt__grid input')[1].value === '')
  await click(labels.check)
  verify('precheck keeps the selected source and member identity', calls.precheck.length === 1 && calls.precheck[0].sessionId === props.sessionId && calls.precheck[0].sourceRoot === props.focusRoot)
  verify('canonical source and server relative path are displayed', document.querySelector('.cf-mwt__config').textContent.includes(checked.sourceRoot) && document.querySelector('.cf-mwt__config').textContent.includes(`${target.path}/packages/界面`))
  verify('server dirty result blocks creation even when git status was clean', button(labels.create).disabled)
  await toggle('.cf-mwt__dirty input')
  verify('canonicalization does not falsely block confirmed source', !button(labels.create).disabled)
  await click(labels.create)
  const draft = calls.create[0]
  verify('creation exactly matches canonical preview', calls.create.length === 1 && draft.sourceRoot === checked.sourceRoot && draft.create.repoRoot === checked.sourceCheckoutRoot && draft.create.path === target.path && draft.create.branch === target.branch && draft.create.baseRef === target.baseSha && draft.create.skipDeps === true)
  verify('failure preserves source, dirty acknowledgement and dialog', document.querySelectorAll('.cf-mwt').length === 1 && document.querySelector('.cf-mwt__dirty input').checked && !calls.close && document.querySelector('[role=alert]').textContent.includes('real IPC error'))
  await mount()
  await toggle('.cf-mwt__toggle input')
  await click(labels.check)
  await toggle('.cf-mwt__dirty input')
  let settle
  props.onCreateAndBind = async (request) => { calls.create.push(request); return new Promise((resolve) => { settle = resolve }) }
  // Remount with the pending operation callback before making a fresh preview.
  await mount()
  await toggle('.cf-mwt__toggle input')
  await click(labels.check)
  await toggle('.cf-mwt__dirty input')
  const before = calls.create.length
  button(labels.create).click()
  button(labels.create).click()
  await tick()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  verify('double click starts one request and Escape cannot dismiss it', calls.create.length === before + 1 && !calls.close && button(labels.create).disabled)
  settle({ status: 'created-unbound', recovery: { operationId: 'operation-1', sourceRoot: checked.sourceRoot, checkoutRoot: target.path, focusRoot: `${target.path}/packages/界面`, branch: target.branch, message: 'bind-write-failed' } })
  await tick()
  verify('created-unbound disables choosing another source', button(labels.choose).disabled && document.querySelectorAll('.cf-mwt__recovery').length === 1)
  await click(labels.retry)
  verify('retry uses the same operation without creating again', calls.retry.length === 1 && calls.retry[0][0] === props.sessionId && calls.retry[0][2] === 'operation-1' && calls.create.length === before + 1)
  picker = { path: 'E:/plain' }
  await mount()
  await click(labels.choose)
  verify('non-git directory remains usable as ordinary directory', !button(labels.folder).disabled)
  await click(labels.folder)
  verify('ordinary directory only commits on explicit confirmation', calls.use.length === 1 && calls.use[0] === 'E:/plain')
  await mount({ busy: true })
  verify('busy member cannot change directory', button(labels.choose).disabled && button(labels.folder).disabled)
  await mount({ focusRoot: `E:/长中文目录/${'成员目录/'.repeat(16)}` })
  await toggle('.cf-mwt__toggle input')
  await click(labels.check)
  verify('safety explanation stays visible in the component', document.querySelectorAll('.cf-mwt__safety').length === 1 && document.querySelector('.cf-mwt__safety').textContent.length > 25)
  window.memberWorktreeResults = { locale, passed: results.length, results }
  return window.memberWorktreeResults
}

window.runMemberWorktreeAdapterChecks = async () => {
  const results = []
  const verify = (name, condition) => { assert(condition, name); results.push(name) }
  let next = { ok: false, status: 'rejected', reason: 'member-removed' }
  const calls = []
  window.deva = {
    platform: 'win32', config: { getSync: () => ({ locale: 'en' }) },
    chat: {
      memberWorktreeState: async (request) => { calls.push(request); return next },
      setFocus: async (request) => { calls.push(request); return { ok: true } }
    },
    git: { status: async () => ({ isRepo: true, root: 'E:/Repo', branch: 'main' }) },
    fs: { openFolder: async () => null }
  }
  const state = { sessionId: 'mem-pinned', revision: 7, focusRoot: 'E:/Tree/pkg', pending: false }
  const mount = async () => {
    if (root) flushSync(() => root.unmount())
    host?.remove()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    flushSync(() => root.render(<I18nProvider><DialogProvider><MemberWorktreeDialog sessionId="mem-pinned" name="Renderer" busy={false} onClose={() => {}} /></DialogProvider></I18nProvider>))
    await tick()
  }
  await mount()
  verify('state rejection is visible and cannot create', document.querySelector('[role=alert]')?.textContent === 'member-removed' && !document.querySelector('.cf-mwt'))
  // 协议里 bindingInconsistent 是 boolean（主进程 memberWorktreeState 现在真的会写它）。
  next = { ok: true, state: { ...state, bindingInconsistent: true } }
  await mount()
  verify('inconsistent binding fails closed', !!document.querySelector('[role=alert]') && !document.querySelector('.cf-mwt'))
  const record = { sourceRoot: 'E:/Selected/pkg', checkoutRoot: 'E:/Tree', repoRoot: 'E:/Repo', branch: 'member', relativePath: 'pkg' }
  next = { ok: true, state: { ...state, recovery: { ...record, phase: 'creating', operationId: 'intent-only' } } }
  await mount()
  verify('unverified creating intent is never shown as created', !!document.querySelector('[role=alert]') && !document.querySelector('.cf-mwt__recovery'))
  next = { ok: true, state: { ...state, recovery: { ...record, phase: 'intent', operationId: 'intent-not-run' } } }
  await mount()
  verify('unstarted intent is never shown as a created worktree', !!document.querySelector('[role=alert]') && !document.querySelector('.cf-mwt__recovery'))
  next = { ok: true, state: { ...state, identity: record } }
  await mount()
  verify('active view uses persisted selected source instead of current focus', document.querySelector('.cf-mwt__state')?.textContent.includes('E:/Selected/pkg') && !document.querySelector('.cf-mwt__state')?.textContent.includes('Selected source folderE:/Tree/pkg'))
  next = { ok: true, state: { ...state, identity: record, recovery: { ...record, phase: 'created', operationId: 'operation-real', reason: 'bind-write-failed' } } }
  await mount()
  verify('recovery supersedes previous bound identity and retains record paths', document.querySelectorAll('.cf-mwt__recovery').length === 1 && document.querySelector('.cf-mwt__recovery').textContent.includes('operation-real') && document.querySelector('.cf-mwt__recovery').textContent.includes('E:/Tree/pkg') && !document.querySelector('.cf-mwt__state'))

  /*
   * 「返回原目录」必须从界面真的能点到。
   *
   * 这条通道曾经是死代码：主进程 `chat:member-worktree-return-original` 有 24 行完整实现
   * （含原目录身份校验），preload 里一行都没有，于是 Dialog 传不进 onReturnToOriginal、
   * Panel 那个按钮永远不渲染。功能整个不存在，而所有检查全绿。
   * 所以这里断言的是「按钮在、点了真的调到那条 IPC、失败会报错不关闭」。
   */
  const returnCalls = []
  let returnResult = { ok: false, status: 'rejected', reason: 'original-unavailable' }
  window.deva.chat.memberWorktreeReturnOriginal = async (request) => {
    returnCalls.push(request)
    return returnResult
  }
  // confirm 要用户点「确定」：DialogProvider 的确认框由 useDialog 弹，这里直接点它的确认按钮。
  const confirmYes = async () => {
    const btns = [...document.querySelectorAll('button')]
    const yes = btns.find((b) => /^(OK|确定|Confirm)$/i.test(b.textContent.trim()))
    assert(!!yes, 'confirmation dialog did not appear')
    yes.click()
    await tick()
  }
  next = { ok: true, state: { ...state, identity: record } }
  await mount()
  const returnBtn = [...document.querySelectorAll('.cf-mwt__state button')].find((b) =>
    /Return to original|返回原目录/.test(b.textContent)
  )
  verify('return-to-original button is reachable from the dialog', !!returnBtn)
  returnBtn.click()
  await tick()
  await confirmYes()
  await tick()
  verify(
    'return-to-original actually invokes the IPC with the pinned session and revision',
    returnCalls.length === 1 && returnCalls[0].sessionId === 'mem-pinned' && returnCalls[0].expectedRevision === 7
  )
  verify(
    'failed return keeps the dialog open and shows why',
    document.querySelectorAll('.cf-mwt').length === 1 && /original-unavailable/.test(document.querySelector('[role=alert]')?.textContent ?? '')
  )
  returnResult = { ok: true, revision: 8, focusRoot: 'E:/Selected/pkg' }
  await mount()
  const returnBtn2 = [...document.querySelectorAll('.cf-mwt__state button')].find((b) =>
    /Return to original|返回原目录/.test(b.textContent)
  )
  returnBtn2.click()
  await tick()
  await confirmYes()
  await tick()
  verify('successful return passes the new revision along', returnCalls.length === 2)

  verify('all state requests use the fixed member session', calls.length >= 5 && calls.every((request) => request.sessionId === 'mem-pinned'))
  return { passed: results.length, results }
}
