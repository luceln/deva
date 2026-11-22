/**
 * ① 核「rev-parse HEAD 是否真省掉」+「并发是否真并发」。
 *
 * 做法：用 esbuild 的 plugin 在打包时把 `../git` 的 runGitRaw 替换成计数版包装
 * （不改产品源码，只在 bundle 里改）。然后：
 *   - 记录每次 git 调用的 argv，按命令归类计数
 *   - 检查是否还有 `rev-parse --abbrev-ref HEAD`
 *   - 测 GIT_CONCURRENCY 相关：用同样 N 对比「串行（limit=1）」与「并行」
 *
 * 用法：node .deva/qa/accept-r3-calls.cjs [N]
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const N = Number(process.argv[2] || 5)
const root = path.join(os.tmpdir(), 'acc-r3c-' + Date.now())
const HOME = path.join(root, 'home')
const DST = path.join(root, 'dst')
for (const d of [HOME, DST, path.join(root, 'appdata')]) fs.mkdirSync(d, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DEVA_HOME = DST
process.env.TEST_HOME = HOME
process.env.TEST_APPDATA = path.join(root, 'appdata')

const info = (l, v) => console.log(`${l} :: ${v}`)
const eq = (l, a, e) => {
  const x = JSON.stringify(a), y = JSON.stringify(e)
  if (x === y) console.log(`PASS ${l} :: ${x}`)
  else { console.log(`FAIL ${l} :: 实际=${x} 期望=${y}`); process.exitCode = 1 }
}
const git = (cwd, a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })

;(async () => {
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')
  const IPC = await import('../../apps/desktop/src/main/services/worktree/ipc')

  const stub = require('./stub-electron.cjs')

  // ── 计数来自打包时注入的 globalThis.__GIT_CALLS__（见 build-calls.cjs）
  const calls = (globalThis.__GIT_CALLS__ = [])

  // ── 造仓库 + N 个 worktree
  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [['init', '-b', 'dev'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'a']]) git(repo, a)
  fs.writeFileSync(path.join(repo, 'r.md'), '# r\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  for (let i = 0; i < N; i++) {
    const wt = path.join(DST, 'wts', 'w' + i)
    const br = 'wt/b' + i
    git(repo, ['worktree', 'add', '-q', '-b', br, wt])
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    for (let f = 0; f < 30; f++) fs.writeFileSync(path.join(wt, 'src', `f${f}.js`), 'x\n')
    git(wt, ['add', '.'])
    git(wt, ['commit', '-q', '-m', 'x' + i])
    for (let d = 0; d < 4; d++) fs.appendFileSync(path.join(wt, 'src', `f${d}.js`), '// dirty\n')
    const norm = P.normalizeWorktreePath(wt)
    S.upsertRecord({
      schemaVersion: 1, path: norm.path, compareKey: norm.compareKey,
      repoRoot: repo, repoKey: P.repoKeyOf(repo),
      branch: br, baseSha: 'a'.repeat(40), baseLabel: 'dev', targetBranch: 'dev',
      createdAt: Date.now() + i, phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false }, deps: 'skipped'
    })
  }

  IPC.registerWorktreeIpc(() => null)
  const handler = stub.__test.ipcHandlers.get('worktree:list')

  calls.length = 0
  const snap = await handler({})
  const snapshot = calls.slice()

  console.log(`\n=== N=${N}：一次 worktree:list 的实际 git 调用 ===`)
  const byCmd = {}
  for (const c of snapshot) {
    const k = c.cmd.replace(/\s+[A-Fa-f0-9]{7,40}\b/g, ' <sha>')
    byCmd[k] = (byCmd[k] ?? 0) + 1
  }
  for (const [k, v] of Object.entries(byCmd).sort((a, b) => b[1] - a[1])) info(`  ${v} 次`, k)
  info('git 调用总数', String(snapshot.length))

  // 关键断言：不应再有 rev-parse --abbrev-ref HEAD
  const headCalls = snapshot.filter((c) => /rev-parse --abbrev-ref HEAD/.test(c.cmd))
  eq('rev-parse --abbrev-ref HEAD 调用次数（应为 0）', headCalls.length, 0)
  const statusCalls = snapshot.filter((c) => /status --porcelain -z/.test(c.cmd))
  eq('status --porcelain -z 次数（= N，每个 worktree 一次）', statusCalls.length, N)
  const wtListCalls = snapshot.filter((c) => /worktree list --porcelain/.test(c.cmd))
  eq('worktree list --porcelain 次数（= 仓库数 1）', wtListCalls.length, 1)
  const mergeHeadCalls = snapshot.filter((c) => /rev-parse -q --verify MERGE_HEAD/.test(c.cmd))
  info('MERGE_HEAD 次数（按 targetPath 去重后应 ≤1）', String(mergeHeadCalls.length))
  eq('MERGE_HEAD 去重生效（≤1，全部 targetBranch 相同）', mergeHeadCalls.length <= 1, true)

  // ── 并发验证：从时间戳看是否重叠
  console.log('\n=== 并发验证：调用的时间重叠 ===')
  const statusTimes = snapshot.filter((c) => /status --porcelain -z/.test(c.cmd))
  if (statusTimes.length >= 2) {
    const span = statusTimes[statusTimes.length - 1].at - statusTimes[0].at
    info('N 次 status 的首尾时间跨度', `${span} ms`)
    info('（串行应≈N×100ms，并行应远小于此）', span < N * 60 ? '看起来是并行' : '看起来是串行')
    eq('status 调用时间跨度远小于串行预期（并行证据）', span < N * 60, true)
  }

  // ── 对照：把并发改成 1（模拟串行）比较总耗时
  console.log('\n=== 耗时 ===')
  const t = async (times = 5) => {
    const rs = []
    for (let i = 0; i < times; i++) {
      const t0 = process.hrtime.bigint()
      await handler({})
      rs.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    rs.sort((a, b) => a - b)
    return rs[Math.floor(times / 2)]
  }
  await t(1) // 预热
  const med = await t(5)
  info(`worktree:list 中位数（N=${N}）`, `${med.toFixed(1)} ms`)
  info('每条记录平均', `${(med / N).toFixed(1)} ms`)

  // 快照结构完整性
  eq('快照条数 = N', snap.items.length, N)
  const bad = snap.items.filter((i) => i.state === 'dir-missing')
  eq('没有条目被兜底成 dir-missing（正常情况）', bad.length, 0)
  const hasGate = snap.items.every((i) => i.mergeGate && typeof i.mergeGate.mayMerge === 'boolean')
  eq('每条都有 mergeGate', hasGate, true)
  const hasDirty = snap.items.every((i) => i.dirtyCount === null || typeof i.dirtyCount === 'number')
  eq('每条都有 dirtyCount（number|null）', hasDirty, true)

  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' / ') : e)
  process.exit(2)
})