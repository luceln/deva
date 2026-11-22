/**
 * P1 第二轮 ①：A27 真实安装链路 —— 走**产品代码**的 startInstall / retryInstall，
 * 验证 `installing → ready` 这条状态转移真的发生（不是测试自己跑 npm ci）。
 *
 * 上一轮/本轮官方断言只验了 runNpmCi 这个测试辅助函数 exit 0 + node_modules 落地，
 * 绕过了 deps.ts。这里补上：调 startInstall → 等状态机跑完 → 断言 record.deps === 'ready'。
 *
 * 用法：node .deva/qa/accept-r2-a27.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-r2a27-' + Date.now())
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

const run = (cmd, args, cwd) =>
  spawnSync(cmd, args, {
    cwd, encoding: 'utf8', shell: process.platform === 'win32',
    env: { ...process.env, CI: '1' }, timeout: 180000
  })

;(async () => {
  const DEPS = await import('../../apps/desktop/src/main/services/worktree/deps')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const bus = await import('../../apps/desktop/src/main/services/chat-bus')

  // npm 可用性
  const probe = run('npm', ['--version'], root)
  if (probe.status !== 0) { console.log('SKIP npm 不可用'); process.exit(0) }

  // ── 造：假包 + file: 依赖 + npm 自己生成 lockfile
  const pkg = path.join(root, 'pkg-local')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pkg-local', version: '1.0.0', main: 'index.js' }, null, 2))
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 42\n')

  const wt = path.join(root, 'wt')
  fs.mkdirSync(wt, { recursive: true })
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({
    name: 'tiny', version: '1.0.0', private: true,
    dependencies: { 'pkg-local': 'file:../pkg-local' }
  }, null, 2))
  const gen = run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], wt)
  ok('前置：npm 生成了 lockfile', fs.existsSync(path.join(wt, 'package-lock.json')), `gen exit=${gen.status}`)
  if (!fs.existsSync(path.join(wt, 'package-lock.json'))) { console.log('=== 无法继续 ==='); process.exit(1) }

  // 检测规则应命中 npm ci
  eq('前置：detectInstallPlan 命中 npm ci', DEPS.detectInstallPlan(wt).argv?.join(' '), 'npm ci')

  // ── 建一条 worktree 记录（deps: pending），走产品 startInstall
  const paths = await import('../../apps/desktop/src/main/services/worktree/paths')
  const norm = paths.normalizeWorktreePath(wt)
  const repoRoot = path.dirname(wt)
  const rec = {
    schemaVersion: 1, path: norm.path, compareKey: norm.compareKey,
    repoRoot, repoKey: paths.repoKeyOf(repoRoot),
    branch: 'wt/a27', baseSha: 'a'.repeat(40), baseLabel: 'my/dev', targetBranch: 'my/dev',
    createdAt: Date.now(), phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'pending'
  }
  S.upsertRecord(rec)
  eq('前置：记录 deps = pending', S.getRecord(wt)?.deps, 'pending')

  // 抓进度事件
  const progress = []
  const offProg = typeof bus.onWorktreeProgress === 'function'
    ? bus.onWorktreeProgress((p) => progress.push(p))
    : null
  const changed = []
  const offChg = typeof bus.onWorktreeChanged === 'function'
    ? bus.onWorktreeChanged(() => changed.push(Date.now()))
    : null

  const started = DEPS.startInstall(S.getRecord(wt))
  info('startInstall 返回', JSON.stringify(started))
  eq('A27：startInstall 真的启动了安装', started.started, true)
  eq('A27：启动后立刻是 installing（写盘先于子进程）', S.getRecord(wt)?.deps, 'installing')

  // 等状态机跑完（轮询到不再是 installing，最多 180s）
  let final = null
  for (let i = 0; i < 720; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const cur = S.getRecord(wt)?.deps
    if (cur && cur !== 'installing') { final = cur; break }
  }
  if (offProg) offProg()
  if (offChg) offChg()

  info('最终 deps', String(final))
  info('depsDetail', JSON.stringify(S.getRecord(wt)?.depsDetail ?? null))
  info('进度事件数', String(progress.length))
  info('进度事件样例', JSON.stringify(progress.slice(0, 3)))
  info('worktree:changed 次数', String(changed.length))

  eq('A27 核心：installing → ready（走产品状态机，不是测试自己跑 npm）', final, 'ready')
  ok('A27：依赖真的落进 node_modules', fs.existsSync(path.join(wt, 'node_modules', 'pkg-local', 'package.json')))
  ok('A27：成功时不写 depsDetail（ready 不该带失败信息）', !S.getRecord(wt)?.depsDetail, JSON.stringify(S.getRecord(wt)?.depsDetail))
  ok('B4：安装过程发出了进度事件', progress.length > 0, String(progress.length))
  ok('B4：进度事件带 phase=install-deps 与 step', progress.every((p) => p.phase === 'install-deps' && typeof p.step === 'string'),
    JSON.stringify(progress[0] ?? null))
  ok('deps 变化后发了 worktree:changed（界面靠它刷新）', changed.length > 0, String(changed.length))

  // ── 反向：把 finish 的 ready 判定改坏后这条必须红（由独立脚本做，这里只记录锚点）
  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' / ') : e)
  process.exit(2)
})