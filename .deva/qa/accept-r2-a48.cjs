/**
 * P1 第二轮 ④：A48 现在到底能不能成立。
 *
 * A48 原文：「把 worktree 切到别的分支后，列表卡片显示 branch-mismatch **且**合并按钮禁用
 * （mergeGate.mayMerge === false）——两处同时反映同一事实，界面不自行推断」。
 *
 * 验两半：
 *  (a) 主进程快照里有没有 mergeGate 字段（没有 → 界面无从禁用）
 *  (b) branch-mismatch 时，界面拿到的数据里有没有任何东西能让它禁用合并按钮
 *
 * 用法：node .deva/qa/accept-r2-a48.cjs
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-r2a48-' + Date.now())
const HOME = path.join(root, 'home')
const DST = path.join(root, 'dst')
for (const d of [HOME, DST, path.join(root, 'appdata')]) fs.mkdirSync(d, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DEVA_HOME = DST
process.env.TEST_HOME = HOME
process.env.TEST_APPDATA = path.join(root, 'appdata')

let fails = 0
const eq = (l, a, e) => {
  const x = JSON.stringify(a)
  const y = JSON.stringify(e)
  if (x === y) console.log(`PASS ${l} :: ${x}`)
  else { fails++; console.log(`FAIL ${l} :: 实际=${x} 期望=${y}`) }
}
const ok = (l, c, d) => {
  if (c) console.log(`PASS ${l}${d ? ' :: ' + d : ''}`)
  else { fails++; console.log(`FAIL ${l}${d ? ' :: ' + d : ''}`) }
}
const info = (l, v) => console.log(`INFO ${l} :: ${v}`)
const git = (cwd, a) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { return `__ERR__${e.status}` }
}

;(async () => {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const L = await import('../../apps/desktop/src/main/services/worktree/list')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const IPC = await import('../../apps/desktop/src/main/services/worktree/ipc')
  const stub = require('./stub-electron.cjs')

  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [['init', '-b', 'my/dev'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'a']])
    git(repo, a)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  const wt = path.join(DST, 'wts', 'a48')
  const r = await CR.createWorktree({ repoRoot: repo, branch: 'wt/a48', path: wt, skipDeps: true })
  ok('前置：worktree 建好', r.ok === true)

  // 切到别的分支 → state 应为 branch-mismatch
  git(wt, ['checkout', '-q', '-b', 'wt/other'])
  const snap = await L.listWorktrees()
  const key = S.getRecord(wt)?.compareKey
  const item = snap.items.find((i) => i.compareKey === key)
  info('该条 state', String(item?.state))
  eq('(a) 切分支后 state = branch-mismatch', item?.state, 'branch-mismatch')

  // (a) 快照里有没有 mergeGate
  const keys = Object.keys(item ?? {})
  info('该条字段', JSON.stringify(keys))
  eq('(a) 快照里**有** mergeGate 字段（A48 与 §7.5 要求随 list 返回）', keys.includes('mergeGate'), true)
  ok('(a) mergeGate.mayMerge 在 mismatch 时为 false',
    item?.mergeGate?.mayMerge === false, JSON.stringify(item?.mergeGate ?? null))

  // (b) 走真实 IPC：界面拿到的也是同一份
  IPC.registerWorktreeIpc(() => null)
  const viaIpc = await stub.__test.ipcHandlers.get('worktree:list')({})
  const ipcItem = (viaIpc?.items ?? []).find((i) => i.compareKey === key)
  info('IPC 该条字段', JSON.stringify(Object.keys(ipcItem ?? {})))
  eq('(b) 界面从 IPC 拿到的数据里有 mergeGate', 'mergeGate' in (ipcItem ?? {}), true)

  // dirtyCount / mergeInProgress 同样在 spec 的 WorktreeListItem 里
  eq('spec 字段 dirtyCount 在快照里（§7.7 要显示「N 个未提交改动」）', keys.includes('dirtyCount'), true)
  eq('spec 字段 mergeInProgress 在快照里（§13.10 要显示「合并进行中」）', keys.includes('mergeInProgress'), true)

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' / ') : e)
  process.exit(2)
})