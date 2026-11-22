#!/usr/bin/env node
/**
 * 验证「冲突收尾出口」的两个前提是否成立（真实逻辑，非源码形状）。
 *
 * ## 为什么需要它
 *
 * spec §4.7 要求合并失败后给四个平权出口，其中「在文件管理器打开」走 `fs:reveal-folder`，
 * 而该通道用 `isInsideRoot()` 判定 **必须落在受信根内**。spec 的原话警告：
 *
 *   > 需 targetPath 在受信根内 → C4 之后必须 trustRoot(targetPath)。
 *   > 创建流程已 trustRoot(repoRoot)，但 targetPath 可能是另一个 worktree，
 *   > 不 trustRoot 会返回 { ok: false }（不抛错，静默失败）。
 *
 * `targetPath` 是「目标分支的唯一检出目录」，可能根本不是 repoRoot —— 于是这个失败很典型：
 * 按钮能点、点了没反应、不报错。
 *
 * ## 判据
 *   T1  isInsideRoot 对未信任的目录返回 false（这是静默失败的因）
 *   T2  trustRoot 之后 isInsideRoot 返回 true（修法有效）
 *   T3  子目录随根一起被覆盖（targetPath 下钻一层也该能开）
 *   T4  trustRoot 后仍然挡得住根外的路径（不能因为修这个就把闸门拆了）
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'main', 'services')
const DIST = path.join(QA, 'dist')

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'fsguard-entry.ts')
  fs.writeFileSync(
    entry,
    `export { isInsideRoot, trustRoot, untrustRoot, listRoots } from ${JSON.stringify(path.join(SRC, 'fs-guard.ts'))}\n`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'fsguard.cjs'),
    external: ['electron'],
    logLevel: 'error'
  })
  return path.join(DIST, 'fsguard.cjs')
}

const results = []
function check(id, name, ok, detail) {
  results.push({ ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` :: ${detail}` : ''}`)
}

async function main() {
  const mod = require(await build())
  const root = path.join(os.tmpdir(), `deva-fsguard-${Date.now()}`)
  const inside = path.join(root, 'target-checkout')
  const deep = path.join(inside, 'src')
  const outside = path.join(os.tmpdir(), `deva-fsguard-outside-${Date.now()}`)
  fs.mkdirSync(deep, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })

  try {
    // 干净起点：不受其它用例残留影响
    mod.untrustRoot(root)

    // T1：未信任 → false。这就是「点了没反应」的因。
    const before = mod.isInsideRoot(inside)
    check('T1', '未 trustRoot 的 targetPath 被判越界', before === false, `isInsideRoot=${before}`)

    // T2：trustRoot 之后 → true
    mod.trustRoot(inside)
    const after = mod.isInsideRoot(inside)
    check('T2', 'trustRoot(targetPath) 后判为根内', after === true, `isInsideRoot=${after}`)

    // T3：其子目录随之覆盖
    const deepOk = mod.isInsideRoot(deep)
    check('T3', 'targetPath 的子目录同样根内', deepOk === true, `isInsideRoot=${deepOk}`)

    // T4：闸门没被拆——根外仍然越界
    const outOk = mod.isInsideRoot(outside)
    check('T4', '根外路径仍然越界', outOk === false, `isInsideRoot=${outOk}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }

  const fails = results.filter((r) => !r.ok).length
  console.log('')
  if (fails === 0) {
    console.log(`受信根行为校验通过：${results.length} 项`)
    process.exit(0)
  }
  console.log(`受信根行为校验失败：${fails}/${results.length} 项`)
  process.exit(1)
}

main().catch((e) => {
  console.error('运行出错：', e && e.stack ? e.stack : e)
  process.exit(2)
})
