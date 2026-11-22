/**
 * P1 验收 ①：state 四态在**真实 git** 上的行为。
 *
 * 争议点：删掉 worktree 目录后，git 到底会不会立刻标 `prunable`？
 * 开发者据此把「删目录」的预期从 dir-missing 改成 prunable。要自己看 git 原文判定。
 *
 * 全部真 git：真仓库、真 worktree add、真删目录、真 prune、真切分支。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-p1s2-' + Date.now())
const repo = path.join(root, 'repo')
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

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return `__ERROR__ ${e.status} ${(e.stderr || '').toString()}`
  }
}

;(async () => {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'my/dev'])
  git(repo, ['config', 'user.email', 'a@b.c'])
  git(repo, ['config', 'user.name', 'a'])
  fs.writeFileSync(path.join(repo, 'a.txt'), '1')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  const wtPath = path.join(root, 'wt-one')
  const r1 = git(repo, ['worktree', 'add', '-b', 'feat/one', wtPath, 'my/dev'])
  ok('前置：worktree add 成功', !r1.startsWith('__ERROR__'), r1.trim().slice(0, 80))

  const { computeState } = await import('../../apps/desktop/src/main/services/worktree/list')
  const { compareKeyOfPath } = await import('../../apps/desktop/src/main/services/worktree/paths')

  const porcelain = () => git(repo, ['worktree', 'list', '--porcelain'])

  /** 与 list.ts 的 prunableKeysOf 完全一致：存归一化比较键。 */
  const prunableOf = (out) => {
    const keys = new Set()
    let cur = null
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) cur = line.slice('worktree '.length).trim()
      else if (line.startsWith('prunable') && cur) {
        try { keys.add(compareKeyOfPath(cur)) } catch {}
      }
    }
    return keys
  }
  /** 与 list.ts 的 entries.find 一致：按归一化比较键匹配。 */
  const entryOf = (out, p) => {
    let want = null
    try { want = compareKeyOfPath(p) } catch { return undefined }
    for (const b of out.split('\n\n')) {
      const m = b.match(/^worktree (.+)$/m)
      if (!m) continue
      let got = null
      try { got = compareKeyOfPath(m[1].trim()) } catch { continue }
      if (got !== want) continue
      const branch = (b.match(/^branch (.+)$/m) || [])[1]
      return { path: p, branch }
    }
    return undefined
  }
  const rec = (p, branch) => ({ path: p, branch, compareKey: compareKeyOfPath(p) })

  // ══ A 正常
  {
    const out = porcelain()
    const prun = prunableOf(out)
    const entry = entryOf(out, wtPath)
    const head = git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    const r = computeState({ record: rec(wtPath, 'feat/one'), dirExists: true, gitEntry: entry, prunable: prun.has(compareKeyOfPath(wtPath)), headBranch: head })
    info('A head', head)
    info('A 登记命中', String(!!entry))
    eq('A 正常（目录在+登记在+分支吻合）→ ok', r.state, 'ok')
  }

  // ══ B 切到别的分支
  {
    git(wtPath, ['checkout', '-b', 'other/branch'])
    const out = porcelain()
    const prun = prunableOf(out)
    const entry = entryOf(out, wtPath)
    const head = git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    const r = computeState({ record: rec(wtPath, 'feat/one'), dirExists: true, gitEntry: entry, prunable: prun.has(compareKeyOfPath(wtPath)), headBranch: head })
    info('B head', head)
    eq('B 切到别的分支 → branch-mismatch', r.state, 'branch-mismatch')
    eq('B actualBranch 是实际分支', r.actualBranch, 'other/branch')
    git(wtPath, ['checkout', 'feat/one'])
  }

  // ══ B2 detached HEAD
  {
    const sha = git(wtPath, ['rev-parse', 'HEAD']).trim()
    git(wtPath, ['checkout', '--detach', sha])
    const head = git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    const out = porcelain()
    const r = computeState({ record: rec(wtPath, 'feat/one'), dirExists: true, gitEntry: entryOf(out, wtPath), prunable: prunableOf(out).has(compareKeyOfPath(wtPath)), headBranch: head })
    info('B2 detached 时 rev-parse 返回', JSON.stringify(head))
    eq('B2 detached HEAD → branch-mismatch（不放过）', r.state, 'branch-mismatch')
    git(wtPath, ['checkout', 'feat/one'])
  }

  // ══ C 删掉目录（争议点）
  {
    fs.rmSync(wtPath, { recursive: true, force: true })
    ok('前置：目录确实删掉了', !fs.existsSync(wtPath))
    const out = porcelain()
    const lines = out.split('\n').filter((l) => l.trim())
    info('C 删目录后 porcelain 全文', JSON.stringify(out))
    const hasPrunableLine = lines.some((l) => l.startsWith('prunable'))
    info('C 有 prunable 行?', String(hasPrunableLine))
    const prun = prunableOf(out)
    const prunHit = prun.has(compareKeyOfPath(wtPath))
    info('C prunableKeys 命中该路径?', String(prunHit))
    const entry = entryOf(out, wtPath)
    const r = computeState({ record: rec(wtPath, 'feat/one'), dirExists: false, gitEntry: entry, prunable: prunHit, headBranch: null })
    info('C → computeState', JSON.stringify(r))
    eq('C 删目录后 git 确实输出 prunable 行', hasPrunableLine, true)
    eq('C 删目录后按比较键能命中 prunable', prunHit, true)
    eq('C 删目录 → prunable（不是 dir-missing）', r.state, 'prunable')
  }

  // ══ D 真 prune 之后
  {
    git(repo, ['worktree', 'prune'])
    const out = porcelain()
    const entry = entryOf(out, wtPath)
    const r = computeState({ record: rec(wtPath, 'feat/one'), dirExists: false, gitEntry: entry, prunable: prunableOf(out).has(compareKeyOfPath(wtPath)), headBranch: null })
    info('D prune 后登记还在?', String(!!entry))
    eq('D prune 后（登记已删+目录不在）→ dir-missing', r.state, 'dir-missing')
  }

  // ══ E 目录在、登记被外部删掉
  {
    const wt2 = path.join(root, 'wt-two')
    git(repo, ['worktree', 'add', '-b', 'feat/two', wt2, 'my/dev'])
    const adminDir = path.join(repo, '.git', 'worktrees')
    for (const d of fs.readdirSync(adminDir)) {
      const gd = path.join(adminDir, d, 'gitdir')
      if (fs.existsSync(gd) && fs.readFileSync(gd, 'utf8').includes('wt-two')) {
        fs.rmSync(path.join(adminDir, d), { recursive: true, force: true })
      }
    }
    const out = porcelain()
    const entry = entryOf(out, wt2)
    info('E 目录在?', String(fs.existsSync(wt2)))
    info('E 登记还在?', String(!!entry))
    const r = computeState({ record: rec(wt2, 'feat/two'), dirExists: fs.existsSync(wt2), gitEntry: entry, prunable: false, headBranch: 'feat/two' })
    eq('E 目录在但登记被删 → dir-missing（第 3 条，不新造第五态）', r.state, 'dir-missing')
  }

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' / ') : e)
  process.exit(2)
})