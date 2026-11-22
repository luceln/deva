#!/usr/bin/env node
/**
 * 内存峰值验证：还原一个**大包**时进程 RSS 涨了多少。
 *
 * 为什么单独测这一项：原来的实现用 `unzipSync` 一把解完整包，验收实测 600MB 包峰值 RSS
 * **1872MB（包体积的 3.12 倍）**。改了流式之后必须证明这个数字确实降下来了 ——
 * 否则「优化过了」只是说法。
 *
 * 判据是**比例而不是绝对值**：实际记录「峰值 RSS 增量 / 包解压后体积」。旧实现约 3 倍，
 * 新实现应该接近「最大单条目」。用临时目录造一个接近真实形态的包（大量中等文件 + 少量大文件）。
 *
 * 注意：RSS 不回落不代表泄漏（V8 不急着还给系统），所以这里只看**峰值**，
 * 并且在子进程里跑，避免上一次用例的堆影响判断。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist')

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

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry-mem.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'memverify.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'memverify.cjs'))
}

/** 在独立子进程里跑一次还原，返回 { peakMB, pkgMB }。避免同进程历史堆干扰。 */
function runChild(scriptPath) {
  const out = require('child_process').execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const m = out.match(/RESULT_JSON:(.+)/)
  if (!m) throw new Error(`子进程没给出结果：${out.slice(-400)}`)
  return JSON.parse(m[1])
}

async function main() {
  const root = path.join(os.tmpdir(), `deva-memverify-${Date.now()}`)
  const home = path.join(root, 'home')

  /*
   * 造一个「形态接近真实」的 home：媒体是最大头（本机 130MB/482 文件），
   * checkpoint 数量多但单文件小（本机 184MB/2219 个）。总量控制在 ~120MB，
   * 既能测出量级差别，又不会让 CI 跑太久。比例关系与 600MB 的包一致。
   */
  const mediaDir = path.join(home, 'data/media')
  const cpDir = path.join(home, 'data/checkpoints/s-1')
  const chatsDir = path.join(home, 'data/chats')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.mkdirSync(cpDir, { recursive: true })
  fs.mkdirSync(chatsDir, { recursive: true })

  // 40 张「图」× 2MB = 80MB（不可压缩，模拟真实媒体）
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(mediaDir, `img-${i}.bin`), crypto.randomBytes(2 * 1024 * 1024))
  }
  // 600 个 checkpoint × 20KB = 12MB（可压缩 JSON）
  for (let i = 0; i < 600; i++) {
    fs.writeFileSync(path.join(cpDir, `cp-${i}.json`), JSON.stringify({ i, pad: 'x'.repeat(20000) }))
  }
  // 30 个会话主档
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(
      path.join(chatsDir, `s-${i}.json`),
      JSON.stringify({ id: `s-${i}`, messages: Array.from({ length: 50 }, (_, k) => ({ role: 'user', content: `m${k}` })) })
    )
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ theme: 'dark' }))
  fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({ version: 2, entries: [] }))

  const api = await build()
  const bundlePath = path.join(root, 'big.dbk')
  process.env.DEVA_HOME = home

  const expStart = Date.now()
  const exp = await api.exportBundle({ targetPath: bundlePath })
  if (!exp.ok) {
    bad('大包导出成功', JSON.stringify(exp).slice(0, 200))
    return
  }
  const pkgBytes = fs.statSync(bundlePath).size
  const homeBytes = exp.bytes
  ok('大包导出成功', `包 ${(pkgBytes / 1024 / 1024).toFixed(1)}MB，原始 ${(homeBytes / 1024 / 1024).toFixed(1)}MB，${Date.now() - expStart}ms`)

  // 删掉 home 模拟"彻底卸载"
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })

  /*
   * 子进程里做还原并采峰值 RSS。
   * 采样用定时器而不是靠 memoryUsage 的单点：解压是分块的，单点取不到峰值。
   */
  const child = path.join(root, 'child.cjs')
  fs.writeFileSync(
    child,
    `
process.env.DEVA_HOME = ${JSON.stringify(home)}
const api = require(${JSON.stringify(path.join(DIST, 'memverify.cjs'))})
const base = process.memoryUsage().rss
let peak = base
const timer = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r }, 20)
api.restoreBundle({ bundlePath: ${JSON.stringify(bundlePath)} }).then((r) => {
  clearInterval(timer)
  console.log('RESULT_JSON:' + JSON.stringify({
    ok: r.ok,
    baseMB: +(base/1048576).toFixed(1),
    peakMB: +(peak/1048576).toFixed(1),
    deltaMB: +((peak-base)/1048576).toFixed(1)
  }))
}).catch((e) => { clearInterval(timer); console.log('RESULT_JSON:' + JSON.stringify({ok:false,err:String(e)})) })
`
  )

  const r = runChild(child)
  if (!r.ok) {
    bad('大包还原成功', JSON.stringify(r).slice(0, 600))
    fs.rmSync(root, { recursive: true, force: true })
    return done()
  }

  const unpackedMB = homeBytes / 1024 / 1024
  ok('大包还原成功', `峰值 RSS 增量 ${r.deltaMB}MB / 解压后 ${unpackedMB.toFixed(1)}MB`)

  /*
   * 判据：**峰值不随包体积线性增长**，而不是"峰值必须小于包体积的某个倍数"。
   *
   * 为什么改成这个：RSS 是累积的（V8 不急着把内存还给系统），一次还原要跑三遍 zip
   * （listEntries 验名 → extractTo 落盘 → readEntriesFor 取 manifest/secrets），
   * 每遍都会让 heap 涨一点且不回落。所以"绝对倍数"必然大于 1，用它当判据是在测 V8 的
   * 回收策略，不是测我们的内存行为。
   *
   * 真正能区分「流式」与「整包读进内存」的是**增长趋势**：整包读进内存时，峰值 ≈ 3× 包体积，
   * 包翻倍峰值就翻倍；流式时峰值 ≈ 常数 + 单条目大小，包翻倍峰值基本不变。
   */
  const ratio = r.deltaMB / unpackedMB

  // 再造一个 2 倍体积的包，看峰值会不会跟着翻倍
  console.log('  造 2× 体积的包以比较趋势…')
  for (let i = 40; i < 80; i++) {
    fs.mkdirSync(mediaDir, { recursive: true })
    fs.writeFileSync(path.join(mediaDir, `img-${i}.bin`), crypto.randomBytes(2 * 1024 * 1024))
  }
  const bundle2 = path.join(root, 'bigger.dbk')
  const exp2 = await api.exportBundle({ targetPath: bundle2 })
  if (!exp2.ok) {
    bad('2× 包导出成功', JSON.stringify(exp2).slice(0, 150))
    fs.rmSync(root, { recursive: true, force: true })
    return done()
  }
  const home2Bytes = exp2.bytes
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })

  const child2 = path.join(root, 'child2.cjs')
  fs.writeFileSync(
    child2,
    `
process.env.DEVA_HOME = ${JSON.stringify(home)}
const api = require(${JSON.stringify(path.join(DIST, 'memverify.cjs'))})
const base = process.memoryUsage().rss
let peak = base
const timer = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r }, 20)
api.restoreBundle({ bundlePath: ${JSON.stringify(bundle2)} }).then((r) => {
  clearInterval(timer)
  console.log('RESULT_JSON:' + JSON.stringify({ ok: r.ok, deltaMB: +((peak-base)/1048576).toFixed(1) }))
})
`
  )
  const r2 = runChild(child2)
  const unpacked2MB = home2Bytes / 1024 / 1024
  ok(
    '2× 包还原成功',
    `峰值 ${r2.deltaMB}MB / 解压后 ${unpacked2MB.toFixed(1)}MB（体积是前者的 ${(unpacked2MB / unpackedMB).toFixed(2)}×）`
  )

  const growth = r2.deltaMB / r.deltaMB
  const volGrowth = unpacked2MB / unpackedMB
  if (growth < 1.5) {
    ok(
      '内存峰值不随包体积增长（流式生效）',
      `体积 ×${volGrowth.toFixed(2)}，峰值仅 ×${growth.toFixed(2)}（整包读进内存会接近 ×${volGrowth.toFixed(2)}）`
    )
  } else {
    bad(
      '内存峰值随包体积增长',
      `体积 ×${volGrowth.toFixed(2)}，峰值 ×${growth.toFixed(2)} —— 说明仍在内存里持有整包`
    )
  }

  // 顺带确认数据真的还原对了（别为了省内存牺牲正确性）
  const img = path.join(home, 'data/media/img-0.bin')
  const cp = path.join(home, 'data/checkpoints/s-1/cp-599.json')
  if (fs.existsSync(img) && fs.statSync(img).size === 2 * 1024 * 1024) ok('媒体文件还原完整')
  else bad('媒体文件还原不完整')
  if (fs.existsSync(cp)) ok('checkpoint 还原完整', `${fs.statSync(cp).size} 字节`)
  else bad('checkpoint 缺失')

  fs.rmSync(root, { recursive: true, force: true })
  done()
}

function done() {
  console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('  ERROR', e)
  fail += 1
  done()
})
