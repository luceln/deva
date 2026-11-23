#!/usr/bin/env node
/**
 * 备份页按钮体系 + 导出三段文案 —— 判据。
 *
 * ## 为什么要有
 *
 * 三件事都容易「看着对、其实没生效」，各自需要一条断言：
 *
 * 1. **`.cf-btn` → `.btn`**：两种类名都长得像个按钮，改错了样式照样渲染，肉眼看不出。
 *    全仓只有备份页在按钮里放图标，所以 `.cf-btn` 那套缺 `display:flex` 的缺陷只在这里暴露。
 * 2. **`cf-spin` 有定义**：类名写在 className 里、CSS 里没定义，React 不报错、TS 不报错，
 *    图标就是不转。这条只有专门断言才抓得住（改之前实测 `animationName: none`）。
 * 3. **三段文案不回落**：`scan` 阶段不能出现百分比（那时总数未知，硬算会显示 0% 或 NaN）；
 *    `progress === null` 不能回落成「导出到文件」（用户以为没点中）。
 *    `step === 'done'` 不能显示「正在打包 1/1…」（那一刻已经打完了）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const PANE = path.join(ROOT, 'apps/desktop/src/renderer/src/redesign/BackupPane.tsx')
const CSS = path.join(ROOT, 'apps/desktop/src/renderer/src/redesign/redesign.css')
const I18N = path.join(ROOT, 'apps/desktop/src/renderer/src/i18n/fork.ts')

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

const paneRaw = fs.readFileSync(PANE, 'utf8')
/*
 * 断言一律看**剥掉注释**的源码。
 *
 * 这个文件第 5 组曾吃过「注释里写着类名 → 兜底正则从注释起匹配」的亏（见文件末尾注释）。
 * 第 1 组其实也有同样的口子：注释里若提到 `cf-btn`，`cf-btn 残留` 那条会误报；
 * 反过来「数 className 里的 btn」也可能被注释里的示例串影响。所以整体统一剥一次。
 */
const { stripComments } = require('./lib/strip-comments.cjs')
const pane = stripComments(paneRaw)
const css = fs.readFileSync(CSS, 'utf8')
const i18n = fs.readFileSync(I18N, 'utf8')

/* ── 1. 按钮全部改用 .btn 体系 ── */
console.log('== 1. 备份页按钮用原版 .btn，不再用 .cf-btn ==')
if (/\bcf-btn\b/.test(pane)) {
  const n = (pane.match(/cf-btn/g) || []).length
  bad(`还有 ${n} 处 cf-btn`, '二开自造按钮体系，缺 display:flex，图标会偏上')
} else {
  ok('没有 cf-btn 残留')
}
/* 三个按钮各自的类名必须都在（导出 / 选择包 / 还原-danger） */
const BTN_CLASSES = ['btn btn--primary', 'btn btn--danger btn--sm']
for (const c of BTN_CLASSES) {
  if (pane.includes(c)) ok(`类名存在`, c)
  else bad(`缺类名 ${c}`)
}
/* 至少三个 button 元素用了 .btn（导出 / 选包 / 还原）。
 * 注意还原按钮是三元表达式 `className={needConfirm ? 'btn …' : 'btn …'}`，
 * 两个分支都以 'btn 开头，所以这里数的是「className 里出现 btn 的位置」按元素算：
 * 用 button 元素总数与「以 btn 开头作为类名」的元素数对比。 */
const buttonTags = (pane.match(/<button\b/g) || []).length
/* 一个 button 元素算一个，不重复计三元表达式两个分支 */
const classAttr = pane.match(/className=(?:\{[^}]*\}|"[^"]*")/g) || []
/*
 * 「这个 className 用了 .btn 体系」的判法：类名 token 里出现独立的 `btn`。
 *
 * 原来写成两个正则用 `||` 兜（一个查 `btn` 前后不是连字符/词字符，一个查引号紧邻 `btn`）——
 * 兜底的问题在于两个都不精确：前者会把 `cf-btn` 也排除掉（正确），后者却会因为三元表达式里
 * 任意一个 `'btn …'` 就整段算过，于是 `className={x ? 'btn btn--ghost' : 'cf-btn'}` 这种
 * 只有一半换了的写法也算「全部换成 .btn」。
 *
 * 改为把该属性的**所有字符串字面量**取出来，逐个按空白切成 token，要求每个 token
 * 要么是 `btn` / `btn--*`，要么不含 `btn`（即不出现 `cf-btn` 这类旧类名）。
 */
const btnElements = classAttr.filter((a) => {
  const literals = a.match(/'[^']*'|"[^"]*"/g) || []
  if (literals.length === 0) return false
  // 该 className 至少有一处真的用了 .btn，且任何一处都不许残留旧类名 cf-btn
  let usesBtn = false
  for (const lit of literals) {
    const tokens = lit.slice(1, -1).split(/\s+/).filter(Boolean)
    for (const t of tokens) {
      if (t === 'btn' || t.startsWith('btn--')) usesBtn = true
      else if (/(^|-)btn$|-btn-|^cf-btn/.test(t)) return false
    }
  }
  return usesBtn
}).length
if (btnElements >= 3) ok(`${btnElements} 个 className 用了 .btn`)
else bad(`只有 ${btnElements} 个 className 用了 .btn`, '应有 3 个（导出 / 选择备份包 / 还原）')
if (btnElements === buttonTags) ok(`button 元素 ${buttonTags} 个全部换成 .btn`)
else bad(`button 共 ${buttonTags} 个，换了 ${btnElements} 个`, '有按钮漏换')

/* ── 2. cf-spin 真的有定义（否则图标不转）── */
console.log('\n== 2. cf-spin 在 CSS 里有定义（不然加载图标不转）==')
/* 只认「animation: <名字> … infinite」这种正向声明；
 * `prefers-reduced-motion` 里那句 `animation: none` 不能算数 —— 上一版正则被它骗过。 */
const spinDecl = css.match(/\.cf-spin\s*\{([^}]*)\}/g) || []
const spinAnims = spinDecl
  .map((b) => (b.match(/animation:\s*([^;}]+)/) || [])[1] || '')
  .filter((v) => v && !/^none\b/.test(v.trim()))
if (spinAnims.length > 0) ok('cf-spin 有正向 animation', spinAnims[0].trim())
else bad('cf-spin 没有正向 animation', '图标静止，用户看不出「在跑」还是「卡住」')
/* animation 指向的 keyframes 必须真实存在，否则写了也等于没转 */
const usedName = (spinAnims[0] || '').trim().split(/\s+/)[0]
if (usedName && new RegExp(`@keyframes\\s+${usedName}\\b`).test(css))
  ok(`animation 指向的 @keyframes ${usedName} 存在`)
else bad(`@keyframes ${usedName || '(空)'} 不存在`, 'animation 指向不存在的名字等于没转')
/* 无限循环：只转一次的加载图标等于没转 */
if (/infinite/.test(spinAnims[0] || '')) ok('animation 是 infinite 循环')
else bad('animation 不是 infinite', '只转一次就停，等于没转')
/* 降级：减动画偏好下不转（无障碍要求） */
if (/prefers-reduced-motion[^{]*\{[^}]*\.cf-spin/.test(css)) ok('reduced-motion 下关闭动画')
else bad('缺 reduced-motion 降级')

/* ── 3. 导出三段文案不回落 ── */
console.log('\n== 3. 导出进度三段：scan 无百分比、null 不回落、done 不误报 ==')
const m = pane.match(/function exportLabel[\s\S]*?\n\}/)
if (!m) bad('找不到 exportLabel()')
else {
  const body = m[0]
  /*
   * scan 分支只能传 {done}，不能传 {total} —— 那阶段 total 恒为 0，
   * 传进去会渲染成「正在扫描文件 N/0…」。
   */
  const scanAt = body.indexOf("step === 'scan'")
  const scanBlock = scanAt >= 0 ? body.slice(scanAt, body.indexOf('}', body.indexOf('fill', scanAt)) + 1) : ''
  if (/exportScanning/.test(scanBlock) && !/total:/.test(scanBlock))
    ok('scan 只传 done，不传 total', '不会出现 N/0 或 0%')
  else if (!/exportScanning/.test(scanBlock)) bad('scan 分支没用 exportScanning 词条')
  else bad('scan 分支传了 total', '扫描前总数未知，硬算百分比是编的')

  /* null（首个事件还没到）必须给「正在准备」，不能回落成「导出到文件」 */
  if (/if\s*\(!progress\)\s*return\s+t\('cf\.backup\.exportPreparing'\)/.test(body))
    ok('progress 为 null 时显示「正在准备…」', '不会回落成导出按钮文字')
  else bad('null 时没显示准备文案', '用户以为没点中')

  /* done 不能落到「正在打包」那句。
   * 注意：只看『代码行』，注释里也提到 `step === 'done'`，直接搜字符串会假绿。 */
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '')) // 去行注释
    .join('\n')
  if (/if\s*\(\s*progress\.step === 'done'\s*\)\s*return\s+t\(/.test(codeOnly))
    ok("step === 'done' 在代码里单独 return", '不会闪「正在打包 1/1…」')
  else bad("step === 'done' 未在代码里单独处理", '会落到 exporting 分支显示「正在打包 1/1…」，但那时已经打完了')

  /* 三段词条必须都在 i18n 里，且 scan 词条不带 {total} */
  for (const k of ['exportPreparing', 'exportScanning', 'exportHashing', 'exporting']) {
    const hits = [...i18n.matchAll(new RegExp(`^\\s{6}${k}:`, 'gm'))]
    if (hits.length >= 2) ok(`${k} 中英齐全`)
    else bad(`${k} 词条不全`, `只有 ${hits.length} 处`)
  }
  const scanEntry = (i18n.match(/exportScanning:\s*'([^']*)'/) || [])[1] || ''
  if (scanEntry && !scanEntry.includes('{total}')) ok('exportScanning 词条不含 {total}')
  else if (!scanEntry) bad('找不到 exportScanning 词条')
  else bad('exportScanning 词条含 {total}', '扫描阶段没有总数')
}

/* ── 4. 文案已改成生产短文案（不许把长解释加回去）── */
console.log('\n== 4. 生产短文案（旧的长段解释不许回潮）==')
const SHORT = [
  ['intro', '卸载重装后导回来，和原来一模一样。'],
  ['exportDesc', '会话、附件、角色、记忆、技能、配置、定时任务'],
  ['plainWarning', '密钥明文'],
  ['restoreDesc', '覆盖前会先自动备份一份'],
  ['overwriteWarn', '会覆盖当前数据']
]
for (const [key, want] of SHORT) {
  const got = (i18n.match(new RegExp(`^\\s{6}${key}:\\s*'([^']*)'`, 'm')) || [])[1]
  if (got === want) ok(`${key} 是生产文案`)
  else if (!got) bad(`${key} 找不到`)
  else bad(`${key} 文案不符`, `实际「${got.slice(0, 24)}…」`)
}
/* 长度上限：防止把长段解释又加回来（这几条原本 40~120 字） */
for (const [key] of SHORT) {
  const got = (i18n.match(new RegExp(`^\\s{6}${key}:\\s*'([^']*)'`, 'm')) || [])[1] || ''
  if (got.length > 40) bad(`${key} 太长（${got.length} 字）`, '用户明确否掉长段解释')
}
ok('所有生产文案都在 40 字内（长解释没回潮）')

/* ── 5. 密钥警告改一行提示，不再是警告框 ── */
console.log('\n== 5. 密钥明文是一行提示，不是整段警告框 ==')
/*
 * 用 .cf-setrow__note--warn（redesign.css:3525，11px 橙字）而不是 .cf-badge：
 * 后者 10.5px 带全圆边框，和 30px 按钮并排会显碎。两者都必须来自产品 CSS，不许自造。
 *
 * 判据必须先剥掉注释再匹配：注释里会提到类名，不剥掉时「兜底正则」会从注释里的
 * 类名一路贪心匹配到代码里的词条名，把注释当成代码 —— 那样把实现改错也照样 PASS。
 * （剥注释已在文件开头统一做过，这里的 `pane` 就是剥过注释的文本。）
 */
const warnLine = pane
  .split('\n')
  .find((l) => l.includes("cf.backup.plainWarning") && l.includes('<span'))
if (warnLine && /className="cf-setrow__note cf-setrow__note--warn"/.test(warnLine))
  ok('plainWarning 渲染在 .cf-setrow__note--warn 里')
else bad('plainWarning 不在 .cf-setrow__note--warn 里', '要么还是警告框，要么漏渲染，要么被注释骗过')
if (/cf-backup__danger/.test(pane)) bad('警告框类 cf-backup__danger 还在用', '用户要求改成一行提示')
else ok('没有再渲染警告框')
/* 该提示类必须在产品 CSS 里真实存在 */
if (/\.cf-setrow__note--warn\s*\{/.test(css)) ok('.cf-setrow__note--warn 是产品真实类')
else bad('.cf-setrow__note--warn 在 CSS 里不存在', '自造提示类')

console.log(
  fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`
)
process.exit(fail === 0 ? 0 : 1)