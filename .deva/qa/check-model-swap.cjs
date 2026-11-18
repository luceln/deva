#!/usr/bin/env node
/**
 * 模型失效标红 —— CI 可跑的断言（直接驱动真实逻辑，不是 AST 形状判据）。
 *
 * 迁移动机：合并上游 0.1.16 时，上游 9daa64f 把模型选择器整个重写成 ModelPanel，我们的
 * 「失效标红 + 批量替换」被暂时摘掉。本判据盯的就是迁回来之后**那几条判断不能出错**：
 *
 *   K1  本会话坏了才标红（别的会话坏不算）
 *   K2  kind 全为 nokey / keyunreadable → 警示色；只要有一处真坏 → 危险色
 *   K3  徽标数 = 主对话 + 名下成员的受影响总数
 *   K4  成员会话要按它的主对话判断（成员会话不进 sessions 列表）
 *   K5  swapFromRef 优先本会话自己的引用；比较前 trim（与主进程 normalizeRef 一致）
 *   K6  拿不到结论（缓存里没有）时不标红，不误伤
 *
 * 判据对象是真实的 brokenInfoOf / mainIdOf（ModelPanel.tsx 导出的纯函数），不是它的副本：
 * 用 esbuild 把 ModelPanel.tsx 打成 cjs，只把两个 store 换成桩（理由同 .deva/qa/model-panel/）。
 *
 * 本判据看不见的（每次运行都打印）：
 *   · 标红之后贴片实际长什么样（类名、颜色、文案）—— 要浏览器，见 .deva/qa/model-panel/
 *   · 点击是否真的打开 ModelSwapDialog、是否真的不弹模型面板 —— 同上
 *   · 上游新功能（圆环 / 百分比 / 自动压缩竖线 / 思考等级）是否还normal工作 —— 同上
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src')
const MP_DIR = path.join(QA, 'model-panel')

const passes = []
const problems = []
function ok(name, detail) {
  passes.push(detail ? `${name} —— ${detail}` : name)
}
function bad(name, detail) {
  problems.push(detail ? `${name} —— ${detail}` : name)
}
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

/** 把 ModelPanel.tsx 打成 cjs，store 换成桩（只取纯函数，不渲染）。 */
async function build() {
  // 产物必须落在仓库内：落在 os.tmpdir() 时 require('react') 解析不到 node_modules。
  const outDir = path.join(QA, 'dist')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `check-modelswap-${Date.now()}.cjs`)
  const stubPlugin = {
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /\/store\/chat$/ }, () => ({ path: path.join(MP_DIR, 'stub-chat.ts') }))
      b.onResolve({ filter: /\/store\/models$/ }, () => ({ path: path.join(MP_DIR, 'stub-models.ts') }))
      // CSS 只用于样式，纯函数用不到
      b.onResolve({ filter: /\.css$/ }, () => ({ path: 'noop.css', namespace: 'noop' }))
      b.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({ contents: '' }))
    }
  }
  await esbuild.build({
    entryPoints: [path.join(SRC, 'redesign', 'ModelPanel.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [stubPlugin],
    logLevel: 'error',
    // react / lucide 全部打进 bundle，避免运行时再去解析裸模块名
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')]
  })
  return out
}

/** 造一条失效记录。 */
const B = (sessionId, ref, kind) => ({ sessionId, ref, kind, name: sessionId })

async function main() {
  // 渲染层有些模块在顶层就读 window（如 shell-common 的 IS_MAC = window.deva.platform === 'darwin'）。
  // 本判据只取纯函数、不渲染，补一个最小桩即可；缺了它 require 阶段就抛 ReferenceError。
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { deva: { platform: 'win32' } }
  }

  const bundlePath = await build()
  const mod = require(bundlePath)
  fs.rmSync(bundlePath, { force: true })

  const { brokenInfoOf, mainIdOf } = mod
  if (typeof brokenInfoOf !== 'function') {
    bad('导出 brokenInfoOf', 'ModelPanel.tsx 没导出 brokenInfoOf，判据无从谈起')
    report()
    return
  }

  // ── K1 只有本会话坏了才标红 ─────────────────────────────────
  check('K1 本会话坏了 → broken 为真', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', { s1: [B('s1', 'p1:m1', 'model-disabled')] })
    eq(r.broken, true, '应标红')
  })
  check('K1 只有别的会话坏了 → 本会话不标红', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', { s1: [B('other', 'p1:m1', 'model-disabled')] })
    eq(r.broken, false, '别的会话坏不该连累本会话')
  })

  // ── K2 警示色 vs 危险色 ────────────────────────────────────
  const only = (kind) => brokenInfoOf('s1', 's1', 'p1:m1', { s1: [B('s1', 'p1:m1', kind)] })
  check('K2 nokey → onlyNoKey 为真（警示色）', () => eq(only('nokey').onlyNoKey, true, 'nokey'))
  check('K2 keyunreadable → onlyNoKey 为真（警示色）', () =>
    eq(only('keyunreadable').onlyNoKey, true, 'keyunreadable'))
  for (const kind of ['model-disabled', 'disabled', 'missing', 'malformed']) {
    check(`K2 ${kind} → onlyNoKey 为假（危险色）`, () => eq(only(kind).onlyNoKey, false, kind))
  }
  check('K2 一处 nokey + 一处 model-disabled → 危险色', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', {
      s1: [B('s1', 'p1:m1', 'nokey'), B('s2', 'p2:q1', 'model-disabled')]
    })
    eq(r.onlyNoKey, false, '只要有一处真坏就该用危险色')
  })
  check('K2 nokey + keyunreadable 混合 → 仍是警示色', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', {
      s1: [B('s1', 'p1:m1', 'nokey'), B('s2', 'p2:q1', 'keyunreadable')]
    })
    eq(r.onlyNoKey, true, '两者同属「密钥的事」')
  })

  // ── K3 徽标数 ──────────────────────────────────────────────
  check('K3 徽标数 = 主对话 + 成员受影响总数', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', {
      s1: [B('s1', 'p1:m1', 'model-disabled'), B('s2', 'p2:q1', 'nokey'), B('s3', 'p3:r1', 'missing')]
    })
    eq(r.count, 3, '徽标应数全部受影响会话')
  })
  check('K3 本会话没坏但缓存里有别的会话 → count 仍照实（供徽标用）', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', { s1: [B('other', 'p1:m1', 'nokey')] })
    eq(r.count, 1, 'count 照实')
    eq(r.broken, false, '但 broken 为假，不会显示徽标')
  })

  // ── K4 成员会话按主对话判断 ────────────────────────────────
  check('K4 mainIdOf：成员会话反查到主对话', () => {
    const sessions = [{ id: 'main', members: [{ sessionId: 'member-a' }, { sessionId: 'member-b' }] }]
    eq(mainIdOf(sessions, 'member-a'), 'main', '成员应归到主对话')
    eq(mainIdOf(sessions, 'main'), 'main', '主对话自己归自己')
    eq(mainIdOf(sessions, 'unknown'), 'unknown', '查不到就按自己')
  })
  check('K4 看成员会话时用主对话的缓存判断', () => {
    const sessions = [{ id: 'main', members: [{ sessionId: 'member-a' }] }]
    const mainId = mainIdOf(sessions, 'member-a')
    const r = brokenInfoOf(mainId, 'member-a', 'p1:m1', { main: [B('member-a', 'p1:m1', 'model-disabled')] })
    eq(r.broken, true, '成员会话自己的失效应被识别')
    eq(r.mainId, 'main', '替换范围应是主对话')
  })

  // ── K5 swapFromRef ────────────────────────────────────────
  check('K5 swapFromRef 优先本会话自己的引用', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m2', {
      s1: [B('s1', 'p1:m2', 'model-disabled'), B('s2', 'p2:q1', 'nokey')]
    })
    eq(r.swapFromRef, 'p1:m2', '应用本会话指向的那个')
  })
  check('K5 本会话指向了别的失效引用 → 退回 brokenHere 第一条', () => {
    // 本会话有两条失效（如主对话 + 它自己），boundModelRef 指向第二条时优先用第二条；
    // 指向的那个不在 brokenHere 里（本会话没坏）时压根不会进替换流程，故这里只测「有坏但引用对不上」。
    const r = brokenInfoOf('s1', 's1', 'p9:zz', {
      s1: [B('s1', 'p1:m1', 'model-disabled'), B('s1', 'p1:m3', 'nokey')]
    })
    eq(r.swapFromRef, 'p1:m1', '对不上时退回 brokenHere 第一条')
  })
  check('K5 本会话没坏（brokenHere 为空）→ swapFromRef 为空串，且 broken 为假', () => {
    // 这条是真实边界的说明：brokenHere 空 ⇒ 不标红 ⇒ 不会打开替换对话框，故空串是安全的。
    const r = brokenInfoOf('s1', 's1', 'p1:ok', { s1: [B('s2', 'p2:q1', 'nokey')] })
    eq(r.broken, false, '本会话没坏就不标红')
    eq(r.swapFromRef, '', '不标红时不会有替换动作，空串即可')
  })
  check('K5 比较前 trim（与主进程 normalizeRef 一致）', () => {
    // 会话里存的是带空格的引用，界面必须认得出来这是同一个
    const r = brokenInfoOf('s1', 's1', '  p1:m1  ', { s1: [B('s1', 'p1:m1', 'model-disabled')] })
    eq(r.swapFromRef, '  p1:m1  ', '带空格的引用应被认出并原样返回')
    assert(r.swapFromRef.trim() === 'p1:m1', '归一后应等于 p1:m1')
  })
  check('K5 反向验证：不 trim 就会认不出（确认这条判据不是空的）', () => {
    // 手算一遍「不 trim」的行为，证明上面的用例确实在考 trim
    const stored = '  p1:m1  '
    const scannedRef = 'p1:m1'
    eq(stored === scannedRef, false, '不 trim 时两者不相等，上面的用例才有意义')
  })

  // ── K6 拿不到结论不标红 ────────────────────────────────────
  check('K6 缓存里没有该主对话 → 不标红', () => {
    const r = brokenInfoOf('s1', 's1', 'p1:m1', {})
    eq(r.broken, false, '没有结论时不能把用户赶去换模型')
    eq(r.count, 0, '没有结论时徽标为 0')
  })
  check('K6 brokenModels 为 undefined 形状（旧缓存）→ 不抛错、不标红', () => {
    const r = brokenInfoOf('s1', 's1', undefined, {})
    eq(r.broken, false, '缺引用时不标红')
    eq(r.swapFromRef, '', '没有可换的引用时为空串')
  })

  report()
}

function report() {
  for (const p of passes) console.log(`  PASS ${p}`)
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\n${passes.length} PASS / ${problems.length} FAIL`)
  console.log(
    '\n边界：本判据驱动的是真实的 brokenInfoOf / mainIdOf（不是副本），' +
      '但它只证明「判断对不对」，证明不了「红色贴片长什么样、点了会怎样、上游新功能还在不在」。' +
      '那部分见 .deva/qa/model-panel/README.md（浏览器驱动真实 ModelPanel，需手动跑）。'
  )
  if (problems.length > 0) process.exit(1)
  console.log('模型失效标红：判断逻辑合规。')
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
