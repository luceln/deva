/**
 * i18n 词条完整性校验：拆分 `messages.ts` 前后，每个点分 key 的**集合与值**都必须逐字一致。
 *
 * 背景：`MessageTree` 是索引签名（`[key: string]: string | MessageTree`），少写一个 key 编译器完全不报；
 * 这与 preload 那次「删掉方法 tsc 仍通过」是同一类静默失效。所以这里不依赖编译器，而是直接加载模块、
 * 把嵌套字典摊平成点分 key 再逐条比对。
 *
 * 用法：
 *   node .deva/qa/check-i18n-keys.cjs --write-baseline   # 改动前采集基线（写 i18n-keys.baseline.json）
 *   node .deva/qa/check-i18n-keys.cjs                    # 改动后比对，逐 key 比集合与值
 *
 * 探针与真实使用路径一致：esbuild 把 messages.ts 打成一个 CJS 包，在 Node 里 import 后读 `messages`。
 * 不给产品代码加任何只供测试用的导出。
 *
 * 基线变更（有意的文案增删）要重新 `--write-baseline`，属于有意的契约变更，不是放宽检查。
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const QA = __dirname
const ROOT = path.resolve(QA, '..', '..')
const ENTRY = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'i18n', 'messages.ts')
const BASELINE = path.join(QA, 'i18n-keys.baseline.json')

/** 递归摊平：`{ a: { b: 'x' } }` → `{ 'a.b': 'x' }`。空对象与数组都当异常值，原样记录以便比对。 */
function flatten(node, prefix = '', out = {}) {
  if (node === null || typeof node !== 'object') {
    out[prefix] = JSON.stringify(node)
    return out
  }
  if (Array.isArray(node)) {
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
  const code = bundle.outputFiles[0].text
  const tmp = path.join(QA, '.i18n-probe.cjs')
  fs.writeFileSync(tmp, code)
  try {
    const mod = require(tmp)
    const out = {}
    for (const locale of Object.keys(mod.messages)) out[locale] = flatten(mod.messages[locale])
    return out
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

const roundTrip = (obj) => {
  // 稳定排序，比对与 diff 输出都不受书写顺序影响
  const sorted = {}
  for (const locale of Object.keys(obj).sort()) {
    sorted[locale] = {}
    for (const k of Object.keys(obj[locale]).sort()) sorted[locale][k] = obj[locale][k]
  }
  return sorted
}

if (process.argv.includes('--write-baseline')) {
  const snapshot = roundTrip(collect())
  fs.writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`)
  const n = Object.values(snapshot).reduce((a, s) => a + Object.keys(s).length, 0)
  console.log(`baseline written: ${path.relative(ROOT, BASELINE)}`)
  for (const [loc, s] of Object.entries(snapshot)) console.log(`  ${loc}: ${Object.keys(s).length} keys`)
  console.log(`  total: ${n} keys`)
  process.exit(0)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
const current = roundTrip(collect())
const problems = []

for (const locale of Object.keys(baseline)) {
  const want = baseline[locale]
  const got = current[locale]
  if (!got) {
    problems.push(`${locale}: 整个语言块缺失`)
    continue
  }
  const wantKeys = new Set(Object.keys(want))
  const gotKeys = new Set(Object.keys(got))
  const missing = [...wantKeys].filter((k) => !gotKeys.has(k))
  const extra = [...gotKeys].filter((k) => !wantKeys.has(k))
  if (missing.length) problems.push(`${locale}: 少了 ${missing.length} 个 key\n    ${missing.join('\n    ')}`)
  if (extra.length) problems.push(`${locale}: 多了 ${extra.length} 个 key\n    ${extra.join('\n    ')}`)
  const changed = [...wantKeys].filter((k) => gotKeys.has(k) && want[k] !== got[k])
  if (changed.length) {
    const detail = changed
      .slice(0, 20)
      .map((k) => `${k}\n      基线: ${want[k]}\n      现在: ${got[k]}`)
      .join('\n')
    problems.push(`${locale}: ${changed.length} 个 key 的值变了（结构搬家不许改文案）\n    ${detail}`)
  }
}

const totalKeys = Object.values(baseline).reduce((a, s) => a + Object.keys(s).length, 0)
if (problems.length) {
  console.error('i18n 词条校验失败：')
  console.error(problems.join('\n'))
  console.error('\nexit=1')
  process.exit(1)
}
console.log(
  `i18n keys OK: ${Object.keys(baseline)
    .map((l) => `${l}=${Object.keys(baseline[l]).length}`)
    .join(', ')}（共 ${totalKeys}），集合与值逐字一致`
)
