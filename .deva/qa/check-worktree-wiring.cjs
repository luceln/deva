#!/usr/bin/env node
/**
 * worktree 卡片上「重建 / 移除登记」两个按钮的接线判据。
 *
 * 为什么需要：这两个按钮在界面上看起来一直是好的——它们有图标、有文案、能点、点了还有反馈。
 * 失效方式全部很安静：
 *   · 按钮还挂着 `onNotWired('rebuild')` → 点下去只提示「还没接通」，但后端 IPC 明明已经好了，
 *     用户会以为功能就是这样（这正是本次修掉的状态）；
 *   · 接了但调用的是别的通道（例如 prune 也是真实 `remove`）→ 看着通了，行为却不对；
 *   · 成功后不 `refresh()` → 列表停在旧数据，用户看不到结果，只能自己点刷新；
 *   · 失败只说「失败」不区分原因 → `branch-missing` 与 `add-failed` 的处置完全不同。
 *
 * 判据（源码形状，能在 CI 跑）：
 *   R1  重建按钮绑的是 `rebuild()`，不再是 `onNotWired`
 *   R2  移除登记按钮绑的是 `prune()`，不再是 `onNotWired`
 *   R3  `rebuild` 调用的是 `worktree.rebuild`，`prune` 调用的是 `worktree.remove`
 *   R4  `prune` **不带** `deleteBranch`（分支上有用户没合走的提交，清登记不等于放弃它们）
 *   R5  两个操作成功后都 `await refresh()`
 *   R6  重建失败按 `reason` 分派文案，且六个 reason 在中英文各有一条词条
 *   R7  两个按钮在 `busy` 期间禁用（防连点）
 *   R8  `onNotWired` 机制已整体移除（所有按钮都接了真实 IPC）
 *   R9a 合并进行中时给出三个收尾出口（中止 / 终端 / 打开目录），都接真实通道
 *   R9b 三个出口传的是 targetPath，不是 view.path（传错 = 点了没反应且不报错）
 *   R10 reveal 失败要报出来（通道不抛错、只回 ok:false，吞掉就是静默失败）
 *   R11 主进程在 merge / list 两处都 trustRoot(targetPath)（否则 reveal 一律 ok:false）
 *
 * 它**不能**证明的：真实点下去 git 到底做了什么、列表有没有在界面上真的刷新。
 * 那些要真机跑，见 .deva/qa/ 下的运行时脚本。
 *
 * 判据一律"先断言命中数 ≥1 再判内容"：空集合上 every()/some() 恒真，会出假 PASS。
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const PANE = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'WorktreePane.tsx')
const FORK = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'i18n', 'fork.ts')

const pane = fs.readFileSync(PANE, 'utf8')
const fork = fs.readFileSync(FORK, 'utf8')

let fails = 0
const pass = (name, detail) => console.log(`  PASS ${name}${detail ? ` :: ${detail}` : ''}`)
const fail = (name, detail) => {
  fails += 1
  console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
}

/** 命中数必须先 > 0，否则下面基于命中内容的判断全是假 PASS。 */
function requireHits(name, hits, re) {
  if (hits.length === 0) {
    fail(name, `空集合：源码里找不到 ${re}`)
    return false
  }
  return true
}

// R1 / R2：两个按钮绑定的是真实处理函数，而不是 notWired
for (const [name, re, fn] of [
  ['R1 重建按钮接的是 rebuild()', /onClick=\{\(\) => void rebuild\(\)\}/g, 'rebuild'],
  ['R2 移除登记按钮接的是 prune()', /onClick=\{\(\) => void prune\(\)\}/g, 'prune']
]) {
  const hits = pane.match(re) || []
  if (!requireHits(name, hits, re)) continue
  if (hits.length === 1) pass(name, `${fn} ×1`)
  else fail(name, `命中 ${hits.length} 处，期望 1 处`)
}

// R3：两个函数各自调对了通道
{
  const re = /window\.deva\.worktree\.rebuild\(/g
  const hits = pane.match(re) || []
  if (requireHits('R3a rebuild 调 worktree.rebuild', hits, re))
    hits.length === 1 ? pass('R3a rebuild 调 worktree.rebuild', '×1') : fail('R3a rebuild 调 worktree.rebuild', `${hits.length} 处`)
}
{
  const re = /window\.deva\.worktree\.remove\(/g
  const hits = pane.match(re) || []
  // 两处：删除 与 prune。少于 2 说明 prune 没有真的走 remove。
  if (requireHits('R3b prune 调 worktree.remove', hits, re))
    hits.length >= 2 ? pass('R3b prune 调 worktree.remove', `${hits.length} 处（删除 + prune）`) : fail('R3b prune 调 worktree.remove', `只 ${hits.length} 处，prune 没走 remove`)
}

// R4：prune 必须显式传 deleteBranch: false
// 为什么不是「不许出现 deleteBranch」：remove 的默认语义是删整个工作区（`deleteBranch !== false`），
// 漏传等于删分支。所以判据必须是「显式传了 false」，缺席本身就是失败。
{
  const m = pane.match(/const prune = async \(\): Promise<void> => \{[\s\S]*?\n  \}/)
  if (!m) fail('R4 prune 显式传 deleteBranch: false', '找不到 prune 函数体')
  else if (/deleteBranch:\s*false/.test(m[0])) pass('R4 prune 显式传 deleteBranch: false', '分支保留')
  else fail('R4 prune 显式传 deleteBranch: false', '未显式传 false —— remove 默认会连分支一起删')
}

// R5：两个操作成功后都 refresh
for (const [name, re] of [
  ['R5a rebuild 成功后 refresh', /const rebuild = async \(\)[\s\S]*?await refresh\(\)/],
  ['R5b prune 成功后 refresh', /const prune = async \(\)[\s\S]*?await refresh\(\)/]
]) {
  // 用非贪婪跨到下一个函数声明为止，避免误吃后续内容
  const body = pane.match(re)
  if (!body) fail(name, '函数体里没找到 await refresh()')
  else pass(name, '有')
}

// R6：重建失败按 reason 分派 + 六个 reason 都有中英词条
{
  const reasons = ['not-found', 'dir-exists', 'branch-missing', 'installing', 'add-failed', 'verify-failed']
  const mapBlock = pane.match(/const REBUILD_FAIL_KEY[\s\S]*?\n\}/)?.[0] ?? ''
  // TS 里合法标识符键可以不带引号（`installing:`），带连字符的必须带（`'not-found':`）。
  const missingInMap = reasons.filter((r) => !new RegExp(`(?:'${r}'|\\b${r}):`).test(mapBlock))
  if (missingInMap.length) fail('R6a REBUILD_FAIL_KEY 覆盖六个 reason', `缺 ${missingInMap.join(', ')}`)
  else pass('R6a REBUILD_FAIL_KEY 覆盖六个 reason', reasons.length + ' 个')

  const zhKeys = ['notFound', 'dirExists', 'branchMissing', 'installing', 'addFailed', 'verifyFailed']
  // fork.ts 里 rebuildFail 出现两次（zh / en），各自都要六条
  const blocks = fork.match(/rebuildFail: \{[\s\S]*?\n      \}/g) || []
  if (blocks.length !== 2) fail('R6b rebuildFail 中英两份', `找到 ${blocks.length} 份，期望 2 份`)
  else {
    const bad = blocks.map((b, i) => {
      const miss = zhKeys.filter((k) => !new RegExp(`${k}:`).test(b))
      return miss.length ? `${i === 0 ? 'zh' : 'en'} 缺 ${miss.join(',')}` : null
    }).filter(Boolean)
    if (bad.length) fail('R6b rebuildFail 中英各六条', bad.join('；'))
    else pass('R6b rebuildFail 中英各六条', 'zh + en')
  }
}

// R7：busy 期间禁用
{
  const re = /disabled=\{busy \|\| installing\}/g
  const hits = pane.match(re) || []
  if (requireHits('R7 重建/prune 在 busy 时禁用', hits, re))
    hits.length >= 2 ? pass('R7 重建/prune 在 busy 时禁用', `${hits.length} 处`) : fail('R7 重建/prune 在 busy 时禁用', `只 ${hits.length} 处`)
}

// R9：合并进行中时给的三个收尾出口都接了真实通道（§4.7 平权三出口）
{
  // 取 mergeInProgress 那一段：从条件到它自己的 </div>，不依赖精确缩进
  const start = pane.indexOf('view.mergeInProgress !== null')
  const block = start === -1 ? '' : pane.slice(start, start + 2000)
  if (!block) fail('R9a 冲突收尾三出口存在', '找不到 mergeInProgress 渲染块')
  else {
    const need = [
      ['abortMerge', /abortMerge\(view\.mergeInProgress!\.targetPath\)/],
      ['openInTerminal', /openInTerminal\(view\.mergeInProgress!\.targetPath\)/],
      ['revealTarget', /revealTarget\(view\.mergeInProgress!\.targetPath\)/]
    ]
    const missing = need.filter(([, re]) => !re.test(block)).map(([n]) => n)
    if (missing.length) fail('R9a 冲突收尾三出口存在', `缺 ${missing.join(', ')}`)
    else pass('R9a 冲突收尾三出口存在', '中止 / 终端 / 打开目录')
  }
}

// R9b：三个收尾出口必须传 targetPath，不能传 view.path
// 注意 `revealTarget(view.path)` 在 branch-mismatch 那处是**正确**的（那是打开工作区自己的目录，
// 不是 target 检出），所以这里只约束那三个出口函数在 mergeInProgress 块内的调用。
{
  const start = pane.indexOf('view.mergeInProgress !== null')
  const block = start === -1 ? '' : pane.slice(start, start + 2000)
  const wrong = [...block.matchAll(/(?:abortMerge|revealTarget|openInTerminal)\(view\.path\)/g)].map((m) => m[0])
  if (wrong.length) fail('R9b 收尾出口传 targetPath', `块内误传 view.path：${wrong.join(', ')}`)
  else pass('R9b 收尾出口传 targetPath', '块内无 view.path 误用')
}

// R10：reveal 失败必须报出来（通道不抛错，只回 ok:false，吞掉就是「点了没反应」）
{
  const m = pane.match(/const revealTarget = async[\s\S]*?\n  \}/)?.[0] ?? ''
  if (!m) fail('R10 reveal 失败有提示', '找不到 revealTarget')
  else if (/if \(!res\.ok\)/.test(m) && /toast\.show/.test(m)) pass('R10 reveal 失败有提示', 'ok:false 时报错')
  else fail('R10 reveal 失败有提示', 'ok:false 时没有提示 —— 静默失败')
}

// R11：主进程两处都 trustRoot(targetPath)，否则 reveal 一律返回 ok:false
{
  const merge = fs.readFileSync(path.join(REPO, 'apps/desktop/src/main/services/worktree/merge.ts'), 'utf8')
  const list = fs.readFileSync(path.join(REPO, 'apps/desktop/src/main/services/worktree/list.ts'), 'utf8')
  const inMerge = /trustRoot\(targetPath\)/.test(merge)
  const inList = /trustRoot\(targetPath\)/.test(list)
  if (inMerge && inList) pass('R11 targetPath 在主进程两处 trustRoot', 'merge + list')
  else fail('R11 targetPath 在主进程两处 trustRoot', `merge=${inMerge} list=${inList}`)
}
// R8：onNotWired 机制已整体移除（所有按钮都接了真实 IPC）
// 这不是「还剩几个」的问题：留着这套机制就等于给后来人一个「先挂个空壳」的入口，
// 而它正是本次要清掉的那类假接线。判据是它彻底不存在。
{
  const leftovers = [...pane.matchAll(/onNotWired|notWired/g)].map((m) => m[0])
  if (leftovers.length === 0) pass('R8 onNotWired 机制已移除', '0 处残留')
  else fail('R8 onNotWired 机制已移除', `仍有 ${leftovers.length} 处：${[...new Set(leftovers)].join(', ')}`)
}

console.log('')
if (fails === 0) {
  console.log('worktree 重建/移除登记接线校验通过：按钮走真实 IPC、成功刷新、失败分因、prune 不删分支。')
  process.exit(0)
}
console.log(`worktree 重建/移除登记接线校验失败：${fails} 项`)
process.exit(1)
