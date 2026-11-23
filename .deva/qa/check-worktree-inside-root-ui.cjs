#!/usr/bin/env node
/**
 * 工作区卡片「根外标注」—— 界面判据（A11 / A28 的渲染侧）。
 *
 * ## 为什么需要
 *
 * `check-worktree-root.cjs` 守的是主进程数据层，但那套断言全在数据层 ——
 * **界面一处都没渲染**它也能全绿。本文件补的是「字段到像素」这一段。
 *
 * ## 真正要防的是什么（两个独立的失效，都已真实发生过）
 *
 * **失效一：判定条件写成真值判断。** 若字段可选，最自然的写法 `{!view.insideRoot && …}`
 * 在 `undefined` 时为真，于是所有老记录一上线就被标成「不在当前根内」——
 * 用户会去改根 / 去搬目录，而那个目录其实没问题。所以条件必须是 `=== false`。
 *
 * **失效二（更隐蔽）：主进程拿错了比较基准。** 曾经 `list.ts` 写的是
 * `isInsideRoot(rec.createdUnderRoot, rec.path)` —— `createdUnderRoot` 是创建时冻结的根，
 * 而记录本来就建在那个根下，两者同源 → 恒为 true → **徽标永不出现**。
 * 界面代码完全正确、判据全绿，功能却等于没实现。
 * 需求原文三处（§11.2 / §10.1b / §10.2）写的是「**当前**根」，且 A11 要求老记录也标注，
 * 而老记录没有 `createdUnderRoot` —— 按创建时根根本算不出来。
 * 所以本文件除了守界面，还要守**主进程用的基准是当前根**，否则界面判据会替一个死功能背书。
 *
 * ## 剥注释
 *
 * 所有匹配前先剥掉注释。本文件的注释里就写着 `insideRoot`、`=== false` 这些字样，
 * 不剥的话「删掉代码」也能从注释里匹配到，判据会假绿（备份页判据踩过这个坑）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const R = (p) => path.join(ROOT, p)
const PANE = R('apps/desktop/src/renderer/src/redesign/WorktreePane.tsx')
const I18N = R('apps/desktop/src/renderer/src/i18n/fork.ts')
const LIST = R('apps/desktop/src/main/services/worktree/list.ts')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass += 1
  console.log(`  PASS ${n}${d ? ` :: ${d}` : ''}`)
}
const bad = (n, d) => {
  fail += 1
  console.log(`  FAIL ${n}${d ? ` :: ${d}` : ''}`)
}

const pane = stripComments(fs.readFileSync(PANE, 'utf8'))
const i18n = fs.readFileSync(I18N, 'utf8')

/* ══════════ 1. 条件必须是 `=== false`，绝不能是取反 ══════════ */
console.log('\n== 1. 判定条件是 `=== false`，不是真值判断 ==')

/* 找出所有「消费 insideRoot」的表达式 */
const uses = [...pane.matchAll(/view\.insideRoot\s*([=!]==?|[^&\n,)]{0,4})/g)].map((m) => m[0])
if (uses.length === 0) {
  bad('界面完全没有消费 insideRoot', 'A11/A28 的渲染缺失')
} else {
  ok(`界面消费 insideRoot ${uses.length} 处`, uses.join(' | '))
}

/* 硬断言：不许出现 `!view.insideRoot` / `view.insideRoot !=` / `view.insideRoot === undefined`
 * 显式比较是防线：字段现在是恒有值的布尔，但若将来改回可选，真值判断会静默把
 * undefined 卷进「根外」或「根内」的某一侧，而类型检查不会报错。 */
const DANGEROUS = [
  [/!\s*view\.insideRoot\b/, '`!view.insideRoot`（字段若变可选，undefined 会当成根外）'],
  [/view\.insideRoot\s*!=\s*false/, '`view.insideRoot != false`（同上）'],
  [/view\.insideRoot\s*===?\s*undefined/, '`view.insideRoot === undefined`（拿来当条件会误判）'],
  [/view\.insideRoot\s*\?\s*[^:]/, '`view.insideRoot ? …`（真值判断）']
]
for (const [re, desc] of DANGEROUS) {
  if (re.test(pane)) bad(`出现了危险写法 ${desc}`)
  else ok(`没有危险写法 ${desc}`)
}

/* 正面断言：至少两处 `=== false`（徽标一处、引导句一处） */
const falseChecks = (pane.match(/view\.insideRoot\s*===\s*false/g) || []).length
if (falseChecks >= 2) ok(`有 ${falseChecks} 处 \`=== false\` 判断（徽标 + 引导句）`)
else if (falseChecks === 1) bad('只有 1 处 `=== false`', '徽标与引导句应各自判断')
else bad('没有 `=== false` 判断', '条件写错了')

/* `=== true` 若出现，说明有人给「在根内」也加了渲染 —— 在根内是常态，不该抢眼 */
if (/view\.insideRoot\s*===\s*true/.test(pane))
  bad('出现了 `=== true` 分支', '在根内是常态，不该单独渲染任何东西')
else ok('没有 `=== true` 分支（在根内不渲染任何标注）')

/* ══════════ 2. 主进程的比较基准必须是「当前根」 ══════════ */
console.log('\n== 2. 主进程按当前生效根算（不是创建时根）==')
/*
 * 这一节守的是本轮真实踩到的 P0：界面代码完全正确、判据全绿，功能却等于没实现。
 *
 * 曾经 `list.ts` 写 `isInsideRoot(rec.createdUnderRoot, rec.path)`：
 * `createdUnderRoot` 是创建时冻结的根，记录本来就建在那个根下，两者同源 →
 * Windows 上恒 true（徽标永不出现）、Linux 上因混用 compareKey 与绝对路径恒 false
 * （徽标恒出现，把所有记录误标）。两种都是死功能，而界面侧判据全都 PASS。
 */
const listSrc = stripComments(fs.readFileSync(LIST, 'utf8'))

if (/isInsideRoot\s*\(\s*rec\.createdUnderRoot|createdUnderRoot\s*,\s*rec\.path/.test(listSrc)) {
  bad('insideRoot 仍用 createdUnderRoot 作为比较基准', '两者同源 → 恒真，徽标永不出现（或恒假误标）')
} else {
  ok('insideRoot 不再拿 createdUnderRoot 当基准')
}

/* 必须出现「当前根」参与运算：worktreeRoot() 或它的 compareKey 化 */
if (/worktreeRoot\s*\(\s*\)/.test(listSrc)) ok('listWorktrees 里取了当前生效根 worktreeRoot()')
else bad('没有取当前生效根', 'A11/§11.2 要求按当前根重算，不是一次性快照')

/*
 * 两个入参必须同为 compareKey 形态。`isInsideRoot` 会对入参再跑 normalizeWorktreePath
 * （含 resolve），拿 compareKey 传进去在 Linux 上会被当相对路径 → 同根判根外。
 * `remove.ts:139-148` 明令禁止这个组合，这里守住同一口径。
 */
if (/isInsideRoot\s*\([^)]*compareKey/.test(listSrc)) {
  bad('把 compareKey 传给了 isInsideRoot', 'Linux 上会被当相对路径，同根判根外；应改用 isKeyInsideRoot')
} else {
  ok('没有把 compareKey 传给 isInsideRoot')
}
if (/isKeyInsideRoot\s*\(/.test(listSrc)) ok('用 isKeyInsideRoot 做 compareKey 比较（与 remove.ts 同口径）')
else bad('没有用 isKeyInsideRoot', 'compareKey 比较必须走它')

/* 字段必须是恒有值的布尔，否则老记录（无 createdUnderRoot）永远算不出标注 */
if (/insideRoot\??\s*:\s*boolean/.test(fs.readFileSync(R('apps/desktop/src/shared/worktree-protocol.ts'), 'utf8')))
  ok('协议里 insideRoot 是必填 boolean（老记录也算得出）')
else bad('协议里 insideRoot 仍是可选', 'A11 要求老记录也标注，可选会让老记录永远没有标注')

/* ══════════ 3. 徽标：在 cf-wt__rowhead 里，用 cf-wt__badge ══════════ */
console.log('\n== 3. 徽标位置与类名 ==')
/* 取 rowhead 区块（header ... </header>） */
const rowhead = pane.match(/<header className="cf-wt__rowhead">([\s\S]*?)<\/header>/)
if (!rowhead) {
  bad('找不到 cf-wt__rowhead 区块')
} else {
  const body = rowhead[1]
  if (/insideRoot\s*===\s*false/.test(body)) ok('根外标注在 cf-wt__rowhead 内')
  else bad('根外标注不在 rowhead 内', '应与其他 badge 并列')
  if (/cf-wt__badge/.test(body)) ok('用的是现有 cf-wt__badge 体系')
  else bad('没有用 cf-wt__badge')
  /* 必须真的渲染一个 <span className="cf-wt__badge">，不是只判断不渲染 */
  const badgeLine = body.split('\n').find((l) => /insideRoot\s*===\s*false/.test(l)) || ''
  /*
   * 单条正则即可：`<span[^>]*cf-wt__badge` 同时覆盖 `className="cf-wt__badge"` 与
   * 带其他属性 / 模板字符串的写法。原来写成 `A.test(x) || B.test(x)` 是多余的第二分支
   * （A 能命中的 B 必然也能命中），被元判据 check-qa-no-comment-trap 当成 `||` 兜底抓出来 —— 这是对的。
   */
  if (/<span[^>]*cf-wt__badge/.test(badgeLine))
    ok('确实渲染了 <span className="cf-wt__badge">', badgeLine.trim().slice(0, 70))
  else bad('判断了 but 没渲染 cf-wt__badge 元素', badgeLine.trim().slice(0, 70) || '(空行)')
}

/* ══════════ 3. 引导句：用现有 note 类，且不用警告色 ══════════ */
console.log('\n== 3. 引导句（§10.1b 末段）==')
const noteLine = pane.split('\n').find((l) => /rootOutsideNote/.test(l)) || ''
if (noteLine) ok('有引导句渲染', noteLine.trim().slice(0, 80))
else bad('没有渲染引导句', 'rootOutsideNote 未被使用')
if (/cf-wt__note/.test(noteLine)) ok('引导句用现有 .cf-wt__note 类')
else bad('引导句没有用 .cf-wt__note', noteLine.trim().slice(0, 60))
/*
 * 不许用 is-warn：根外不是错误也不是警告，用橙底会让用户以为目录有问题。
 * 需求 §10.1b 明确要求措辞避开「非法 / 无效」，视觉上也该一致。
 */
if (/cf-wt__note\s+is-warn/.test(noteLine)) bad('引导句用了 is-warn（橙底）', '根外不是警告状态')
else ok('引导句不是警告色（不带 is-warn）')
/* 引导句必须和徽标一样，只在 === false 时出现 */
const noteBlock = pane.slice(Math.max(0, pane.indexOf('rootOutsideNote') - 400), pane.indexOf('rootOutsideNote'))
if (/insideRoot\s*===\s*false/.test(noteBlock)) ok('引导句的条件是 `=== false`')
else bad('引导句没有 `=== false` 条件', 'undefined 时也会显示引导句')
/* 不许新造 CSS 类：全文件里出现 cf-wt__note / cf-wt__badge 之外的自造类名由下面第 5 段统一查 */
/* 措辞：不许「非法 / 无效 / 不合法」 */
const NOTE_ZH = (i18n.match(/rootOutsideNote:\s*'([^']*)'/) || [])[1] || ''
if (/非法|无效|不合法|错误/.test(NOTE_ZH)) bad('引导句措辞含「非法/无效」', NOTE_ZH)
else ok('引导句措辞避开「非法/无效」', `「${NOTE_ZH}」`)
if (!NOTE_ZH) bad('rootOutsideNote 中文词条缺失')

/* ══════════ 4. i18n 中英同键 ══════════ */
console.log('\n== 4. i18n：中英同键 ==')
for (const k of ['rootOutsideBadge', 'rootOutsideNote']) {
  const n = [...i18n.matchAll(new RegExp(`^\\s{6}${k}:`, 'gm'))].length
  if (n >= 2) ok(`${k} 中英齐全`)
  else bad(`${k} 词条不全`, `只有 ${n} 处，应 2 处`)
}
/* 代码里引用的 cf.wt.* 词条都得有定义 */
const usedKeys = [...new Set([...pane.matchAll(/t\('(cf\.wt\.\w+)'\)/g)].map((m) => m[1]))]
const undef = usedKeys.filter((k) => {
  const leaf = k.split('.').pop()
  return [...i18n.matchAll(new RegExp(`^\\s{6}${leaf}:`, 'gm'))].length < 2
})
if (undef.length === 0) ok(`代码引用的 ${usedKeys.length} 个 cf.wt.* 词条都有中英定义`)
else bad('引用了未定义词条', undef.join(', '))

/* ══════════ 5. 不新造 CSS 类，不动按钮可用性 ══════════ */
console.log('\n== 5. 不新造类 / 不影响按钮可用性（§11.2）==')
const cssFiles = [
  'apps/desktop/src/renderer/src/redesign/worktree-pane.css',
  'apps/desktop/src/renderer/src/redesign/redesign.css',
  'apps/desktop/src/renderer/src/styles/app.css'
]
const defined = new Set()
for (const f of cssFiles) {
  const css = fs.readFileSync(R(f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(/\.([A-Za-z][\w-]*)/g)) defined.add(m[1])
}
/* 只看这次改动涉及的两个片段里的类名：rowhead 徽标行 + note 行 */
const changedClasses = new Set()
for (const line of [noteLine, ...(rowhead ? [rowhead[1]] : [])].join('\n').split('\n')) {
  if (!/insideRoot|rootOutside/.test(line)) continue
  for (const m of line.matchAll(/className="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !c.startsWith('{')) changedClasses.add(c)
  }
}
const invented = [...changedClasses].filter((c) => !defined.has(c))
if (invented.length === 0) ok(`改动用到的 ${changedClasses.size} 个类名都在产品 CSS 里`, [...changedClasses].join(' '))
else bad('新造了 CSS 类', invented.join(', '))

/*
 * 按钮可用性（§11.2）：根外记录的删除 / 合并 / 重建 / 装依赖必须照旧可用。
 * 断言方式：这些按钮的 disabled 条件里**不能**出现 insideRoot。
 */
const btnBlocks = [...pane.matchAll(/<button[^>]*?disabled=\{([^}]*)\}[^>]*>/g)]
const tainted = btnBlocks.filter((b) => /insideRoot/.test(b[1]))
if (tainted.length === 0) ok(`${btnBlocks.length} 个带 disabled 的按钮都没被 insideRoot 影响`)
else bad(`${tainted.length} 个按钮的 disabled 掺了 insideRoot`, tainted.map((b) => b[1]).join(' | '))

/* ══════════ 6. 位置：引导句在按钮区之前（不和操作挤一起）══════════ */
console.log('\n== 6. 引导句位置 ==')
const notePos = pane.indexOf('rootOutsideNote')
const actionsPos = pane.indexOf('cf-wt__actions')
if (notePos > 0 && actionsPos > 0) {
  if (notePos < actionsPos) ok('引导句在 cf-wt__actions 之前')
  else bad('引导句在按钮区之后', '会和操作按钮挤在一起')
} else {
  bad('定位不到引导句或按钮区')
}

console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)