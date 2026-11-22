#!/usr/bin/env node
/**
 * worktree 卡片上三个字段的渲染判据：`mergeGate` / `dirtyCount` / `mergeInProgress`。
 *
 * 为什么需要：这三个字段是"主进程算好、界面照着显示"的（A48：渲染层不复算）。
 * 它们的失效方式都很安静：
 *   · `mergeGate` 拿到却不用 → 合并按钮永远可点，点了才失败（正是 A48 要防的「两处各算一遍」）；
 *   · `disabled` 恒 false（或写死某值）→ 上面那条的一半，且断开不会有任何编译反馈；
 *   · `dirtyCount` 的 `null` 当 `0` 渲染 → 目录没了却显示"没有未提交改动"，用户以为工作区是干净的；
 *   · `mergeInProgress` 拿到却不用 → target 里挂着半截合并没人知道。
 *
 * 判据（全部为源码形状，能在 CI 跑）：
 *   G1  合并按钮的 `disabled` 绑的是 `!...mergeGate.mayMerge`（不是常量、不按 state 推算）
 *   G2  合并按钮的 `title` 从 `blocker` 取文案
 *   G3  四个 blocker 值各有一条中英文案，且键名与 `BLOCKER_KEY` 对得上
 *   G4  `dirtyCount` 的三态（null / >0 / ===0）各自渲染了不同的内容
 *   G5  `mergeInProgress` 非 null 时渲染了 `unmergedCount`
 *   G6  `WorktreePane` 里没有任何「按 state 自己判能不能合并」的推断（A48 的另一半）
 *
 * 它**不能**证明的：真实渲染出来的样子、文案在界面上够不够显眼、点了按钮会发生什么。
 * 那些要浏览器，见 .deva/qa/ 下的运行时脚本。
 *
 * 判据一律"先断言命中数 ≥1 再判内容"：空集合上 every()/some() 恒真，会出假 PASS。
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const PANE = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'WorktreePane.tsx')
// 词条不再从 `messages.ts` 的文本里抠：二开词条已搬到 `i18n/fork.ts`（由 messages.ts 深合并），
// 扫文本会在拆分后静默失效（「找不到 block」→ 报红，或更坏：同名子串还在→假 PASS）。改读运行时值。
const { readI18n, checkKeys } = require('./lib/i18n-source.cjs')

const passes = []
const problems = []
const ok = (n, d) => passes.push(d ? `${n} —— ${d}` : n)
const bad = (n, d) => problems.push(d ? `${n} —— ${d}` : n)

/**
 * 从 `from`（指向 `{` 的位置）起按花括号配平，返回含外层花括号的整段。
 * 配不平（到文件尾还没闭合）返回 null —— 那说明源码本身是坏的，不该当成「找到了」。
 */
function sliceBraced(text, from) {
  if (text[from] !== '{') return null
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const pane = read(PANE)
if (pane === null) bad('G0 读得到 WorktreePane.tsx', PANE)

/** i18n 词条（运行时值）。读失败给 null，依赖它的检查会如实报红。 */
let i18n = null
try {
  i18n = readI18n()
} catch (e) {
  bad('G0 读得到 i18n 词条', String(e && e.message))
}

const BLOCKERS = ['target-not-set', 'source-missing', 'source-branch-changed', 'installing']

if (pane !== null && i18n !== null) {
  // ── G1：合并按钮的 disabled 绑 mergeGate.mayMerge ──
  /*
   * 锚点不能写死成某个占位字符串：`onNotWired('merge')` 只在按钮**还没接上**时存在，
   * 真接上（`onClick={() => setMergeOpen(true)}`）之后它就没了——检查会从「按钮接得对不对」
   * 退化成「按钮是不是还没接」，界面做完了反而报红。
   *
   * 改为按语义找：`disabled` 直接读 `mergeGate.mayMerge` 的那个按钮就是合并按钮。
   * 这恰好也是 G1 要验的东西（可用性只能由主进程的 mergeGate 决定），
   * 所以找不到它本身就是失败，不需要另设锚点。
   */
  const mergeBtn = /disabled=\{([^}]*mergeGate\s*\.\s*mayMerge[^}]*)\}/.exec(pane)
  const mergeIdx = mergeBtn ? mergeBtn.index : -1
  if (mergeIdx === -1) {
    bad(
      'G1 找得到合并按钮',
      '没有 disabled 读 mergeGate.mayMerge 的按钮（合并按钮未接，或可用性改成界面自己算）'
    )
  } else {
    const seg = pane.slice(Math.max(0, mergeIdx - 600), mergeIdx + 900)
    const expr = mergeBtn[1].trim()
    if (/mergeGate\s*\.\s*mayMerge/.test(expr) && /!\s*view\s*\.\s*mergeGate\s*\.\s*mayMerge/.test(expr)) {
      ok('G1 合并按钮的 disabled 绑 mergeGate', expr)
    } else {
      bad('G1 合并按钮的 disabled 绑 mergeGate', `实际是 ${expr}`)
    }

    // ── G2：title 从 blocker 取文案 ──
    /*
     * 不写死「`}` 后紧跟换行」：title 表达式跨多行、后面还跟着别的属性时那种形状就匹配不上，
     * 会报「没找到 title」——而 title 其实好好地在。改为从 `title={` 起按花括号配平取到闭合处。
     */
    const titleStart = seg.indexOf('title={')
    const titleExpr = titleStart === -1 ? null : sliceBraced(seg, titleStart + 'title='.length)
    if (titleExpr === null) bad('G2 合并按钮的 title 取 blocker 文案', '没找到 title')
    else if (/mergeGate\s*\.\s*blocker/.test(titleExpr) && /BLOCKER_KEY\[/.test(titleExpr)) {
      ok('G2 合并按钮的 title 取 blocker 文案', 'mergeGate.blocker → BLOCKER_KEY[...]')
    } else bad('G2 合并按钮的 title 取 blocker 文案', `实际是 ${titleExpr.slice(0, 120)}`)
  }

  // ── G6：不按 state 自己推算合并可用性（A48 的另一半）──
  // 合并按钮附近出现 `state ===` / `state !==` 就算可疑（合并可用性只能读 mergeGate）。
  if (mergeIdx !== -1) {
    const seg = pane.slice(Math.max(0, mergeIdx - 600), mergeIdx)
    if (/view\.state\s*[!=]==/.test(seg)) {
      bad('G6 不按 state 推算合并可用性（A48）', '合并按钮附近出现 view.state 比较')
    } else {
      ok('G6 不按 state 推算合并可用性（A48）', '附近无 view.state 比较')
    }
  }
  // 全文件里不该出现「state 决定 disabled」的形状
  const stateDisabled = [...pane.matchAll(/disabled=\{[^}]*view\.state[^}]*\}/g)].map((m) => m[0])
  if (stateDisabled.length > 0) {
    bad('G6 没有用 state 决定 disabled 的地方', stateDisabled.join(' | '))
  } else {
    ok('G6 没有用 state 决定 disabled 的地方', '')
  }

  // ── G3：四个 blocker 各有一条中英文案，键名与 BLOCKER_KEY 对得上 ──
  // BLOCKER_KEY 里每个值必须是 `cf.wt.merge.blocker.<name>`。
  // 键名可能带引号（`'target-not-set'`）也可能不带（`installing` 是合法标识符）——两种都认。
  const mapBlock = pane.slice(pane.indexOf('const BLOCKER_KEY'), pane.indexOf('const BLOCKER_KEY') + 600)
  const missingMap = BLOCKERS.filter(
    (b) => !new RegExp(`'?${b}'?:\\s*'cf\\.wt\\.merge\\.blocker\\.\\w+'`).test(mapBlock)
  )
  if (missingMap.length > 0) {
    bad('G3 BLOCKER_KEY 覆盖四个 blocker', `缺 ${missingMap.join(', ')}`)
  } else {
    ok('G3 BLOCKER_KEY 覆盖四个 blocker', BLOCKERS.join(', '))
  }

  // 取 BLOCKER_KEY 里用到的具体 key 名，逐个在**中英两段的 `merge.blocker` 块内**找（中英各一条）。
  //
  // 为什么必须限定在 blocker 块内：`installing` 这个名字在 `deps` 段（「安装中」）与 `remove` 段
  // （「正在安装依赖…」）里各有一份，全文件搜同名 key 会被它们满足——blocker 自己那条删了也照样绿。
  const keyNames = [...mapBlock.matchAll(/'(cf\.wt\.merge\.blocker\.\w+)'/g)].map((m) => m[1])
  if (keyNames.length !== 4) {
    bad('G3 BLOCKER_KEY 有 4 个 key', `实际 ${keyNames.length}`)
  } else {
    const flat = keyNames.map((k) => k.replace('cf.wt.merge.blocker.', ''))
    /*
     * 读运行时值：每个 blocker key 必须在**所有语言**里都存在且非空。
     *
     * 原实现靠两个文本特征：`blocker: {` 出现两次（中英各一块）、每块里 `n: '…'` 恰好一条。
     * 那套判据绑死了「词条住在同一个文件、中英各写一块、缩进形状不变」。词条搬进 fork.ts、
     * 或上游调整了字典嵌套，就会误报「找不到 block」。改为按 key 取值后，语义反而更准：
     * 「四个 blocker 在每种语言里各有一条且非空」。
     */
    const r = checkKeys(keyNames)
    if (!r.ok) bad('G3 四个 blocker 中英文案各一条且非空', r.detail)
    else ok('G3 四个 blocker 中英文案各一条且非空', `${flat.join(', ')}（${i18n.locales.join('/')} 各一条）`)
  }

  // ── G4：dirtyCount 三态分别渲染 ──
  const hasNull = /view\.dirtyCount\s*===\s*null/.test(pane)
  const hasPos = /view\.dirtyCount\s*>\s*0/.test(pane)
  const hasZero = /dirtyClean/.test(pane)
  if (!hasNull) bad('G4 dirtyCount === null 单独处理', '没找到 === null 分支')
  else ok('G4 dirtyCount === null 单独处理', '')
  if (!hasPos) bad('G4 dirtyCount > 0 单独处理', '没找到 > 0 分支')
  else ok('G4 dirtyCount > 0 单独处理', '')
  if (!hasZero) bad('G4 dirtyCount === 0 单独处理', '没找到零值文案（dirtyClean）')
  else ok('G4 dirtyCount === 0 单独处理', 'dirtyClean')
  // null 与 0 必须落到不同的词条（不能都写成 dirtyMeta）
  if (hasNull && hasZero) {
    const nullK = pane.match(/dirtyCount\s*===\s*null[\s\S]{0,200}?t\('(cf\.wt\.\w+)'\)/)
    const cleanK = pane.match(/dirtyClean/)
    if (nullK && cleanK) {
      // 读运行时值判断 `cf.wt.dirtyClean` 是否存在（原来在 messages.ts 文本里找 `dirtyClean:`）
      const zeroLiteral = i18n.locales.every((loc) => Object.hasOwn(i18n.entry('cf.wt.dirtyClean') ?? {}, loc))
      if (!zeroLiteral) bad('G4 null 与 0 用不同词条', 'cf.wt.dirtyClean 词条不存在')
      else ok('G4 null 与 0 用不同词条', `null → ${nullK[1]}，0 → cf.wt.dirtyClean`)
    }
  }

  // ── G5：mergeInProgress 非 null 时渲染 unmergedCount ──
  // 窗口放在 1500 字符：这块后来加了三个收尾出口（中止 / 终端 / 打开目录），
  // 600 已经装不下，而判据要守的是「拿到 unmergedCount 就渲染出来」，与块的长度无关。
  const mip = pane.match(/view\.mergeInProgress\s*!==\s*null[\s\S]{0,1500}?<\/div>/)
  if (!mip) {
    bad('G5 mergeInProgress 非 null 时渲染', '没找到 mergeInProgress !== null 的渲染块')
  } else if (!/unmergedCount/.test(mip[0])) {
    bad('G5 mergeInProgress 渲染了 unmergedCount', '块里没有 unmergedCount')
  } else {
    ok('G5 mergeInProgress 渲染了 unmergedCount', '')
  }
}

// ── 输出 ──
for (const p of passes) console.log(`PASS ${p}`)
for (const p of problems) console.log(`FAIL ${p}`)
console.log(`\n共 ${passes.length} PASS / ${problems.length} FAIL`)
process.exit(problems.length === 0 ? 0 : 1)
