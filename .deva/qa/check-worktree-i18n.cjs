#!/usr/bin/env node
/**
 * 工作区「重建失败」分因文案是否真的到了用户眼前 —— 判据。
 *
 * ## 为什么要有这个脚本
 *
 * 调用点原来写的是：
 *
 *     message: res.message ?? t(REBUILD_FAIL_KEY[res.reason ?? 'add-failed'])
 *
 * `res.message` 是后端的技术原文，六条 reason 它**条条都填**，于是 `??` 一次都轮不到右边 ——
 * `REBUILD_FAIL_KEY` 那张表整张是死代码，六个词条一个都不会被用到。
 * 用户看到的是「目录还在（E:\xxx），不需要重建」这类后端口吻，而不是「我该怎么办」。
 *
 * **教训**：只查「词条在不在表里」查不出这种问题（表确实在、词条确实有）。
 * 必须查到**渲染路径**上，而且得承认「短路」有好几种写法：
 *   - `res.message ?? t(...)`：右手边永远不执行；
 *   - `if (false && ...)`：条件永远不成立；
 *   - 词条被取了但 `.replace('{path}', ...)` 没做：占位符原样漏给用户（`目录还在（{path}）`）。
 * 下面四组断言分别钉住这几种。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const PANE = path.join(ROOT, 'apps/desktop/src/renderer/src/redesign/WorktreePane.tsx')
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

/** 去掉注释，避免「注释里提到了所以判过」。 */
const code = pane.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const REASONS = ['not-found', 'dir-exists', 'branch-missing', 'installing', 'add-failed', 'verify-failed']

console.log('== 1. 六个分因词条都被渲染路径取用 ==')
/*
 * 判「取用」不能只查词条名在文件里出现 —— `REBUILD_FAIL_KEY` 那张表本身就写着六个名字，
 * 恒真。所以查的是**取用方式**：`t(REBUILD_FAIL_KEY[...])` 这种动态取用必须存在，
 * 且 `res.message ??` 这种把词条顶掉的短路必须不存在。
 */
if (/t\(REBUILD_FAIL_KEY\[/.test(code)) ok('词条经 REBUILD_FAIL_KEY 动态取用', 't(REBUILD_FAIL_KEY[...])')
else bad('词条没有被取用', '找不到 t(REBUILD_FAIL_KEY[...])')
if (/REBUILD_FAIL_KEY\[res\.reason \?\? 'add-failed'\]|REBUILD_FAIL_KEY\[reason\]/.test(code))
  ok('reason 缺失时仍有 add-failed 兜底')
else bad('reason 兜底丢失', '协议里 ok:false 必带 reason，但界面仍需闭合类型')

/*
 * 核心反例：`res.message ?? t(...)`。这个写法下 `t(...)` 永远不执行，
 * 六条词条全成死代码 —— 正是这次要修的缺陷本身。
 *
 * 查的范围必须收窄到 rebuild 的失败分支：remove / prune 两处**该保留** `res.message ??`
 * （它们没有分因表，message 是唯一信息源），全局查会把它们当成缺陷，变成误报。
 */
const rebuildBlock = code.slice(code.indexOf('const rebuild ='))
const pruneAt = rebuildBlock.indexOf('const prune =')
const rebuildBody = pruneAt > 0 ? rebuildBlock.slice(0, pruneAt) : rebuildBlock
if (/res\.message\s*\?\?/.test(rebuildBody)) {
  bad('词条仍被 res.message ?? 短路', '右手边永不执行，分因文案一条也到不了用户眼前')
} else {
  ok('分因文案不再被 res.message 短路', 'rebuild 失败分支里没有 res.message ?? 写法')
}

console.log('\n== 2. 技术型两条的 message 确实进了渲染（方案 C 的核心）==')
/*
 * 方案 C 的取舍：`add-failed`（Git stderr）与 `verify-failed`（逐项不符清单）的原始报错
 * 是排查唯一线索，必须作为第二行显示。只验证词条取用会漏掉这一半 —— 那等于把 C 做成了「B」。
 */
const keepsMatch = code.match(/REBUILD_FAIL_KEEPS_DETAIL[\s\S]{0,400}?\]\)/)
if (!keepsMatch) bad('找不到 REBUILD_FAIL_KEEPS_DETAIL 集合', '技术型的判据无处可查')
else {
  const body = keepsMatch[0]
  for (const r of ['add-failed', 'verify-failed']) {
    if (body.includes(`'${r}'`)) ok(`${r} 的 message 会作为第二行显示`, `在 KEEPS_DETAIL 里`)
    else bad(`${r} 的 message 被丢掉`, '技术细节与词条不重叠，必须保留原文')
  }
  /*
   * 反向：描述型四条不该塞进这个集合，否则又变成「同一句话显示两遍」。
   */
  for (const r of ['dir-exists', 'branch-missing', 'not-found', 'installing']) {
    if (body.includes(`'${r}'`)) bad(`${r} 被误加进 KEEPS_DETAIL`, '它的 message 与词条同义，两行会重复')
  }
  if (!body.includes(`'dir-exists'`) && !body.includes(`'branch-missing'`))
    ok('描述型四条未被塞进 KEEPS_DETAIL', '不会出现同一句话显示两遍')
}
/* 第二行的实际接法：message 必须来自 res.message，且挂在 toast 的 message 槽位。 */
if (/message:\s*res\.message/.test(code)) ok('第二行取的是 res.message 原文')
else bad('第二行没有取 res.message', '技术细节丢失')

console.log('\n== 3. 占位符：词条带 {path}/{branch}，且渲染时确实被填充 ==')
/*
 * 后端在 `dir-exists` / `branch-missing` 两处**只填了 message，没有回填 path / branch**
 * （它们只在 ok:true 时用于回读核对）。所以界面不能从 message 里正则抠，要用 `view`：
 * `WorktreeListItem` 里 path、branch 都是**必填**，这才保证占位符不会渲染成「目录还在（）」。
 */
const PLACEHOLDERS = [
  ['dirExists', '{path}', 'path'],
  ['branchMissing', '{branch}', 'branch']
]
for (const [key, ph, field] of PLACEHOLDERS) {
  // 词条：zh 与 en 各一处，且都含占位符
  const hits = [...i18n.matchAll(new RegExp(`${key}:\\s*'([^']*)'`, 'g'))].map((m) => m[1])
  if (hits.length < 2) bad(`${key} 词条数不足`, `只有 ${hits.length} 处，应 zh + en 两处`)
  else if (!hits.every((s) => s.includes(ph))) bad(`${key} 占位符不全`, `不是每处都含 ${ph}`)
  else ok(`${key} 中英都带 ${ph}`, '2 处')
  // 渲染：必须真的替换，且替换要**挂在词条取值上**（同一段表达式里）。
  // 只查「文件里有 .replace('{path}', view.path)」会漏掉「写了但没接上」——
  // 实测把 `.replace(...)` 从 `t(...)` 后面摘掉，那种查法仍然全绿。
  const chainRe = new RegExp(`t\\(REBUILD_FAIL_KEY\\[[^\\]]*\\]\\)([\\s\\S]{0,160}?)\\.replace\\('${ph}',\\s*view\\.${field}\\)`)
  if (chainRe.test(code)) ok(`${key} 的 ${ph} 被 view.${field} 填充`, '挂在同一段链式调用上，不会漏出空括号')
  else bad(`${key} 的 ${ph} 没有被填充`, `词条取值后面没有接 .replace('${ph}', view.${field})，会漏出「…（${ph}）」`)
}

console.log('\n== 4. 六条词条 zh + en 齐全 ==')
const KEYS = [
  'notFound',
  'dirExists',
  'branchMissing',
  'installing',
  'addFailed',
  'verifyFailed'
]
for (const k of KEYS) {
  const n = (i18n.match(new RegExp(`^\\s{8}${k}:`, 'gm')) || []).length
  if (n >= 2) ok(`${k} 中英齐全`, `${n} 处`)
  else bad(`${k} 词条不全`, `只有 ${n} 处，应为 2（zh + en）`)
}

console.log('\n== 5. 另两处 res.message ?? 保留原样（无分因表，它是唯一信息源）==')
/*
 * remove / prune 失败没有分因枚举，`res.message` 就是后端能给的**全部**信息。
 * 把它们也「改造」掉等于丢信息 —— 判据在这里把「该保留」固定下来，防止后来者顺手统一。
 */
const keptCount = (code.match(/res\.message \?\? t\('cf\.wt\.remove\.failed'\)/g) || []).length
if (keptCount >= 2) ok('remove / prune 的 res.message 兜底仍在', `${keptCount} 处`)
else bad('remove / prune 的兜底被改动', `只剩 ${keptCount} 处，那两处无分因表，message 是唯一信息源`)

console.log(
  fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`
)
process.exit(fail === 0 ? 0 : 1)
