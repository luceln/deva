/**
 * dirtyCount 同步耗时实测。
 *
 * 造真实仓库 + N 个 worktree（含大量文件的工作区、有未提交改动的工作区），
 * 测：
 *   1. `worktree:list` 一次调用的总耗时（走真实 IPC 处理器）
 *   2. 其中每个 `git status --porcelain -z` 的耗时（即 dirtyCount 那部分）
 *   3. 文件数量对 status 耗时的影响
 *
 * 用法：node .deva/qa/bench-dirty.cjs [worktree数]
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const N = Number(process.argv[2] || 8)
const root = path.join(os.tmpdir(), 'bench-dirty-' + Date.now())
const HOME = path.join(root, 'home')
const DST = path.join(root, 'dst')
for (const d of [HOME, DST, path.join(root, 'appdata')]) fs.mkdirSync(d, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DEVA_HOME = DST
process.env.TEST_HOME = HOME
process.env.TEST_APPDATA = path.join(root, 'appdata')

const info = (l, v) => console.log(`${l} :: ${v}`)
const git = (cwd, a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })

/** 精确计时一次 git status --porcelain -z。 */
function timeStatus(cwd) {
  const t0 = process.hrtime.bigint()
  let out = ''
  try {
    out = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28
    })
  } catch { /* ignore */ }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const n = out ? out.split('\0').filter((s) => s.length > 0).length : 0
  return { ms, n }
}

;(async () => {
  const L = await import('../../apps/desktop/src/main/services/worktree/list')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')
  const IPC = await import('../../apps/desktop/src/main/services/worktree/ipc')
  const stub = require('./stub-electron.cjs')

  // ── 建主仓库
  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [['init', '-b', 'dev'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'a'], ['config', 'core.autocrlf', 'false']])
    git(repo, a)
  fs.writeFileSync(path.join(repo, 'readme.md'), '# repo\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  // ── 造 N 个 worktree，规模各异
  const shapes = []
  for (let i = 0; i < N; i++) {
    // 第 0 个：大工作区（3000 个文件，模拟 node_modules 量级的目录树）
    // 第 1 个：500 文件 + 50 处未提交改动
    // 其余：10~80 文件，部分脏
    let files, dirty
    if (i === 0) { files = 3000; dirty = 5 }
    else if (i === 1) { files = 500; dirty = 50 }
    else { files = 10 + i * 8; dirty = i % 3 === 0 ? 12 : 0 }
    shapes.push({ files, dirty })
  }

  const wts = []
  for (let i = 0; i < N; i++) {
    const wt = path.join(DST, 'wts', 'w' + i)
    const br = 'wt/b' + i
    git(repo, ['worktree', 'add', '-q', '-b', br, wt])
    const { files, dirty } = shapes[i]
    // 批量写文件（一次写完，减少 setup 噪声）
    const chunks = []
    for (let f = 0; f < files; f++) {
      const dir = path.join(wt, 'src', 'm' + (f % 20))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `f${f}.js`), `// file ${f}\nmodule.exports=${f}\n`)
    }
    git(wt, ['add', '.'])
    git(wt, ['commit', '-q', '-m', 'bulk ' + i])
    // 制造 dirty：改 dirty 个已跟踪文件 + 加几个未跟踪
    for (let d = 0; d < dirty; d++) {
      const f = d % Math.max(1, files)
      const p = path.join(wt, 'src', 'm' + (f % 20), `f${f}.js`)
      if (fs.existsSync(p)) fs.appendFileSync(p, `// dirty ${d}\n`)
    }
    for (let u = 0; u < 3; u++) fs.writeFileSync(path.join(wt, `untracked${u}.txt`), 'u\n')

    const norm = P.normalizeWorktreePath(wt)
    S.upsertRecord({
      schemaVersion: 1, path: norm.path, compareKey: norm.compareKey,
      repoRoot: repo, repoKey: P.repoKeyOf(repo),
      branch: br, baseSha: 'a'.repeat(40), baseLabel: 'dev', targetBranch: 'dev',
      createdAt: Date.now() + i, phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: 'skipped'
    })
    wts.push({ wt, files, dirty: dirty + 3, idx: i })
  }

  info('worktree 数', String(N))
  info('规模（文件数/未提交条目）', wts.map((w) => `${w.files}/${w.dirty}`).join(' '))

  // ── 逐个测 git status（dirtyCount 的底层开销）
  console.log('\n── 单个 git status --porcelain -z 耗时 ──')
  const perStatus = []
  for (const w of wts) {
    // 热身后取 3 次中位数
    timeStatus(w.wt)
    const runs = [timeStatus(w.wt), timeStatus(w.wt), timeStatus(w.wt)].map((r) => r.ms).sort((a, b) => a - b)
    const med = runs[1]
    perStatus.push(med)
    info(`  w${w.idx} (${w.files} 文件, ${w.dirty} 条改动)`, `${med.toFixed(1)} ms  (三次 ${runs.map((r) => r.toFixed(0)).join('/')})`)
  }
  const sumStatus = perStatus.reduce((a, b) => a + b, 0)
  info('status 合计（串行相加）', `${sumStatus.toFixed(1)} ms`)
  info('单次 status 中位数', `${(perStatus.slice().sort((a, b) => a - b)[Math.floor(N / 2)]).toFixed(1)} ms`)

  // ── 测完整 listWorktrees
  console.log('\n── worktree:list 总耗时（真实 IPC 处理器）──')
  IPC.registerWorktreeIpc(() => null)
  const handler = stub.__test.ipcHandlers.get('worktree:list')

  await handler({}) // 预热（首次含 git 进程启动、路径缓存等）
  const totals = []
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint()
    await handler({})
    totals.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  totals.sort((a, b) => a - b)
  const med = totals[1]
  info('总耗时中位数', `${med.toFixed(1)} ms  (五次 ${totals.map((t) => t.toFixed(0)).join('/')})`)
  info('其中 dirtyCount 部分（实测 status 合计）', `${sumStatus.toFixed(1)} ms`)
  info('dirtyCount 占比', `${((sumStatus / med) * 100).toFixed(0)}%`)
  info('其余开销（state/mergeGate/mergeInProgress/lockHolder 等）', `${(med - sumStatus).toFixed(1)} ms`)

  // ── 对照：纯 git status 在「大量文件」时的表现（验证它随文件数增长）
  console.log('\n── 文件数对 status 的影响（同一 worktree 加文件后再测）──')
  const big = wts[0]
  let written = 0
  for (const add of [0, 5000, 15000]) {
    for (let f = 0; f < add; f++) {
      const dir = path.join(big.wt, 'src', 'bulk' + (written % 40))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `b${written}.js`), 'x\n')
      written++
    }
    const r = timeStatus(big.wt)
    info(`  w0 +${add} 个未跟踪文件`, `${r.ms.toFixed(1)} ms（${r.n} 条）`)
  }

  console.log(`\n根目录（测完可删）：${root}`)
  fs.writeFileSync(path.join(root, 'RESULT.json'), JSON.stringify({ N, perStatus, sumStatus, med, totals }, null, 2))
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' / ') : e)
  process.exit(2)
})