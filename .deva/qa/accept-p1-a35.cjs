/**
 * P1 验收 ③：A35 记忆共享 —— 正向链路 + 反证有效性。
 *
 * A35 说「worktree 里写入记忆 → 主仓库立即可读」。
 *
 * 要验三件事：
 *  (a) 正向：真在 worktree 场景写一条、从主仓库读，能读到（走真实 saveMemories/listMemories）
 *  (b) 反证是否有效：断言是不是只是「形状匹配」（比如 trim 后比较、或包含关系太松）
 *  (c) **那个反向断言本身站不站得住**：它说「直接用 worktree 路径当记忆根读不到」——
 *      但如果 projectMemoryRootOf 被改成恒返回入参，这条反向断言会不会也一起变？
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'acc-p1a35-' + Date.now())
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
  const S = await import('../../apps/desktop/src/main/services/worktree/store')
  const M = await import('../../apps/desktop/src/main/services/memory')
  const SCOPE = await import('../../apps/desktop/src/main/services/worktree/scope')

  // 真仓库
  const repo = path.join(DST, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'my/dev'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: repo, stdio: 'ignore' })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

  const wt = path.join(DST, 'wts', 'case')
  const r = await CR.createWorktree({ repoRoot: repo, branch: 'wt/case', path: wt, skipDeps: true })
  ok('前置：真建出 worktree', r.ok === true, JSON.stringify(r).slice(0, 160))
  if (!r.ok) { console.log('=== 无法继续 ==='); process.exit(1) }

  // ── (a) 正向链路
  const memoryRoot = SCOPE.projectMemoryRootOf(wt)
  info('projectMemoryRootOf(worktree)', String(memoryRoot))
  eq('A35 正向：worktree 的记忆根 = 主仓库根', memoryRoot, repo)

  const marker = 'A35-VERIFY-' + Date.now()
  const wrote = M.writeMemory(`${marker} 内容`, undefined, { kind: 'project', root: memoryRoot })
  eq('A35 正向：写入成功', wrote.ok, true)

  const fromPrimary = M.listMemories({ kind: 'project', root: repo })
  info('主仓库读到', JSON.stringify(fromPrimary.map((e) => e.content)))
  ok('A35 正向：主仓库**立即可读**到 worktree 写的那条',
    fromPrimary.some((e) => e.content.includes(marker)), String(fromPrimary.length) + ' 条')

  // 磁盘层核对：确认真的只有一份文件（不是两份碰巧内容相同）
  const projectsDir = path.join(DST, 'projects')
  const dirs = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []
  info('projects 下的目录数', String(dirs.length) + ' ' + JSON.stringify(dirs))
  eq('A35：项目记忆只有一份（不是 worktree 与仓库各一份）', dirs.length, 1)

  // ── (b) 反证有效性：直接拿 worktree 路径当根读
  const wrongRoot = M.listMemories({ kind: 'project', root: wt })
  info('用 worktree 路径当根读到', JSON.stringify(wrongRoot.map((e) => e.content)))
  ok('A35 反向（原断言）：直接用 worktree 路径当记忆根读不到',
    !wrongRoot.some((e) => e.content.includes(marker)), String(wrongRoot.length) + ' 条')

  // ── (c) 这个反证到底测的是什么？它测的是「按路径字面算键」与「按 repoRoot 算键」不同。
  // 关键问题：如果 projectMemoryRootOf 恒返回入参（即 bug 版），正向断言会红，反向断言会怎样？
  // 单独算两种键，看它们是否真的不同 —— 这决定了反向断言能否作为有效反证。
  const keyRepo = M.projectMemoryKey(repo)
  const keyWt = M.projectMemoryKey(wt)
  info('key(repo)', keyRepo)
  info('key(worktree)', keyWt)
  eq('(c) 两种键确实不同（反向断言不是恒真）', keyRepo !== keyWt, true)
  ok('(c) 反证有效：若 root 错用 worktree，读的是另一个不存在的键',
    M.listMemories({ kind: 'project', root: wt }).length === 0, String(wrongRoot.length))

  M.clearMemories({ kind: 'project', root: memoryRoot })

  console.log(`=== 结束：FAIL ${fails} ===`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  process.exit(fails > 0 ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' / ') : e)
  process.exit(2)
})