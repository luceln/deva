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
const MSG = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'i18n', 'messages.ts')

const passes = []
const problems = []
const ok = (n, d) => passes.push(d ? `${n} —— ${d}` : n)
const bad = (n, d) => problems.push(d ? `${n} —— ${d}` : n)

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const pane = read(PANE)
const msg = read(MSG)
if (pane === null) bad('G0 读得到 WorktreePane.tsx', PANE)
if (msg === null) bad('G0 读得到 messages.ts', MSG)

const BLOCKERS = ['target-not-set', 'source-missing', 'source-branch-changed', 'installing']

if (pane !== null && msg !== null) {
  // ── G1：合并按钮的 disabled 绑 mergeGate.mayMerge ──
  // 找合并按钮那一段（`onClick={() => onNotWired('merge')}` 之前 400 字符内），检查 disabled 表达式。
  const mergeIdx = pane.indexOf("onNotWired('merge')")
  if (mergeIdx === -1) {
    bad('G1 找得到合并按钮', "没有 onNotWired('merge')")
  } else {
    const seg = pane.slice(Math.max(0, mergeIdx - 600), mergeIdx)
    const dis = seg.match(/disabled=\{([^}]*)\}/)
    if (!dis) {
      bad('G1 合并按钮的 disabled 绑 mergeGate', '没找到 disabled 属性（按钮永远可点）')
    } else if (/mergeGate\s*\.\s*mayMerge/.test(dis[1]) && /!\s*view\s*\.\s*mergeGate\s*\.\s*mayMerge/.test(dis[1])) {
      ok('G1 合并按钮的 disabled 绑 mergeGate', dis[1].trim())
    } else {
      bad('G1 合并按钮的 disabled 绑 mergeGate', `实际是 ${dis[1].trim()}`)
    }

    // ── G2：title 从 blocker 取文案 ──
    const title = seg.match(/title=\{([\s\S]{0,300}?)\}\n/)
    if (!title) bad('G2 合并按钮的 title 取 blocker 文案', '没找到 title')
    else if (/mergeGate\s*\.\s*blocker/.test(seg) && /BLOCKER_KEY\[/.test(seg)) {
      ok('G2 合并按钮的 title 取 blocker 文案', seg.includes('BLOCKER_KEY[') ? 'BLOCKER_KEY[...]' : '')
    } else bad('G2 合并按钮的 title 取 blocker 文案', '没有引用 mergeGate.blocker / BLOCKER_KEY')
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
    // 取中英各一个 blocker 块：`blocker: {` 之后到配对的 `}` 之前。
    const blockerBlocks = []
    const reB = /blocker:\s*\{/g
    let mb
    while ((mb = reB.exec(msg)) !== null) {
      let depth = 0
      for (let i = mb.index + mb[0].length - 1; i < msg.length; i++) {
        if (msg[i] === '{') depth++
        else if (msg[i] === '}') {
          depth--
          if (depth === 0) {
            blockerBlocks.push(msg.slice(mb.index, i + 1))
            break
          }
        }
      }
    }
    if (blockerBlocks.length < 2) {
      bad('G3 找得到中英两个 blocker 块', `只找到 ${blockerBlocks.length} 个`)
    } else {
      const missing = []
      for (const n of flat) {
        // 每个块里都要有一条 `n: '...'`，且键名精确（`installingRenamed:` 不算）。
        const re = new RegExp(`(?<![\\w$])${n}:\\s*'([^']*)'`, 'g')
        for (const [i, blk] of blockerBlocks.entries()) {
          const hits = [...blk.matchAll(re)]
          if (hits.length !== 1) missing.push(`${n} 在第 ${i + 1} 个块里 ${hits.length} 条`)
          else if (hits[0][1].trim().length === 0) missing.push(`${n} 在第 ${i + 1} 个块里是空串`)
        }
      }
      if (missing.length > 0) bad('G3 四个 blocker 中英文案各一条且非空', missing.join('、'))
      else ok('G3 四个 blocker 中英文案各一条且非空', `${flat.join(', ')}（中英两块各一条）`)
    }
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
      const zeroLiteral = msg.includes('dirtyClean:')
      if (!zeroLiteral) bad('G4 null 与 0 用不同词条', 'dirtyClean 词条不存在')
      else ok('G4 null 与 0 用不同词条', `null → ${nullK[1]}，0 → cf.wt.dirtyClean`)
    }
  }

  // ── G5：mergeInProgress 非 null 时渲染 unmergedCount ──
  const mip = pane.match(/view\.mergeInProgress\s*!==\s*null[\s\S]{0,600}?<\/div>/)
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
