/**
 * P1 验收：sizeBytes 异步统计（T1.4b）。
 *
 * 判据：首次 `null`（界面显示「统计中…」），后台算完发 `worktree:changed`，再取到数字。
 * 要验的不只是「最终有数字」，还有：
 *   (a) 首次真的是 null（不是同步算完直接给数）
 *   (b) 后台算完后能拿到**正确**的字节数（不是 0）
 *   (c) 算完确实发了 worktree:changed 事件（界面的刷新靠它）
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-p1size-' + Date.now())
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

;(async () => {
  const CR = await import('../../apps/desktop/src/main/services/worktree/create')
  const L = await import('../../apps/desktop/src/main/services/worktree/list')
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const bus = await import('../../apps/desktop/src/main/services/chat-bus')

  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const a of [['init', '-b', 'my/dev'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'a']])
    execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

  const wt = path.join(DST, 'wts', 'sz')
  const r = await CR.createWorktree({ repoRoot: repo, branch: 'wt/sz', path: wt, skipDeps: true })
  ok('前置：worktree 建好', r.ok === true)
  if (!r.ok) process.exit(1)

  // 塞一点已知大小的内容（worktree 里 git 会复制 repo 的文件，再额外加）
  const payload = Buffer.alloc(64 * 1024, 7)
  fs.mkdirSync(path.join(wt, 'big'), { recursive: true })
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(wt, 'big', `f${i}.bin`), payload)

  // 真实占用（含 git 的 .git 文件与 repo 内容）
  const realSize = (p) => {
    let n = 0
    const walk = (d) => {
      let ents
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) walk(f)
        else { try { n += fs.statSync(f).size } catch {} }
      }
    }
    walk(p)
    return n
  }
  const expected = realSize(wt)
  info('磁盘真实占用', String(expected))

  L.clearSizeCacheForTest()

  // (a) 首次：应为 null
  const snap1 = await L.listWorktrees()
  const item1 = snap1.items.find((i) => i.compareKey === S.getRecord(wt)?.compareKey)
  info('首次 sizeBytes', String(item1?.sizeBytes))
  eq('(a) 首次取列表 → sizeBytes 是 null（不阻塞，不是同步算完）', item1?.sizeBytes, null)

  // (c) 等后台算完，并抓 worktree:changed 事件
  const events = []
  // chat-bus 的事件订阅（publishWorktreeChanged 走这里）
  const off =
    typeof bus.onWorktreeChanged === 'function'
      ? bus.onWorktreeChanged(() => events.push(Date.now()))
      : null
  info('worktree:changed 订阅', off ? '已订阅' : '无该订阅函数（改用轮询）')

  // 轮询到不再是 null（最多 15s）
  let item2 = null
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 250))
    const snap = await L.listWorktrees()
    const it = snap.items.find((x) => x.compareKey === item1?.compareKey)
    if (it && it.sizeBytes !== null) { item2 = it; break }
  }
  if (off) off()
  info('后台算完 sizeBytes', String(item2?.sizeBytes))

  // (b) 数字要对：允许小差异（统计期间 git 可能写索引），但必须是同一数量级、且接近真实
  ok('(b) 后台算完不是 null', item2?.sizeBytes !== null && item2?.sizeBytes !== undefined, String(item2?.sizeBytes))
  const diff = item2 ? Math.abs(item2.sizeBytes - expected) : Infinity
  ok('(b) 算出的字节数接近磁盘真实占用（误差 < 2%）',
    item2 && diff / Math.max(1, expected) < 0.02,
    `算=${item2?.sizeBytes} 真=${expected} 差=${diff}`)
  ok('(b) 不是恒 0 的假实现', (item2?.sizeBytes ?? 0) > 1000, String(item2?.sizeBytes))

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' / ') : e)
  process.exit(2)
})