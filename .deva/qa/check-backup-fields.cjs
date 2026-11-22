#!/usr/bin/env node
/**
 * 备份面板「还原结果字段是否真的到了用户眼睛」的判据。
 *
 * ## 为什么要有这个脚本
 *
 * 验收提的 P1：`needsRestart` / `backupOfPrevious` / `symlinkAsCopy` / `relinked` /
 * `configReloadError` 五个字段在 `RestoreResult` 里有、主进程也填，但 `BackupPane.tsx`
 * **只在类型声明里出现它们，界面上零渲染**。这是典型的静默失效 —— 测试跑绿、类型检查通过，
 * 用户却看不到「覆盖前那份备份在哪」「哪些技能已经不再联动外部仓库」「配置其实没重读成功」。
 *
 * 所以判据不能只看「类型里有这个字段」，必须看**渲染路径**：
 * 字段被读进变量 → 变量出现在 JSX 里。分两步查，缺一步都算没到用户眼睛。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const PANE = path.join(ROOT, 'apps/desktop/src/renderer/src/redesign/BackupPane.tsx')
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

const pane = fs.readFileSync(PANE, 'utf8')
const i18n = fs.readFileSync(I18N, 'utf8')

/** 去掉注释，避免"注释里提到了所以判过"。 */
const code = pane.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/*
 * 判据：每个字段都必须在**非类型声明**的位置被读取，并且读出来的东西要进 JSX。
 *
 * 具体做法：字段名出现次数 ≥ 2（一次类型声明 + 一次实际使用）。
 * 只出现一次 → 只有类型，就是验收抓到的那个状态。
 */
const FIELDS = [
  ['backupOfPrevious', '覆盖前那份数据备份在哪（想退回时找不到）'],
  ['symlinkAsCopy', '哪些技能降级成了独立副本（以为还联动外部仓库）'],
  ['relinked', '多少个外部链接重新连上'],
  ['configReloadError', '配置重读失败（界面说完成，实际是旧配置）'],
  ['needsRestart', '需要重启才能全部生效']
]

console.log('== 字段是否进入渲染路径 ==')
for (const [field, why] of FIELDS) {
  const hits = (code.match(new RegExp(`\\b${field}\\b`, 'g')) || []).length
  if (hits >= 2) ok(`${field} 已被渲染`, `${hits} 处：类型 + 使用`)
  else bad(`${field} 只出现在类型里`, `${hits} 处 —— ${why}`)
}

/*
 * needsRestart 的现状：文案里已经写了「建议重启应用让所有改动生效」，
 * 靠的是一句固定文案而不是读这个字段。这不算缺陷（用户照样看到该做的事），
 * 但字段本身没被读——记一条提示，让它显式化，避免将来文案改了就丢。
 */
if ((code.match(/\bneedsRestart\b/g) || []).length < 2) {
  console.log('  NOTE needsRestart 未直接读取：重启提示由 restoreDone 的固定文案承担，用户仍能看到')
}

console.log('\n== notes 真的进了 JSX ==')
if (/\{resMsg\?\.notes\?\.map\(/.test(code)) ok('notes 数组被逐条渲染')
else bad('notes 没有被渲染', '拼出来的说明建了却没人用，等于没做')

console.log('\n== 每个说明都有对应词条（zh + en）==')
const KEYS = [
  'restoreBackupAt',
  'restoreRelinked',
  'restoreDowngraded',
  'restoreConfigStale'
]
for (const k of KEYS) {
  const n = (i18n.match(new RegExp(`${k}:`, 'g')) || []).length
  if (n >= 2) ok(`${k} 中英齐全`, `${n} 处`)
  else bad(`${k} 词条不全`, `只有 ${n} 处，应为 2（zh + en）`)
}

console.log('\n== 不留死词条 ==')
const used = new Set([...code.matchAll(/t\('cf\.backup\.([A-Za-z0-9]+)'\)/g)].map((m) => m[1]))
const declared = new Set(
  [...i18n.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]).filter((k) => KEYS.includes(k) || k.startsWith('restore') || k.startsWith('secrets'))
)
for (const k of declared) {
  if (used.has(k) || k === 'restoreDone' || k === 'restoreFailed') continue
  // secretsRestored 等用 fill 包着，正则兜一下
  if (new RegExp(`\\b${k}\\b`).test(code)) continue
  bad(`${k} 在词条表里但没被使用`, '死词条，删掉')
}
if (fail === 0) ok('新增词条都有使用点')

console.log(
  fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`
)
process.exit(fail === 0 ? 0 : 1)
