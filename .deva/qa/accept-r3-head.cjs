/**
 * ② 核「headBranch 从 porcelain 读」的正确性风险。
 *
 * 三个必验前提：
 *  A. 目录被删后，porcelain 是否真的给陈旧数据（所以不能用）
 *  B. 调用方的 `exists && entry` 守卫是否真的挡住（目录删了 → headBranch 给 null → state 仍正确）
 *  C. detached HEAD：porcelain 给 detached 行 / rev-parse 给字面量 'HEAD' —— 对 state 判定是否等价
 *
 * 外加 state 四态回归（上一轮的夹具）。
 *
 * 用法：node .deva/qa/accept-r3-head.cjs
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-r3h-' + Date.now())
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
const git = (cwd, a) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }) }
  catch (e) { return `__ERR__${e.status}` }
}

;(async () => {
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const P = await import('../../apps/desktop/src/main/services/worktree/paths')
  const GW = await import('../../apps/desktop/src/main/services/worktree/git-worktree')
  const L = await import('../../apps/desktop/src/main/services/worktree/list')
  const IPC = await import('../../apps/desktop/src/main/services/worktree/ipc')
  const stub = require('./stub-electron.cjs')

  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [['init', '-b', 'dev'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'a']]) git(repo, a)
  fs.writeFileSync(path.join(repo, 'r.md'), '# r\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  const mk = (name, branch) => {
    const wt = path.join(DST, 'wts', name)
    git(repo, ['worktree', 'add', '-q', '-b', branch, wt])
    fs.writeFileSync(path.join(wt, 'f.txt'), 'x\n')
    git(wt, ['add', '.'])
    git(wt, ['commit', '-q', '-m', 'c'])
    const norm = P.normalizeWorktreePath(wt)
    S.upsertRecord({
      schemaVersion: 1, path: norm.path, compareKey: norm.compareKey,
      repoRoot: repo, repoKey: P.repoKeyOf(repo),
      branch, baseSha: 'a'.repeat(40), baseLabel: 'dev', targetBranch: 'dev',
      createdAt: Date.now(), phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false }, deps: 'skipped'
    })
    return { wt, branch, compareKey: norm.compareKey }
  }

  const A = mk('a', 'wt/a')   // 正常
  const B = mk('b', 'wt/b')   // 会被切到别的分支
  const C = mk('c', 'wt/c')   // 会被删目录
  const D = mk('d', 'wt/d')   // 会变 detached

  IPC.registerWorktreeIpc(() => null)
  const handler = stub.__test.ipcHandlers.get('worktree:list')
  const itemOf = (snap, key) => snap.items.find((i) => i.compareKey === key)

  // ══ 前置：全正常
  let snap = await handler({})
  eq('前置：4 条 state 全 ok', snap.items.map((i) => i.state).join(','), 'ok,ok,ok,ok')

  // ══ A. 目录删掉后 porcelain 是否给陈旧数据
  console.log('\n── A. 目录删后 porcelain 的 branch 行 ──')
  fs.rmSync(C.wt, { recursive: true, force: true })
  const porcelain = git(repo, ['worktree', 'list', '--porcelain'])
  const blocks = porcelain.split('\n\n').filter(Boolean)
  const cBlock = blocks.find((b) => b.includes('wts\\c') || b.includes('wts/c'))
  info('删目录后 porcelain 里该条', JSON.stringify((cBlock ?? '(找不到)').split('\n').slice(0, 4)))
  const stillHasBranch = /branch refs\/heads\/wt\/c/.test(cBlock ?? '')
  ok('A：目录已删但 porcelain 仍报 branch（陈旧数据，证明不能直接用）', stillHasBranch, `stillHasBranch=${stillHasBranch}`)
  ok('A：porcelain 同时标了 prunable（说明 git 自己知道它没了）', /prunable/.test(cBlock ?? ''))

  // ══ B. 调用方守卫是否挡住
  console.log('\n── B. exists && entry 守卫 ──')
  snap = await handler({})
  const ci = itemOf(snap, C.compareKey)
  eq('B：目录被删 → state = prunable（§2.1 第 1 条，比 dir-missing 更强）', ci?.state, 'prunable')
  ok('B：没有把陈旧分支名当成 actualBranch 写出去', ci?.actualBranch === undefined,
    JSON.stringify(ci?.actualBranch))
  ok('B：dirtyCount 为 null（没对不存在的目录跑 status）', ci?.dirtyCount === null, String(ci?.dirtyCount))

  // ══ C. detached 等价性
  console.log('\n── C. detached HEAD：porcelain vs rev-parse ──')
  const sha = git(D.wt, ['rev-parse', 'HEAD']).trim()
  git(D.wt, ['checkout', '-q', '--detach', sha])
  const pAfter = git(repo, ['worktree', 'list', '--porcelain'])
  const dBlock = pAfter.split('\n\n').filter(Boolean).find((b) => b.includes('wts\\d') || b.includes('wts/d'))
  info('detached 后 porcelain 该条', JSON.stringify((dBlock ?? '(找不到)').split('\n').slice(0, 4)))
  const hasDetachedLine = /^detached$/m.test(dBlock ?? '')
  const hasBranchLine = /^branch refs\/heads\//m.test(dBlock ?? '')
  ok('C：porcelain 在 detached 时给 detached 行、无 branch 行', hasDetachedLine && !hasBranchLine,
    `detached=${hasDetachedLine} branch=${hasBranchLine}`)
  const rp = git(D.wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  eq("C：rev-parse --abbrev-ref HEAD 在 detached 时返回字面量 'HEAD'", rp, 'HEAD')

  snap = await handler({})
  const di = itemOf(snap, D.compareKey)
  eq('C：detached → state = branch-mismatch（与改前一致）', di?.state, 'branch-mismatch')
  eq('C：actualBranch = HEAD（界面显示「已被切到 HEAD」）', di?.actualBranch, 'HEAD')

  // ══ 切到别的分支（非 detached）
  console.log('\n── state 四态回归 ──')
  git(B.wt, ['checkout', '-q', '-b', 'wt/other'])
  snap = await handler({})
  const bi = itemOf(snap, B.compareKey)
  eq('切分支 → branch-mismatch', bi?.state, 'branch-mismatch')
  eq('actualBranch 给出真实分支名', bi?.actualBranch, 'wt/other')
  const ai = itemOf(snap, A.compareKey)
  eq('正常的仍是 ok', ai?.state, 'ok')
  ok('正常条目的 actualBranch 不写（省得界面显示多余信息）', ai?.actualBranch === undefined, JSON.stringify(ai?.actualBranch))

  // ══ 直接对比：headBranchFromEntry 与 rev-parse 在所有情形下一致
  console.log('\n── 直接对比 headBranchFromEntry vs rev-parse ──')
  const entries = await GW.listWorktrees(repo)
  for (const e of entries) {
    if (!fs.existsSync(e.path)) { info(`  ${path.basename(e.path)}`, '目录不在，跳过'); continue }
    const fromEntry = e.detached ? 'HEAD' : (e.branch ?? null)
    const fromRevParse = git(e.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null
    const same = fromEntry === fromRevParse || (fromEntry === 'HEAD' && fromRevParse === 'HEAD')
    ok(`  ${path.basename(e.path)}: entry=${JSON.stringify(fromEntry)} revParse=${JSON.stringify(fromRevParse)} 一致`,
      same)
  }

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' / ') : e)
  process.exit(2)
})