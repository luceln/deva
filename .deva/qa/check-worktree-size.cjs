#!/usr/bin/env node
/**
 * `worktree:size` 增量回填 —— CI 可跑的断言（驱动真实逻辑，不是「字符串在文件里」）。
 *
 * ## 为什么需要它
 *
 * 本轮出现过一个回归：主进程把体积回填从 `worktree:changed` 改成 `worktree:size` 增量事件
 * （为了不整表重拉），但渲染层没人订阅 `onSize`。后果是 `sizeBytes` 永远是 `null`，
 * 界面永远停在「统计中…」——上一轮刚修掉的症状又回来了。
 *
 * 这类 bug 的形状是「A 发了事件、B 没接」：编译、类型、人眼全都看不出来，
 * 上一轮踩过的坑（注释里也写着 onSize）还能让「字符串存在」型判据照样绿。
 * 所以本判据**跑数据**：拿真实的 `applySizeUpdate` 纯函数，喂一条事件，看快照里的
 * `sizeBytes` 是否真的变了。
 *
 * 判据：
 *   S1  `applySizeUpdate` 导出且可用
 *   S2  命中 compareKey → 那一条的 sizeBytes 变成事件里的值
 *   S3  其余字段与其余记录原样（只补一个字段，不整表重建）
 *   S4  值没变时返回同一个 state 引用（体积事件连发多条，不该引起重渲染）
 *   S5  找不到 compareKey → 原样返回（统计期间那条被删了是正常事）
 *   S6  还没有快照 → 原样返回
 *   S7  store 真的订阅了 `onSize`，且回调走 `applySizeUpdate`（不是自己另写一套）
 *   S8  `onSize` 的回调里**没有**调用 `refresh()`（否则并行化收益全还回去了）
 *   S9  两个订阅都有取消（卸载清理）：`offChanged()` 与 `offSize()` 都出现在 cleanup 里
 *
 * 它**不能**证明的：主进程真的会发这条事件、发出来的 compareKey 对得上、界面上的
 * 「统计中…」真的变成了数字。那些要跑主进程与浏览器。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src')
const STORE = path.join(SRC, 'store', 'worktree.tsx')

const passes = []
const problems = []
const ok = (n, d) => passes.push(d ? `${n} —— ${d}` : n)
const bad = (n, d) => problems.push(d ? `${n} —— ${d}` : n)

function check(name, fn) {
  try {
    fn()
    ok(name)
  } catch (e) {
    bad(name, e.message)
  }
}
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 把 store/worktree.tsx 打成 cjs。只取导出的纯函数，不渲染。 */
async function build() {
  const outDir = path.join(QA, 'dist')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `check-wtsize-${Date.now()}.cjs`)
  await esbuild.build({
    entryPoints: [STORE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')],
    plugins: [
      {
        name: 'noop-css',
        setup(b) {
          b.onResolve({ filter: /\.css$/ }, () => ({ path: 'noop.css', namespace: 'noop' }))
          b.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({ contents: '' }))
        }
      }
    ]
  })
  return out
}

/** 造一条列表项（只填断言用得到的字段）。 */
const item = (compareKey, sizeBytes, extra = {}) => ({
  path: `C:\\wts\\${compareKey}`,
  compareKey,
  repoRoot: 'C:\\repo',
  branch: compareKey,
  baseSha: 'abc1234',
  baseLabel: 'dev',
  targetBranch: 'dev',
  createdAt: 1,
  state: 'ok',
  deps: 'ready',
  sessionCount: 1,
  sizeBytes,
  lockHolder: null,
  dirtyCount: 0,
  mergeInProgress: null,
  mergeGate: { mayMerge: true },
  ...extra
})

const snapOf = (...items) => ({ snapshot: { items, unmanaged: [], storeUnreadable: false }, loading: false, error: null })

async function main() {
  // store/worktree.tsx 顶层只 import react 与 shared 类型，不读 window；补上以防将来加。
  if (typeof globalThis.window === 'undefined') globalThis.window = { deva: { platform: 'win32' } }

  const bundlePath = await build()
  const mod = require(bundlePath)
  fs.rmSync(bundlePath, { force: true })

  const { applySizeUpdate } = mod
  if (typeof applySizeUpdate !== 'function') {
    bad('S1 导出 applySizeUpdate', 'store/worktree.tsx 没导出 applySizeUpdate，判据无从谈起')
    report()
    return
  }
  ok('S1 导出 applySizeUpdate', 'store/worktree.tsx')

  // ── S2 / S3：命中就换那一条，别的都不动 ──
  check('S2 命中 compareKey → sizeBytes 变成事件里的值', () => {
    const base = snapOf(item('a', null), item('b', null))
    const next = applySizeUpdate(base, { compareKey: 'a', sizeBytes: 1234 })
    eq(next.snapshot.items[0].sizeBytes, 1234, 'a 应该变成 1234')
    eq(next.snapshot.items[1].sizeBytes, null, 'b 不该被动到')
  })

  check('S3 其余字段与其余记录原样（只补一个字段）', () => {
    const base = snapOf(item('a', null, { sessionCount: 7, deps: 'failed' }), item('b', 99))
    const next = applySizeUpdate(base, { compareKey: 'a', sizeBytes: 2048 })
    eq(next.snapshot.items[0], { ...base.snapshot.items[0], sizeBytes: 2048 }, 'a 除 sizeBytes 外应完全相同')
    eq(next.snapshot.items[1], base.snapshot.items[1], 'b 应完全相同')
    eq(next.snapshot.items.length, 2, '条数不应变')
    eq(next.loading, base.loading, 'loading 不应变')
    eq(next.error, base.error, 'error 不应变')
    assert(next.snapshot.unmanaged === base.snapshot.unmanaged, 'unmanaged 不该被重建')
  })

  // ── S4：值没变不换引用 ──
  check('S4 值没变 → 返回同一个 state 引用（避免连发事件引起重渲染）', () => {
    const base = snapOf(item('a', 1234))
    const next = applySizeUpdate(base, { compareKey: 'a', sizeBytes: 1234 })
    assert(next === base, '同值时应返回原 state 引用')
  })

  // ── S5：找不到 compareKey ──
  check('S5 找不到 compareKey → 原样返回', () => {
    const base = snapOf(item('a', null))
    const next = applySizeUpdate(base, { compareKey: 'zzz', sizeBytes: 1 })
    assert(next === base, '未知 compareKey 应原样返回')
  })

  // ── S6：还没有快照 ──
  check('S6 还没有快照 → 原样返回', () => {
    const base = { snapshot: null, loading: true, error: null }
    const next = applySizeUpdate(base, { compareKey: 'a', sizeBytes: 1 })
    assert(next === base, '无快照时应原样返回')
  })

  // ── S7 / S8 / S9：静态部分（订阅真的接了、没有在回调里重拉、两个都清理）──
  const src = fs.readFileSync(STORE, 'utf8')

  check('S7 store 订阅了 onSize 且走 applySizeUpdate', () => {
    // 必须出现 `worktree.onSize(` 调用（不是注释里的字样）：要求前面有 `window.deva.worktree.`
    assert(/window\.deva\.worktree\.onSize\s*\(/.test(src), '没有 window.deva.worktree.onSize(...) 订阅')
    // 回调体里必须调用 applySizeUpdate（不能自己另写一套更新逻辑）
    const m = src.match(/window\.deva\.worktree\.onSize\s*\(\s*\(([^)]*)\)\s*=>\s*\{([\s\S]{0,400}?)\n\s*\}\)/)
    assert(m, '没能定位 onSize 回调体')
    assert(/applySizeUpdate\s*\(/.test(m[2]), `onSize 回调里没有 applySizeUpdate：${m[2].trim().slice(0, 120)}`)
  })

  check('S8 onSize 回调里没有触发 refresh（否则增量省下的时间全还回去）', () => {
    const m = src.match(/window\.deva\.worktree\.onSize\s*\(\s*\(([^)]*)\)\s*=>\s*\{([\s\S]{0,400}?)\n\s*\}\)/)
    assert(m, '没能定位 onSize 回调体')
    assert(!/refresh\s*\(/.test(m[2]), `onSize 回调里调了 refresh：${m[2].trim().slice(0, 120)}`)
  })

  check('S9 两个订阅都在 cleanup 里取消（无泄漏）', () => {
    assert(/offChanged\(\)/.test(src), 'cleanup 里没有 offChanged()')
    assert(/offSize\(\)/.test(src), 'cleanup 里没有 offSize()')
    // 两个取消调用必须在同一个 return () => {...} 里
    const cl = src.match(/return \(\) => \{([\s\S]{0,300}?)\}/)
    assert(cl, '没找到 cleanup 函数')
    assert(/offChanged\(\)/.test(cl[1]) && /offSize\(\)/.test(cl[1]), '两个取消不在同一个 cleanup 里')
  })

  report()
}

function report() {
  for (const p of passes) console.log(`PASS ${p}`)
  for (const p of problems) console.log(`FAIL ${p}`)
  console.log(`\n共 ${passes.length} PASS / ${problems.length} FAIL`)
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
