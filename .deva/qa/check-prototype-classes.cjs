#!/usr/bin/env node
/**
 * 把关：原型 HTML 里出现的类名，必须在产品真实 CSS 里有定义。
 * 自造类名会让原型看起来对、实现时却要另写一套样式，等于原型骗人。
 *
 * 用法：node .deva/qa/check-prototype-classes.cjs
 * 退出码：0 全通过；1 有自造类名
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const DESIGN_DIR = path.join(ROOT, '.deva/design')
const CSS_FILES = [
  'apps/desktop/src/renderer/src/styles/tokens.css',
  'apps/desktop/src/renderer/src/styles/app.css',
  'apps/desktop/src/renderer/src/redesign/redesign.css',
  'apps/desktop/src/renderer/src/redesign/worktree-pane.css',
  'apps/desktop/src/renderer/src/redesign/model-panel.css',
  'apps/desktop/src/renderer/src/redesign/memory-detail.css'
]
// 原型自身的脚手架类，允许存在（不进产品）
const SCAFFOLD = new Set(['shell', 'proto-bar', 'proto-tag', 'is-on', 'pane'])

/**
 * 历史原型：写在判据建立之前，自带一整套当时没有沉淀进产品的类名。
 *
 * 为什么豁免而不是改掉：这两份是**当时的探索稿**（`rail-grouping` 是图标栏分组方案的候选，
 * `worktree-parallel` 是 worktree 并行开发的最初全景），改它们的类名等于重画，
 * 而重画的产物不会进产品 —— 它们的历史价值就在「当时是这么画的」。
 *
 * 豁免是**白名单**，不是放宽判定：新写的原型不在这里面，照样要过。
 * 新增条目必须先确认「这份原型不会再被实现」。
 */
const LEGACY_PROTOTYPES = new Set(['rail-grouping.html', 'worktree-parallel.html'])

const css = CSS_FILES.map(f => {
  const p = path.join(ROOT, f)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}).join('\n')

// 收集 CSS 里定义过的所有类名
const DEFINED = new Set()
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) DEFINED.add(m[1])

const protos = fs.existsSync(DESIGN_DIR)
  ? fs.readdirSync(DESIGN_DIR).filter(f => f.endsWith('.html') && !f.startsWith('_'))
  : []

if (!fs.existsSync(DESIGN_DIR)) {
  /*
   * `.deva/design/` 被 `.gitignore` 忽略（`design/`），CI 检出后整目录不存在。
   *
   * 不能静默 exit 0：那会让人以为「检查过了、是全绿」，实际一条断言都没跑。
   * 也不能报 FAIL：崩在 ENOENT 上看起来像判据坏了或实现写错了，而实际上判据里
   * 根本没有可检查的对象。按 `.deva/qa/AGENTS.md` 的规定显式 SKIP。
   */
  console.log('==SKIP== 本判据未执行（不计入通过，也不是失败）')
  console.log(`  判据对象不在此处：${path.relative(ROOT, DESIGN_DIR)}（被 .gitignore 的 design/ 规则忽略）`)
  console.log('  原型稿属本机草稿区，不入库；CI 检出后没有可检查的 HTML。')
  console.log('  本机写过原型时它会自动生效；在此之前它一条断言都没跑。')
  console.log('  → 退出码 0，但请把它当作「没跑」，不要当作「全绿」。')
  process.exit(0)
}

let fail = 0
for (const f of protos) {
  const src = fs.readFileSync(path.join(DESIGN_DIR, f), 'utf8')
  const used = new Set()
  for (const m of src.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c)
  }
  // 原型 <style> 里自己定义的类，也算「原型自带」，但必须和产品同名类一致才行
  const styleBlock = src.slice(src.indexOf('<style>'), src.indexOf('</style>'))
  const selfDefined = new Set()
  for (const m of styleBlock.matchAll(/\.([a-zA-Z][\w-]*)/g)) selfDefined.add(m[1])

  const fake = [...used].filter(c => !DEFINED.has(c) && !SCAFFOLD.has(c) && !selfDefined.has(c))
  // 原型 <style> 里重新定义的产品类（覆盖了真实样式）也要报出来
  const overridden = [...selfDefined].filter(c => DEFINED.has(c) && !SCAFFOLD.has(c))

  console.log(`\n${f}`)
  if (LEGACY_PROTOTYPES.has(f)) {
    /*
     * 显式打印而不是静默跳过：`.deva/qa/AGENTS.md` 明令禁止跳过项不打印。
     * 这里仍把自造类名数出来，只是不判 FAIL —— 让人能看见「有哪些、为什么放过」。
     */
    console.log(`  SKIP 历史原型，豁免自造类名判定（${fake.length} 个自造类名，仅列出）：${fake.slice(0, 6).join(', ')}${fake.length > 6 ? ' …' : ''}`)
    continue
  }
  if (fake.length) {
    console.log(`  FAIL 自造类名（产品 CSS 里没有）：${fake.join(', ')}`)
    fail++
  }
  if (overridden.length) {
    console.log(`  注意 原型里重新定义了产品已有的类：${overridden.join(', ')}`)
  }
  if (!fake.length && !overridden.length) console.log('  PASS 类名全部来自产品 CSS')
}

console.log(fail ? `\n==RESULT== ${fail} FAIL` : '\n==RESULT== ALL PASS')
process.exit(fail ? 1 : 0)