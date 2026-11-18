/**
 * `worktree:list` 性能基准（改前/改后对比用）。
 *
 * 与 `.deva/qa/bench-dirty.cjs` 的区别：那个直接 `import('...list')` 指向 .ts 文件，node 加载不了；
 * 这个用 esbuild 先把 main 侧的源码打成 cjs 再 require，与 driver.cjs 的做法一致。
 *
 * 用法：node .deva/qa/bench-list.cjs [N]
 *
 * 造 N 个真实 worktree（规模各异，含大量文件与未提交改动），然后经**真实 IPC 处理器**计时
 * `worktree:list`，并单独计时三类 git 调用的开销，供改前改后对照。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const N = Number(process.argv[2] || 5)
const QA = __dirname
const ENTRY = path.join(QA, '_bench-entry.ts')
const BUNDLE = path.join(QA, '_bench-bundle.cjs')

const root = path.join(os.tmpdir(), 'bench-list-' + Date.now() + '-' + N)
const HOME = path.join(root, 'home')
const DST = path.join(root, 'dst')
const APPDATA = path.join(root, 'appdata')
for (const d of [HOME, DST, APPDATA]) fs.mkdirSync(d, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.DEVA_HOME = DST
process.env.TEST_HOME = HOME
process.env.TEST_APPDATA = APPDATA

const info = (l, v) => console.log(`${l} :: ${v}`)
const git = (cwd, a) =>
  execFileSync('git', a, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'q',
      GIT_AUTHOR_EMAIL: 'q@q',
      GIT_COMMITTER_NAME: 'q',
      GIT_COMMITTER_EMAIL: 'q@q'
    }
  })

async function build() {
  fs.writeFileSync(
    ENTRY,
    [
      "export { listWorktrees, clearSizeCacheForTest } from '../../apps/desktop/src/main/services/worktree/list'",
      "export * as store from '../../apps/desktop/src/main/services/worktree/store'",
      "export * as paths from '../../apps/desktop/src/main/services/worktree/paths'",
      "export * as ipc from '../../apps/desktop/src/main/services/worktree/ipc'",
      "export * as stub from './stub-electron.cjs'"
    ].join(String.fromCharCode(10))
  )
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: BUNDLE,
    alias: { electron: path.join(QA, 'stub-electron.cjs') },
    logLevel: 'warning',
    external: ['electron']
  })
}

;(async () => {
  await build()
  const M = require(BUNDLE)
  const S = M.store
  const P = M.paths

  // ── 建主仓库
  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [
    ['init', '-q', '-b', 'dev'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'core.autocrlf', 'false']
  ])
    git(repo, a)
  fs.writeFileSync(path.join(repo, 'readme.md'), '# repo\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'init'])

  // ── 建 N 个 worktree（规模各异：第一个大，第二个改动多，其余中等）
  const wts = []
  for (let i = 0; i < N; i++) {
    const files = i === 0 ? 3000 : i === 1 ? 500 : 10 + i * 8
    const dirty = i === 0 ? 5 : i === 1 ? 50 : i % 3 === 0 ? 12 : 0
    const wt = path.join(DST, 'wts', 'w' + i)
    const br = 'wt/b' + i
    git(repo, ['worktree', 'add', '-q', '-b', br, wt])
    for (let f = 0; f < files; f++) {
      const dir = path.join(wt, 'src', 'm' + (f % 20))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `f${f}.js`), `// file ${f}\nmodule.exports=${f}\n`)
    }
    git(wt, ['add', '.'])
    git(wt, ['commit', '-qm', 'bulk ' + i])
    for (let d = 0; d < dirty; d++) {
      const f = d % Math.max(1, files)
      const p = path.join(wt, 'src', 'm' + (f % 20), `f${f}.js`)
      if (fs.existsSync(p)) fs.appendFileSync(p, `// dirty ${d}\n`)
    }
    for (let u = 0; u < 3; u++) fs.writeFileSync(path.join(wt, `untracked${u}.txt`), 'u\n')

    const norm = P.normalizeWorktreePath(wt)
    S.upsertRecord({
      schemaVersion: 1,
      path: norm.path,
      compareKey: norm.compareKey,
      repoRoot: repo,
      repoKey: P.repoKeyOf(repo),
      branch: br,
      baseSha: 'a'.repeat(40),
      baseLabel: 'dev',
      targetBranch: 'dev',
      createdAt: Date.now() + i,
      phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: 'skipped'
    })
    wts.push({ wt, files, dirty: dirty + 3 })
  }

  info('N', String(N))
  info('规模（文件数/未提交条目）', wts.map((w) => `${w.files}/${w.dirty}`).join(' '))

  // ── 计时：经真实 IPC 处理器
  M.ipc.registerWorktreeIpc(() => null)
  /*
   * stub 被 esbuild 内联进 bundle 了：bundle 里的 `ipcMain.handle` 写的是**bundle 内那份** stub 的
   * ipcHandlers，外面再 require 一次拿到的是另一个实例（空 Map）。所以必须从 bundle 里取。
   */
  const handler = M.stub.__test.ipcHandlers.get('worktree:list')

  M.clearSizeCacheForTest()
  await handler({}) // 预热：首次含 git 进程冷启动、路径缓存
  // 单独测一次 listWorktrees（不经 IPC，排除 handler 包装开销）
  const tDirect = []
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint()
    await M.listWorktrees()
    tDirect.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  info('listWorktrees 直调', tDirect.map((t) => t.toFixed(0)).join('/') + ' ms')
  const runs = []
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint()
    await handler({})
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  runs.sort((a, b) => a - b)
  const med = runs[1]
  info('worktree:list 中位数', `${med.toFixed(1)} ms   (5 次: ${runs.map((r) => r.toFixed(0)).join('/')})`)

  // ── 单次 status 开销（对照用：说明「为什么 N 涨就线性涨」）
  const timeOne = (cwd, args) => {
    const t0 = process.hrtime.bigint()
    try {
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      /* ignore */
    }
    return Number(process.hrtime.bigint() - t0) / 1e6
  }
  timeOne(repo, ['--version'])
  const tVer = timeOne(repo, ['--version'])
  const tStatus = wts.map((w) => timeOne(w.wt, ['status', '--porcelain', '-z']))
  info('git --version（进程启动开销）', `${tVer.toFixed(1)} ms`)
  info('各 worktree 的 status 耗时', tStatus.map((t) => t.toFixed(0)).join('/') + ' ms')
  info(
    '每次 list 的 git 调用数（理论）',
    `${1 + N * 4} = worktree list 1 + (rev-parse HEAD + status + rev-parse MERGE_HEAD + diff --diff-filter=U) x ${N}`
  )
  // 全并行下界：最慢的那一次 git 调用（不是相加）
  info('全并行理论下界', `${Math.max(tVer, ...tStatus).toFixed(0)} ms 量级（最慢单次，而非全部相加）`)

  // ── 并发安全性：混一条坏掉的工作区（目录删了但记录还在），其余必须照常返回
  {
    const badWt = path.join(DST, 'wts', 'bad-gone')
    const norm = P.normalizeWorktreePath(badWt)
    S.upsertRecord({
      schemaVersion: 1,
      path: norm.path,
      compareKey: norm.compareKey,
      repoRoot: repo,
      repoKey: P.repoKeyOf(repo),
      branch: 'wt/bad',
      baseSha: 'a'.repeat(40),
      baseLabel: 'dev',
      targetBranch: 'dev',
      createdAt: Date.now() + 999,
      phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: 'skipped'
    })
    // 故意不建目录（模拟「用户自己在文件管理器里删掉了这个工作区」）
    const snap = await M.listWorktrees()
    const good = snap.items.filter((i) => i.path !== norm.path)
    const bad = snap.items.find((i) => i.path === norm.path)
    info('并发安全：坏条目的 state', String(bad?.state))
    info('并发安全：坏条目 dirtyCount/mergeInProgress', `${bad?.dirtyCount}/${bad?.mergeInProgress}`)
    info('并发安全：其余条目数量', String(good.length))
    info('并发安全：其余条目 dirtyCount 全有值', String(good.every((i) => typeof i.dirtyCount === 'number')))
    info(
      '并发安全：其余条目仍正常（state 是 ok/branch-mismatch，不是兜底的 dir-missing）',
      String(good.every((i) => i.state === 'ok' || i.state === 'branch-mismatch'))
    )
    S.removeRecord(badWt)
  }

  console.log(`\nRESULT N=${N} median=${med.toFixed(1)}ms`)
  // 清理临时文件（保留目录内容便于排查？不：bench 目录很大，删掉）
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})