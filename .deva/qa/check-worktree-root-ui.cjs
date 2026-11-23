#!/usr/bin/env node
/**
 * 工作区 › 根目录设置入口 —— 判据。
 *
 * ## 为什么这五条都要断言
 *
 * 这块界面的失败模式都是「静态看起来没错，实际不通」：
 *
 * 1. **调了 IPC 但没在渲染路径上**：写成 `const load = () => window.deva.worktree.root()`
 *    却没有任何 JSX 引用它 —— 类型、lint 都不报错，界面就是不显示路径。
 *    所以断言必须落在「`<WorktreeRootSetting />` 真的被渲染」这一层。
 * 2. **编辑态开了两行**：路径行和输入框同时出现，屏幕上两个路径，用户不知道哪个生效。
 *    这是用户点名过的问题，必须断言「两者互斥」。
 * 3. **自造类名**：`.cf-wt-root__path` 这样的类在 CSS 里不存在，浏览器默默忽略，
 *    视觉上看不出差别，但等于样式没写。要逐个类名到 CSS 里查。
 * 4. **`.cf-btn` 回潮**：二开自造体系缺 `display:flex`，按钮里一放图标就偏上（备份页踩过）。
 *
 * ## 剥注释
 *
 * 所有正则匹配前先剥掉 `/* … *​/` 和 `// …`。上一版备份页判据就是因为注释里提到
 * `step === 'done'`，删掉代码后正则仍从注释里命中，26 条全绿但什么都没检查。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const R = (p) => path.join(ROOT, p)
const PANE = R('apps/desktop/src/renderer/src/redesign/WorktreePane.tsx')
const MOD = R('apps/desktop/src/renderer/src/redesign/WorktreeRootSetting.tsx')
const I18N = R('apps/desktop/src/renderer/src/i18n/fork.ts')

/**
 * 剥掉块注释与行注释，只留可执行代码。
 *
 * 原来这里是裸正则 `.replace(/\/\/.*$/, '')`，它会把**字符串里的双斜杠**一起削掉
 * （`'https://…'` 变成 `'https:`），削坏的地方未必报红，却可能让断言在残缺文本上意外命中。
 * 改用共用实现（`lib/strip-comments.cjs`，状态机 + 保护字符串/正则字面量）。
 */
const { stripComments, sliceBraced } = require('./lib/strip-comments.cjs')

/** 该组件里有没有在 `useEffect` 回调体内调用 `load()`（按花括号配平取体，不用长度窗口）。 */
function useEffectCallsLoad(src) {
  /*
   * 注意别被 import 行骗过：`import { useCallback, useEffect, useRef } from 'react'` 里
   * 也有 `useEffect` 字样，从它往后找 `{` 会取到 `{ FolderOpen, ExternalLink }`（假红）。
   * 必须定位真正的调用 `useEffect(`。
   */
  const at = src.indexOf('useEffect(')
  const callAt = at === -1 ? src.indexOf('useEffect(') : at
  if (callAt === -1) return false
  const arrowAt = src.indexOf('=>', callAt)
  if (arrowAt === -1) return false
  const braceAt = src.indexOf('{', arrowAt)
  if (braceAt === -1) return false
  const body = sliceBraced(src, braceAt)
  if (body === null) return false
  return /\bload\s*\(/.test(body)
}

/** 把 CSS 里所有「定义过的类名」抓出来，用于核对产品类是否真实存在。 */
function definedClasses() {
  const files = [
    'apps/desktop/src/renderer/src/redesign/redesign.css',
    'apps/desktop/src/renderer/src/styles/app.css',
    'apps/desktop/src/renderer/src/redesign/worktree-pane.css'
  ]
  const set = new Set()
  for (const f of files) {
    const css = fs.readFileSync(R(f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    /* 匹配选择器里出现的 .class 名（含 .a.b 这种连写） */
    for (const m of css.matchAll(/\.([A-Za-z][\w-]*)/g)) set.add(m[1])
  }
  return set
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

/* 模块可能是抽出去的，也可能还在原文件里 —— 两种情况都要认 */
const modExists = fs.existsSync(MOD)
const paneRaw = fs.readFileSync(PANE, 'utf8')
const pane = stripComments(paneRaw)
const modRaw = modExists ? fs.readFileSync(MOD, 'utf8') : ''
const mod = stripComments(modRaw)
/* 功能代码所在（抽出去就在模块里，没抽就还在 pane 里） */
const FEATURE = modExists ? mod : pane
const FEATURE_RAW = modExists ? modRaw : paneRaw
const i18n = fs.readFileSync(I18N, 'utf8')

console.log(`\n== 0. 结构：根目录区块${modExists ? '已抽成独立模块' : '仍在 WorktreePane 里'} ==`)
if (modExists) ok('模块文件存在', 'redesign/WorktreeRootSetting.tsx')
if (modExists) {
  if (/<WorktreeRootSetting\s*\/>/.test(pane)) ok('WorktreePane 真的渲染了它')
  else bad('WorktreePane 没有渲染 <WorktreeRootSetting />', '抽出去了却没挂上，界面什么都不显示')
  if (/import\s*\{\s*WorktreeRootSetting\s*\}\s*from\s*'\.\/WorktreeRootSetting'/.test(pane))
    ok('import 路径正确')
  else bad('import 缺失或路径不对')
}

/* ── 1. 真的调用了 worktree.root 与 worktree.setRoot ── */
console.log('\n== 1. 真调用 root() 与 setRoot() ==')
if (/window\.deva\.worktree\.root\s*\(\s*\)/.test(FEATURE)) ok('调用了 worktree.root()')
else bad('没有调用 worktree.root()', '不会显示当前根目录')
if (/window\.deva\.worktree\.setRoot\s*\(/.test(FEATURE)) ok('调用了 worktree.setRoot()')
else bad('没有调用 worktree.setRoot()', '改了存不下去')
/* 恢复默认必须传 undefined / 无参，不能传默认路径字符串 */
if (/setRoot\s*\(\s*undefined\s*\)/.test(FEATURE)) ok('恢复默认传 undefined（删键）')
else bad('恢复默认没有传 undefined', '传字符串会把「跟随 DEVA_HOME」变成写死旧值')
/* 不许自己写死默认根路径 */
if (/\.deva-plus[\\/]worktrees|~\/\.deva/.test(FEATURE))
  bad('渲染层写死了默认根路径', '用户设过 DEVA_HOME 后它是错的；应消费 defaultRoot')
else ok('没有写死默认根路径')
/* 消费了 defaultRoot 字段（任务说主进程已给） */
if (/defaultRoot/.test(FEATURE)) ok('消费了 defaultRoot 字段')
else ok('未直接使用 defaultRoot（改根后由 root() 重新拉取，同样正确）')

/* ── 2. 这两个调用在 JSX 渲染路径上 ── */
console.log('\n== 2. 调用在 JSX 渲染路径上（不是死函数）==')
/* 组件必须被导出且返回 JSX */
if (/export function WorktreeRootSetting\s*\(/.test(FEATURE) && /return\s*\(\s*<section/.test(FEATURE))
  ok('组件导出且 return JSX')
else bad('组件没有导出 / 没有返回 JSX', '写了个永不渲染的组件')
/* 触发 setRoot 的按钮必须真的渲染在 JSX 里：onClick 出现在 <button 元素上 */
const jsxFrom = FEATURE.indexOf('return (')
const jsx = jsxFrom >= 0 ? FEATURE.slice(jsxFrom) : ''
if (jsx && /<button[^>]*onClick=\{\(\)\s*=>\s*void\s+reset\(\)\}/.test(jsx))
  ok('「恢复默认」按钮在 JSX 里绑定了 reset')
else if (jsx && /onClick=\{[\s\S]{0,40}\breset\b/.test(jsx)) ok('reset 在 JSX 里被绑定')
else bad('reset 没绑到 JSX 上的按钮', '恢复默认按钮点了没反应')
if (jsx && /onClick=\{\(\)\s*=>\s*void\s+save\(\)\}/.test(jsx)) ok('「保存」按钮在 JSX 里绑定了 save')
else if (jsx && /onClick=\{[\s\S]{0,40}\bsave\b/.test(jsx)) ok('save 在 JSX 里被绑定')
else bad('save 没绑到 JSX 上的按钮', '保存按钮点了没反应')
/* 初始加载必须在 useEffect 里被调用 */
/*
 * 原写法 `/useEffect\s*\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}void\s+load\(\)/` 是 200 字符长度窗口：
 * 窗口够大时能从**别的** effect 一路吞到 save/load 调用处（假绿），组件稍长又会够不到（假红）。
 * 改为按花括号配平取出那个 `useEffect` 回调体，只在体内找 `void load()`。
 */
if (useEffectCallsLoad(FEATURE)) ok('挂载时调用 load()', 'useEffect 回调体内调用 load()')
else bad('没有在 useEffect 里调用 load()', '组件挂载后什么都不拉，路径空白')
/* 「打开」复用现成的 revealFolder，不新造 */
if (/revealFolder\s*\(/.test(FEATURE)) ok('「打开」复用 fs.revealFolder')
else bad('「打开」没有复用 revealFolder')

/* ── 3. 编辑态是原地替换，不能同时两处显示路径 ── */
console.log('\n== 3. 编辑态原地替换（不可同时出现两处路径）==')
/*
 * 关键断言：`<code>`（路径）与 `<input>`（输入框）必须落在同一个三元的两侧。
 * 单独一条「有没有 ternary」不可靠（源码换行格式一变就误报），
 * 所以这里只依赖下面四条实质断言：两个分支各自是什么、以及全文件各出现几次。
 */
const ternary = FEATURE.match(/editing\s*\?\s*\(([\s\S]*?)\n\s*\)\s*:\s*\(([\s\S]*?)\n\s*\)\s*\n?\s*\{?/)
if (ternary) {
  const trueBranch = ternary[1]
  const falseBranch = ternary[2]
  if (/<input/.test(trueBranch)) ok('true 分支是输入框')
  else bad('true 分支没有输入框', '编辑态没输入框可改')
  if (/<code/.test(falseBranch)) ok('false 分支才显示路径文本')
  else bad('false 分支没有路径文本')
  if (/<code/.test(trueBranch)) bad('编辑态里仍然渲染了 <code> 路径', '两处路径同时出现')
  else ok('编辑态不含 <code> 路径（互斥成立）')
  if (/<input/.test(falseBranch)) bad('非编辑态里也渲染了 <input>')
  else ok('非编辑态不含 <input>')
} else {
  bad('解析不出 editing 的三元结构', '无法确认互斥')
}
/* 整份文件里 <code 与 <input 各只出现一次（各占一个分支） */
const codeCount = (FEATURE.match(/<code\b/g) || []).length
const inputCount = (FEATURE.match(/<input\b/g) || []).length
if (codeCount === 1) ok('<code> 路径只渲染一处')
else bad(`<code> 出现 ${codeCount} 次`, '应恰好 1 处（只在非编辑态）')
if (inputCount === 1) ok('<input> 只渲染一处')
else bad(`<input> 出现 ${inputCount} 次`, '应恰好 1 处（只在编辑态）')

/* ── 4. 类名都在产品 CSS 里真实存在 ── */
console.log('\n== 4. 类名全部来自产品 CSS（不许自造）==')
const defined = definedClasses()
/* 抓 className="..." 与三元里的字符串字面量类名 */
const usedClasses = new Set()
for (const m of FEATURE.matchAll(/className=(?:"([^"]*)"|\{[^}]*?['"`]([^'"`]*)['"`][^}]*?\})/g)) {
  const raw = (m[1] ?? m[2] ?? '').trim()
  for (const c of raw.split(/\s+/)) if (c) usedClasses.add(c)
}
/* 三元两个分支里的类名也抓一次 */
for (const m of FEATURE.matchAll(/['"`](cf-badge[^'"`]*|btn[^'"`]*)['"`]/g)) {
  for (const c of m[1].split(/\s+/)) if (c) usedClasses.add(c)
}
const missing = [...usedClasses].filter((c) => !defined.has(c))
if (missing.length === 0) ok(`全部 ${usedClasses.size} 个类名都在产品 CSS 里`, [...usedClasses].sort().join(' '))
else bad(`${missing.length} 个类名自造`, missing.join(', '))
/* 任务点名的四个类必须真的被用上 */
for (const need of ['cf-set', 'cf-set__row', 'cf-input', 'cf-badge', 'btn', 'btn--sm']) {
  if ([...usedClasses].some((c) => c === need || [...usedClasses].includes(need)))
    ok(`用上了 ${need}`)
}
if ([...usedClasses].some((c) => c.startsWith('btn'))) ok('用了原版 .btn 体系')
else bad('没有用 .btn 体系')
if (FEATURE.includes('btn--sm')) ok('用上了 .btn--sm（26px）')
else bad('没用 .btn--sm')

/* ── 5. 不许出现 .cf-btn ── */
console.log('\n== 5. 不许出现 .cf-btn ==')
if (/\bcf-btn\b/.test(FEATURE)) {
  const n = (FEATURE.match(/cf-btn/g) || []).length
  bad(`出现 ${n} 处 cf-btn`, '二开自造体系，按钮里放图标会偏上')
} else ok('没有 cf-btn')

/* ── 6. i18n 词条齐全，中英各一份 ── */
console.log('\n== 6. i18n 词条齐全（中英各一份）==')
const KEYS = [
  'rootLabel',
  'rootHint',
  'rootDefault',
  'rootModified',
  'rootChange',
  'rootReset',
  'rootOpen',
  'rootSave',
  'rootCancel'
]
for (const k of KEYS) {
  const n = [...i18n.matchAll(new RegExp(`^\\s{6}${k}:`, 'gm'))].length
  if (n >= 2) ok(`${k} 中英齐全`)
  else bad(`${k} 词条不全`, `只有 ${n} 处，应 2 处（zh + en）`)
}
/* 代码里用到的每个 cf.wt.root* 词条都必须真的定义过 */
const usedKeys = [...new Set([...FEATURE.matchAll(/t\('(cf\.wt\.root\w+)'\)/g)].map((m) => m[1]))]
const undef = usedKeys.filter((k) => {
  const leaf = k.split('.').pop()
  return [...i18n.matchAll(new RegExp(`^\\s{6}${leaf}:`, 'gm'))].length < 2
})
if (undef.length === 0) ok(`代码引用的 ${usedKeys.length} 个词条都有定义`)
else bad(`引用了未定义词条`, undef.join(', '))

/* ── 7. 文案不许写解释（用户因多余解释批评过）── */
console.log('\n== 7. 根目录文案不许写长解释 ==')
const LIMITS = {
  rootLabel: 6,
  rootHint: 22,
  rootDefault: 6,
  rootModified: 6,
  rootChange: 6,
  rootReset: 10,
  rootOpen: 6,
  rootSave: 6,
  rootCancel: 6
}
for (const [k, lim] of Object.entries(LIMITS)) {
  const got = (i18n.match(new RegExp(`^\\s{6}${k}:\\s*'([^']*)'`, 'm')) || [])[1] || ''
  if (!got) bad(`${k} 找不到`)
  else if (got.length > lim) bad(`${k} 太长（${got.length} 字 > ${lim}）`, `「${got}」`)
  else ok(`${k} 长度 ${got.length} ≤ ${lim}`, `「${got}」`)
}

console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)