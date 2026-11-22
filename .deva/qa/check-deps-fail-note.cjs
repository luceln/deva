#!/usr/bin/env node
/**
 * 「依赖装失败时必须说会话仍可使用」—— spec §7.7 屏⑤ / A27 的静态判据。
 *
 * 为什么需要：依赖装失败时若只给 `depsDetail` 的末尾 20 行报错，用户看到一片红字会以为
 * 这个工作区废了；而事实是工作区本身好用，只是 pnpm / npm 类命令会失败。spec 因此要求
 * **同时**显示「会话仍可使用」。这条很难靠人盯着守：明细长、句子短，删掉它没有任何编译或
 * 类型层面的反馈。
 *
 * 判据（全部为源码形状，能在 CI 跑）：
 *   F1  WorktreePane 有 `deps === 'failed'` 的渲染分支
 *   F2  该分支里同时出现「仍可使用」的 i18n key 与 `depsDetail`
 *   F3  中英词条都存在且非空
 *   F4  该提示**不是**折叠/悬停才有的（不在 `<details>`、不带 `title=` / `aria-label=` 独占）
 *   F5  「仍可使用」的 key 在渲染分支里被 `t(...)` 调用（不是只定义了词条没接上）
 *
 * 它**不能**证明的：这句话在真实界面里的可读性（位置、对比度），以及失败时是否真的渲染出明细。
 * 那要浏览器，见 .deva/qa/ 下的运行时脚本。
 *
 * 判据一律「先断言命中数 ≥1 再判内容」：空集合上 every()/some() 恒真，会出假 PASS。
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const PANE = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'WorktreePane.tsx')
// 词条不再从 `messages.ts` 的文本里抠：二开词条已搬到 `i18n/fork.ts`（由 messages.ts 深合并），
// 扫文本会在拆分后静默失效（CI 报 “F3 只找到 0 处”，而词条其实还在）。改读运行时值，见 lib/i18n-source。
const { readI18n, checkKeys } = require('./lib/i18n-source.cjs')

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
if (pane === null) bad('F0 读得到 WorktreePane.tsx', PANE)

/** i18n 词条（运行时值）。读失败时给 null，F3 会如实报红而不是静默跳过。 */
let i18n = null
try {
  i18n = readI18n()
} catch (e) {
  bad('F0 读得到 i18n 词条', String(e && e.message))
}

/** 取某个 `{ ... }` 块的文本（从 openIdx 处的 `{` 起，按花括号配对）。取不到返回 null。 */
function blockAt(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(openIdx, i + 1)
    }
  }
  return null
}

/** 找到 `view.deps === 'failed'` 的条件渲染块（`{cond && (` 之后的那段 JSX）。 */
function failedBlock(text) {
  const re = /view\.deps\s*===\s*'failed'/g
  const blocks = []
  let m
  while ((m = re.exec(text)) !== null) {
    // 从条件表达式往后取一段足够的窗口：JSX 里没有配对标记，取到该行之后 1200 字符是安全的
    // （被检查的内容都在紧邻的几行里，取窗口不会跨到别的分支）。
    blocks.push(text.slice(m.index, m.index + 1200))
  }
  return blocks
}

if (pane !== null && i18n !== null) {
  // ── F1：存在 failed 分支 ──
  const blocks = failedBlock(pane)
  if (blocks.length === 0) {
    bad('F1 WorktreePane 有 deps === \'failed\' 的渲染分支', '一处也没找到')
  } else {
    ok('F1 WorktreePane 有 deps === \'failed\' 的渲染分支', `${blocks.length} 处`)
  }

  // ── F5 / F2：分支里既调用 stillUsable，也渲染 depsDetail ──
  if (blocks.length > 0) {
    const withStill = blocks.filter((b) => /t\(\s*'cf\.wt\.deps\.stillUsable'\s*\)/.test(b))
    const withDetail = blocks.filter((b) => /depsDetail/.test(b))
    const both = blocks.filter(
      (b) => /t\(\s*'cf\.wt\.deps\.stillUsable'\s*\)/.test(b) && /depsDetail/.test(b)
    )
    if (withStill.length === 0) {
      bad('F5 failed 分支里调用了 cf.wt.deps.stillUsable', '没有')
    } else {
      ok('F5 failed 分支里调用了 cf.wt.deps.stillUsable', `${withStill.length} 处`)
    }
    if (withDetail.length === 0) bad('F2 failed 分支里渲染 depsDetail', '没找到')
    else ok('F2 failed 分支里渲染 depsDetail', `${withDetail.length} 处`)
    if (both.length === 0) bad('F2 两者在**同一个**分支里同时出现', '分别出现在不同分支')
    else ok('F2 两者在**同一个**分支里同时出现', `${both.length} 处`)
  }

  // ── F3：中英词条都在且非空（读运行时值，不扫源码文本）──
  //
  // 原实现扫 `messages.ts` 找 `stillUsable: '…'` 两处。i18n 拆分后这条词条搬进了 `fork.ts`，
  // 正则一处也找不到 → 报「只找到 0 处」，而词条其实完好。改为按 key 取运行时值：
  // 每个语言必须都有一条且非空，语义比原来的「文本里出现 ≥2 次」更准（原来是靠同名子串计数的）。
  {
    const r = checkKeys(['cf.wt.deps.stillUsable'])
    if (!r.ok) bad('F3 stillUsable 词条中英各一条且非空', r.detail)
    else ok('F3 stillUsable 词条中英各一条且非空', r.detail)
  }

  // ── F4：不是折叠/悬停才有的 ──
  // 「折叠」= 提示被 <details>/<summary> 收起来；「悬停才有」= 只出现在 title / aria-label 里。
  // 本仓从不用原生 <details>（见项目记忆），这条主要防后者与将来的回归。
  if (blocks.length > 0) {
    const folded = blocks.filter((b) => /<details|<summary/.test(b))
    if (folded.length > 0) bad('F4 提示不靠折叠', '出现在 <details> 里')
    else ok('F4 提示不靠折叠', '无 details/summary')

    // 可见性：分支里必须有一个「把 stillUsable 当子节点渲染」的地方，
    // 即 `t('cf.wt.deps.stillUsable')` 出现在标签之间（`>` 与 `<` 之间），而不是出现在属性值里。
    const visible = blocks.some((b) => {
      const re = /t\(\s*'cf\.wt\.deps\.stillUsable'\s*\)/g
      let m
      while ((m = re.exec(b)) !== null) {
        const before = b.slice(Math.max(0, m.index - 200), m.index)
        const lastOpen = before.lastIndexOf('>')
        const lastAttr = before.search(/\b(title|aria-label)\s*=\s*\{[^}]*$/)
        if (lastOpen >= 0 && lastAttr === -1) return true
      }
      return false
    })
    if (!visible) bad('F4 提示是可见文本', '只出现在属性里，用户看不到')
    else ok('F4 提示是可见文本', '作为子节点渲染')
  }
}

// ── 输出 ──
for (const p of passes) console.log(`PASS ${p}`)
for (const p of problems) console.log(`FAIL ${p}`)
console.log(`\n共 ${passes.length} PASS / ${problems.length} FAIL`)
process.exit(problems.length === 0 ? 0 : 1)
