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

const paneRaw = fs.readFileSync(PANE, 'utf8')
const i18n = fs.readFileSync(I18N, 'utf8')

/**
 * 去掉注释，避免「注释里提到了所以判过」。
 *
 * 原来用的是一条裸正则直接剥块注释与行注释，其中剥行注释那条会把**字符串里的双斜杠**
 * 一起削掉（URL 变成残缺前缀），实测这个文件因此被削掉 3210 字符。削错的地方未必报红，
 * 反而可能让断言在残缺文本上意外命中。改用共用实现
 * （`lib/strip-comments.cjs`，走状态机、保护字符串字面量）。
 */
const { stripComments } = require('./lib/strip-comments.cjs')
const code = stripComments(paneRaw)

/*
 * 判据：每个字段都必须真的走到用户眼前。三关，缺一关都不算：
 *
 * 1. 字段在**非注释**代码里出现 ≥ 2 次（一次类型声明 + 一次读取）；
 * 2. 该字段读出后要进 `notes`/JSX —— 用「它配套的词条被 `t('cf.backup.xxx')` 取用」来验，
 *    这比数出现次数硬得多：条件被写成 `false && ...`、或被 `if (0)` 短路时，
 *    词条取用点跟着一起失效，第三关会红。
 * 3. 词条 zh + en 齐全。
 */
const FIELDS = [
  ['backupOfPrevious', '覆盖前那份数据备份在哪（想退回时找不到）', 'restoreBackupAt'],
  ['symlinkAsCopy', '哪些技能降级成了独立副本（以为还联动外部仓库）', 'restoreDowngraded'],
  ['relinked', '多少个外部链接重新连上', 'restoreRelinked'],
  ['configReloadError', '配置重读失败（界面说完成，实际是旧配置）', 'restoreConfigStale'],
  ['needsRestart', '需要重启才能全部生效', 'restoreRestart'],
  /*
   * 2026-11 追加：主进程新增这两个字段并如实填写，界面同样零渲染 ——
   * 与首轮五个字段一模一样的静默失效，只是晚了两轮才被发现。
   */
  ['symlinkUnrecovered', '哪些技能/目录内容没恢复（只剩空目录，却显示还原完成）', 'restoreUnrecovered'],
  ['symlinkIncomplete', '哪些只恢复了一部分（以为内容全在，实际缺了一半）', 'restoreIncomplete'],
  ['dirsFailed', '哪些空目录没建回来（以为目录回来了）', 'restoreDirsFailed'],
  ['corruptSecretsBackup', '坏掉的旧密钥库被挪到哪（不说清会以为密钥凭空丢了）', 'restoreCorruptSecrets']
]

console.log('== 字段是否进入渲染路径 ==')
for (const [field, why, key] of FIELDS) {
  const hits = (code.match(new RegExp(`\\b${field}\\b`, 'g')) || []).length
  if (hits < 2) {
    bad(`${field} 只出现在类型里`, `${hits} 处 —— ${why}`)
    continue
  }
  /*
   * 第二关：配套词条必须被真正取用（字段读了却拼出别的文案，等于没显示这一项）。
   * 第三关再管「取用点会不会永远执行不到」。
   * （needsRestart 的文案是固定句、不走 fill，用 restoreRestart 直接对上。）
   */
  const usedKey = new RegExp(`t\\('cf\\.backup\\.${key}'\\)`).test(code)
  /*
   * 第三关：取用点不能被静态短路。
   *
   * 抓的是这个真实漏网：把条件写成 `if (false && r.dirsFailed ...)` 时，字段名照样出现两次、
   * `t('cf.backup.xxx')` 也还在源码里，只查「有没有取用」的判据完全看不见 —— 假绿。
   * 这里把「该字段的 if 条件」摘出来，条件里出现 `false &&` / `if (0` 之类字面量短路就判红。
   * 不做完整的控制流分析（那要靠真编译），只钉住这一种确实会发生的写法。
   */
  const guardRe = new RegExp(`if \\(([^)\\n]*\\b${field}\\b[^)\\n]*)\\)`, 'g')
  const conds = [...code.matchAll(guardRe)].map((m) => m[1])
  const shorted = conds.find((c) => /\bfalse\s*&&|\b0\s*&&|\btrue\s*\|\|/.test(c))
  if (!usedKey) bad(`${field} 没有真正渲染`, `词条 ${key} 没有被取用 —— ${why}`)
  else if (conds.length === 0) bad(`${field} 没有条件守卫`, `字段没出现在任何 if 条件里，可能被无条件读取或读错地方 —— ${why}`)
  else if (shorted) bad(`${field} 的渲染条件被短路`, `if (${shorted.trim()}) 永远不成立 —— ${why}`)
  else ok(`${field} 已被渲染`, `${hits} 处：类型 + 使用，词条 ${key} 有取用`)
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
  'restoreConfigStale',
  'restoreUnrecovered',
  'restoreIncomplete',
  'restoreIncompleteTruncated',
  'restoreDirsFailed',
  'restoreCorruptSecrets'
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
