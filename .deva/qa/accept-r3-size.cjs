/**
 * ③ 核 WorktreeSizeUpdate 的语义完整性。
 *
 * 核心问题：体积回填从 `worktree:changed` 改走 `worktree:size` 增量事件后，
 * 渲染层有没有真的订阅它？没订阅的话 sizeBytes 永远停在「统计中…」。
 *
 * 本脚本从主进程侧证明：
 *   1. sizeBytes 首次返回 null（还在算）
 *   2. 算完**只**发 worktree-size，**不发** worktree-changed
 *   3. 因此界面若只订阅 changed，就永远收不到体积更新
 *
 * 用法：node .deva/qa/accept-r3-size.cjs
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-r3s-' + Date.now())
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
  const x = JSON.stringify(a), y = JSON.stringify(e)
  if (x === y) console.log(`PASS ${l} :: ${x}`)
  else { fails++; console.log(`FAIL ${l} :: 实际=${x} 期望=${y}`) }
}
const ok = (l, c, d) => {
  if (c) console.log(`PASS ${l}${d ? ' :: ' + d : ''}`)
  else { fails++; console.log(`FAIL ${l}${d ? ' :: ' + d : ''}`) }
}
const info = (l, v) => console.log(`INFO ${l} :: ${v}`)
const git = (cwd, a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 })

;(async () => {
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')
  const L = await import('../../apps/desktop/src/main/services/worktree/list')
  const bus = await import('../../apps/desktop/src/main/services/chat-bus')
  const IPC = await import('../../apps/desktop/src/main/services/worktree/ipc')
  const stub = require('./stub-electron.cjs')

  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [['init', '-b', 'dev'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'a']]) git(repo, a)
  fs.writeFileSync(path.join(repo, 'r.md'), '# r\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  const N = 3
  for (let i = 0; i < N; i++) {
    const wt = path.join(DST, 'wts', 'w' + i)
    git(repo, ['worktree', 'add', '-q', '-b', 'wt/b' + i, wt])
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    for (let f = 0; f < 20; f++) fs.writeFileSync(path.join(wt, 'src', `f${f}.js`), 'x\n')
    git(wt, ['add', '.'])
    git(wt, ['commit', '-q', '-m', 'x'])
    const norm = P.normalizeWorktreePath(wt)
    S.upsertRecord({
      schemaVersion: 1, path: norm.path, compareKey: norm.compareKey,
      repoRoot: repo, repoKey: P.repoKeyOf(repo),
      branch: 'wt/b' + i, baseSha: 'a'.repeat(40), baseLabel: 'dev', targetBranch: 'dev',
      createdAt: Date.now() + i, phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false }, deps: 'skipped'
    })
  }

  IPC.registerWorktreeIpc(() => null)
  const handler = stub.__test.ipcHandlers.get('worktree:list')

  // 订阅两种事件
  const changed = []
  const sizes = []
  const offC = bus.onWorktreeChanged(() => changed.push(Date.now()))
  const offS = bus.onWorktreeSize ? bus.onWorktreeSize((u) => sizes.push(u)) : () => {}

  L.clearSizeCacheForTest()
  const snap = await handler({})

  info('首次快照的 sizeBytes', JSON.stringify(snap.items.map((i) => i.sizeBytes)))
  ok('首次 sizeBytes 为 null（后台统计中）', snap.items.every((i) => i.sizeBytes === null))

  // 等后台 setImmediate 算完
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 50))
  offC(); offS()

  info('期间 worktree:changed 次数', String(changed.length))
  info('期间 worktree:size 次数', String(sizes.length))
  info('size 事件内容', JSON.stringify(sizes.slice(0, 3)))

  eq('体积算完**不再**发 worktree:changed（改走增量事件）', changed.length, 0)
  eq('体积算完发了 worktree:size（每个 worktree 一条）', sizes.length, N)
  ok('size 事件带 compareKey + sizeBytes',
    sizes.every((u) => typeof u.compareKey === 'string' && typeof u.sizeBytes === 'number'),
    JSON.stringify(sizes[0] ?? null))

  // ── 关键：界面是否订阅了 onSize
  console.log('\n── 渲染层是否订阅 onSize ──')
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'apps/desktop/src/renderer/src/store/worktree.tsx'),
    'utf8'
  )
  const hasOnSize = /\.onSize\s*\(/.test(storeSrc)
  const hasOnChanged = /\.onChanged\s*\(/.test(storeSrc)
  info('store/worktree.tsx 订阅 onChanged', String(hasOnChanged))
  info('store/worktree.tsx 订阅 onSize', String(hasOnSize))
  ok('store 订阅了 onSize（否则 sizeBytes 永远停在「统计中…」）', hasOnSize,
    hasOnSize ? '' : '未订阅：主进程只发 worktree:size，界面只听 worktree:changed → 永远收不到体积')

  // 全仓找 onSize 的使用点（排除 preload 定义本身）
  const { execFileSync: ex } = require('child_process')
  let hits = ''
  try {
    hits = ex('git', ['grep', '-rn', 'onSize', '--', 'apps/desktop/src'], {
      cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8'
    })
  } catch { hits = '' }
  const usage = hits.split('\n').filter((l) => l && !/preload\/index\.ts/.test(l))
  info('onSize 在 preload 之外的调用点', String(usage.length))
  ok('onSize 至少有一处真实调用（不只是 preload 暴露）', usage.length > 0,
    usage.length === 0 ? '全仓仅 preload 定义，无人调用' : usage.join(' | '))

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' / ') : e)
  process.exit(2)
})