/**
 * P1 验收 ②：unmanaged 假条目是否真的修好。
 *
 * 真 git 造：主检出 + 2 条受管 worktree + 1 条用户自己 add 的（不受管）。
 * 期望：unmanaged 只含用户那条，**不含主检出、也不含受管的那两条**。
 *
 * 同时验 listWorktrees 的 items 是否 3 条（2 受管 + ...），以及主检出不出现在任何一边。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-p1u-' + Date.now())
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
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { return `__ERROR__ ${e.status} ${(e.stderr || '').toString()}` }
}

;(async () => {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'my/dev'])
  git(repo, ['config', 'user.email', 'a@b.c'])
  git(repo, ['config', 'user.name', 'a'])
  fs.writeFileSync(path.join(repo, 'a.txt'), '1')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  const { normalizeWorktreePath } = await import('../../apps/desktop/src/main/services/worktree/paths')
  const store = await import('../../apps/desktop/src/main/services/worktree/store')
  const list = await import('../../apps/desktop/src/main/services/worktree/list')

  const mk = (name, branch) => {
    const p = path.join(root, name)
    git(repo, ['worktree', 'add', '-b', branch, p, 'my/dev'])
    return p
  }
  const wtA = mk('wt-a', 'feat/a')
  const wtB = mk('wt-b', 'feat/b')
  // 用户自己 add 的（不受管）
  const wtUser = mk('wt-user', 'feat/user')

  const nRepo = normalizeWorktreePath(repo)
  const nA = normalizeWorktreePath(wtA)
  const nB = normalizeWorktreePath(wtB)

  // 只把 A / B 记进 worktrees.json（user 那条不记）
  const baseRec = (n, branch, i) => ({
    schemaVersion: 1,
    path: n.path,
    compareKey: n.compareKey,
    repoRoot: nRepo.path,
    repoKey: require('crypto').createHash('sha1').update(nRepo.compareKey).digest('hex').slice(0, 16),
    branch,
    baseSha: 'a'.repeat(40),
    baseLabel: 'my/dev',
    targetBranch: 'my/dev',
    createdAt: Date.now() + i,
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped'
  })
  store.upsertRecord(baseRec(nA, 'feat/a', 0))
  store.upsertRecord(baseRec(nB, 'feat/b', 1))
  info('已写入受管记录数', String(store.listRecords().length))

  const snap = await list.listWorktrees()
  info('items', JSON.stringify(snap.items.map((i) => ({ path: path.basename(i.path), state: i.state }))))
  info('unmanaged', JSON.stringify(snap.unmanaged.map((u) => path.basename(u.path))))
  info('storeUnreadable', String(snap.storeUnreadable))

  const unmanagedNames = snap.unmanaged.map((u) => path.basename(u.path)).sort()
  eq('② unmanaged 只含用户自己建的那一条', unmanagedNames, ['wt-user'])
  eq('② unmanaged 不含主检出（假条目已修）', unmanagedNames.includes('repo'), false)
  eq('② unmanaged 不含受管的 A/B', unmanagedNames.filter((n) => n === 'wt-a' || n === 'wt-b'), [])
  eq('② items 恰好 2 条（受管的 A/B）', snap.items.length, 2)
  eq('② items 里没有主检出', snap.items.some((i) => path.basename(i.path) === 'repo'), false)
  eq('② 两条受管都判 ok', snap.items.map((i) => i.state).sort(), ['ok', 'ok'])

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' / ') : e)
  process.exit(2)
})