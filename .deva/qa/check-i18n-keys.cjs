/**
 * i18n 结构校验：拆分 / 重构 `messages.ts` 前后，点分 key 的**集合**必须完全一致。
 *
 * 背景：`MessageTree` 是索引签名（`[key: string]: string | MessageTree`），少写一个 key 编译器完全不报；
 * 这与 preload 那次「删掉方法 tsc 仍通过」是同一类静默失效。所以这里不依赖编译器，直接加载模块、
 * 把嵌套字典摊平成点分 key 再比对。
 *
 * **守的是结构完整性，不是「文案一个字都不许改」。** 基线只存 key 集合（排序后的数组），不存文案值：
 * 存了值就意味着以后谁正常改一句文案，CI 都会红，还逼人去重新生成基线——那是制造摩擦，不是防回归。
 * 真要核对「搬运时有没有手滑改文案」，手动跑一次 `--verify-values`（值快照存本地、不入库、不进 CI）。
 *
 * 用法：
 *   node .deva/qa/check-i18n-keys.cjs                  # 默认：只比 key 集合（CI 与 driver 用这个）
 *   node .deva/qa/check-i18n-keys.cjs --write-baseline # 有意增删词条后，重新采集 key 集合基线
 *   node .deva/qa/check-i18n-keys.cjs --write-values   # 写本地值快照（.i18n-values.local.json，已忽略）
 *   node .deva/qa/check-i18n-keys.cjs --verify-values  # 逐字比对本地值快照（一次性核对，默认不跑）
 *
 * 探针与真实使用路径一致：esbuild 把 messages.ts 打成一个 CJS 包，在 Node 里 require 后读 `messages`。
 * 不给产品代码加任何只供测试用的导出。
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const QA = __dirname
const ROOT = path.resolve(QA, '..', '..')
const ENTRY = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'i18n', 'messages.ts')
/** 入库的结构基线：只有 key 名，没有文案值。 */
const BASELINE = path.join(QA, 'i18n-keys.baseline.json')
/** 本地值快照：只用于手动 `--verify-values`，不入库、不进 CI。 */
const VALUES = path.join(QA, 'i18n-values.local.json')

/** 递归摊平：`{ a: { b: 'x' } }` → `{ 'a.b': 'x' }`。空对象记成一个哨兵值，便于比对结构。 */
function flatten(node, prefix = '', out = {}) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out[prefix] = JSON.stringify(node)
    return out
  }
  const keys = Object.keys(node)
  if (!keys.length) out[prefix] = '<empty-object>'
  for (const k of keys) flatten(node[k], prefix ? `${prefix}.${k}` : k, out)
  return out
}

/** 加载 messages.ts，返回 { 'zh-CN': {点分key: 值}, en: {...} }。 */
function collect() {
  const bundle = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  })
  const tmp = path.join(QA, '.i18n-probe.cjs')
  fs.writeFileSync(tmp, bundle.outputFiles[0].text)
  try {
    const mod = require(tmp)
    const out = {}
    for (const locale of Object.keys(mod.messages)) out[locale] = flatten(mod.messages[locale])
    return out
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** 排序稳定的 key 集合（入库形态：只有 key，没有值）。 */
const keySets = (flat) => {
  const out = {}
  for (const locale of Object.keys(flat).sort()) out[locale] = Object.keys(flat[locale]).sort()
  return out
}

const argv = process.argv.slice(2)
const current = collect()

if (argv.includes('--write-baseline')) {
  const snapshot = keySets(current)
  fs.writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`baseline written: ${path.relative(ROOT, BASELINE)}`)
  for (const [loc, keys] of Object.entries(snapshot)) console.log(`  ${loc}: ${keys.length} keys`)
  process.exit(0)
}

if (argv.includes('--write-values')) {
  const snapshot = {}
  for (const locale of Object.keys(current).sort()) {
    snapshot[locale] = {}
    for (const k of Object.keys(current[locale]).sort()) snapshot[locale][k] = current[locale][k]
  }
  fs.writeFileSync(VALUES, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`values snapshot written (local only): ${path.relative(ROOT, VALUES)}`)
  console.log('注意：这个文件不入库、不进 CI，只在手动核对「搬运有没有改文案」时用。')
  process.exit(0)
}

if (argv.includes('--verify-values')) {
  if (!fs.existsSync(VALUES)) {
    console.error(`没有值快照：${path.relative(ROOT, VALUES)}`)
    console.error('先跑 node .deva/qa/check-i18n-keys.cjs --write-values')
    process.exit(2)
  }
  const want = JSON.parse(fs.readFileSync(VALUES, 'utf8'))
  const problems = []
  for (const locale of Object.keys(want)) {
    const got = current[locale]
    if (!got) {
      problems.push(`${locale}: 整个语言块缺失`)
      continue
    }
    const changed = Object.keys(want[locale]).filter((k) => got[k] !== undefined && want[locale][k] !== got[k])
    for (const k of changed.slice(0, 20)) {
      problems.push(`${locale}.${k}\n      快照: ${want[locale][k]}\n      现在: ${got[k]}`)
    }
    if (changed.length > 20) problems.push(`${locale}: 另有 ${changed.length - 20} 个值不同，已省略`)
  }
  if (problems.length) {
    console.error('文案逐字比对失败（--verify-values）：')
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('文案逐字一致（--verify-values，本地一次性核对，不属于默认校验）')
  process.exit(0)
}

// 默认：只比 key 集合。文案值不参与比对——改文案不该让这条门禁变红。
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
const problems = []
let total = 0
for (const locale of Object.keys(baseline)) {
  const want = baseline[locale]
  const got = current[locale] ? Object.keys(current[locale]) : null
  if (!got) {
    problems.push(`${locale}: 整个语言块缺失`)
    continue
  }
  total += want.length
  const wantSet = new Set(want)
  const gotSet = new Set(got)
  const missing = want.filter((k) => !gotSet.has(k))
  const extra = got.filter((k) => !wantSet.has(k))
  if (missing.length) problems.push(`${locale}: 少了 ${missing.length} 个 key\n    ${missing.join('\n    ')}`)
  if (extra.length) problems.push(`${locale}: 多了 ${extra.length} 个 key\n    ${extra.join('\n    ')}`)
}

if (problems.length) {
  console.error('i18n 结构校验失败：')
  console.error(problems.join('\n'))
  console.error('\n（只比 key 集合；有意增删词条时跑 --write-baseline 更新基线）')
  console.error('exit=1')
  process.exit(1)
}
console.log(`  PASS i18n key 集合与基线一致 :: ${Object.keys(baseline)
  .map((l) => `${l}=${baseline[l].length}`)
  .join(', ')}（共 ${total}）`)
