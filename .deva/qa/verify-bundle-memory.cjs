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
   *
   * **必须把失败原因带回来**（`code` / `message`）：只回 `ok:false` 时，上层只能打印
   * 「大包还原失败」四个字，看不到是 corrupt（包坏了）、write-failed（磁盘/权限）还是
   * cancelled（目标非空）—— 那三种的处置完全不同，看不到就只能猜。
   *
   * `overwriteConfirmed: true` 是刻意的：目标 home 刚被删空又重建，本来就没有需要保护的数据。
   * 不传它时 `restoreBundle` 在目标非空 / 需确认时会返回 `cancelled`，
   * 那个结果与真失败混在一起看，会让「还原挂了」和「它只是没被允许覆盖」变得无法区分。
   * （本脚本原本就漏传，是三个脚本缺陷之一。）
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
api.restoreBundle({ bundlePath: ${JSON.stringify(bundlePath)}, overwriteConfirmed: true }).then((r) => {
  clearInterval(timer)
  console.log('RESULT_JSON:' + JSON.stringify({
    ok: r.ok,
    code: r.ok ? null : r.code,
    message: r.ok ? null : r.message,
    baseMB: +(base/1048576).toFixed(1),
    peakMB: +(peak/1048576).toFixed(1),
    deltaMB: +((peak-base)/1048576).toFixed(1)
  }))
}).catch((e) => { clearInterval(timer); console.log('RESULT_JSON:' + JSON.stringify({ok:false,code:'threw',message:String(e),deltaMB:0})) })
`
  )

  const r = runChild(child)
  if (!r.ok) {
    bad('大包还原成功', `code=${r.code ?? '?'} message=${String(r.message ?? '').slice(0, 600)}`)
    fs.rmSync(root, { recursive: true, force: true })
    return done()
  }
  if (typeof r.deltaMB !== 'number' || !Number.isFinite(r.deltaMB)) {
    bad('大包还原给出可用的峰值增量', `deltaMB=${JSON.stringify(r.deltaMB)}`)
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
api.restoreBundle({ bundlePath: ${JSON.stringify(bundle2)}, overwriteConfirmed: true }).then((r) => {
  clearInterval(timer)
  console.log('RESULT_JSON:' + JSON.stringify({ ok: r.ok, code: r.ok ? null : r.code, message: r.ok ? null : r.message, deltaMB: +((peak-base)/1048576).toFixed(1) }))
}).catch((e) => { clearInterval(timer); console.log('RESULT_JSON:' + JSON.stringify({ok:false,code:'threw',message:String(e),deltaMB:0})) })
`
  )
  const r2 = runChild(child2)
  const unpacked2MB = home2Bytes / 1024 / 1024
  /*
   * **先看 r2.ok 再报 PASS。**
   *
   * 原来是 `runChild(child2)` 之后直接 `ok('2× 包还原成功', ...)`，从不检查 r2.ok ——
   * 于是「第二个包还原失败」会被记成 PASS，并且拿 `r2.deltaMB`（失败时是 0 或 undefined）
   * 去除以 r.deltaMB，算出 growth=0，进而让下面「峰值不随体积增长」也假绿。
   * 也就是说这一处漏判会让**整条内存判据在最该报警的时候全绿**，正是它掩盖了导出缺陷。
   */
  if (!r2.ok) {
    bad(
      '2× 包还原成功',
      `code=${r2.code ?? '?'} message=${String(r2.message ?? '').slice(0, 400)}`
    )
    fs.rmSync(root, { recursive: true, force: true })
    return done()
  }
  if (typeof r2.deltaMB !== 'number' || !Number.isFinite(r2.deltaMB)) {
    bad('2× 包还原给出可用的峰值增量', `deltaMB=${JSON.stringify(r2.deltaMB)}`)
    fs.rmSync(root, { recursive: true, force: true })
    return done()
  }
  ok(
    '2× 包还原成功',
    `峰值 ${r2.deltaMB}MB / 解压后 ${unpacked2MB.toFixed(1)}MB（体积是前者的 ${(unpacked2MB / unpackedMB).toFixed(2)}×）`
  )

  /*
   * ── 判据：峰值**增量**是否随包体积增长 ──
   *
   * 演化过程（记录在这里，避免后人又改回比值）：
   *
   *  v1「两次峰值比值 < 1.6」：忽红忽绿。除法把噪声放大 —— 分子分母都含一个与包体积
   *    无关的基线（V8 堆 + 三遍遍历的残留），而 160MB 那次的峰值本身在 219~246MB 之间抖，
   *    倒数一除比值就落在 1.40~1.77。阈值 1.6 时它实际在测「这次抖得大不大」。
   *
   *  v2「差值斜率 < 0.6」：数值稳定了（0.80~1.18），但**稳定地报红**。它暴露了真问题：
   *    `streamZip` 原来用 `writes = writes.then(...)` 串行，**每个 `then` 闭包都持有它捕获的
   *    chunk 直到链尾**，整包数据被钉在内存里（600×1MB 实测 external 601.8MB）。
   *    那正是「用了流式、峰值仍线性增长」的根因。
   *
   *  v3（当前）：`bundle-zip.ts` 改成有界队列 + 队列满时暂停读流（真背压）后，
   *    extractTo 的峰值增量不再随体积走（实测 80MB 包 +32.5MB、160MB 包 +29.4MB）。
   *
   * 所以判据看的是**峰值增量本身**，而不是两次的比值：增量是「瞬时缓冲」的量度，
   * 流式时它约为「常数 + 最大单条目」，与包体积无关；整包读进内存时它 ≈ 包体积。
   *
   * 阈值：`peakDelta < 0.8 × 包体积增量`。
   *   · 流式（实测）：约 0.37 × 体积增量（29.4/80）
   *   · 整包读进内存：≥ 1.0 ×（v2 实测 0.80~1.18 就是链钉住整包的表现）
   * 0.8 落在这两个区间之间的空档里，且**只依赖一次测量的增量**，不放大噪声。
   */
  const volumeDelta = unpacked2MB - unpackedMB
  const peakDelta = r2.deltaMB - r.deltaMB
  if (volumeDelta <= 0) {
    bad('内存峰值趋势可计算', `两次包体积没有增长：${unpackedMB}MB → ${unpacked2MB}MB`)
  } else {
    const ratio = peakDelta / volumeDelta
    if (ratio < 0.8) {
      ok(
        '内存峰值不随包体积增长（流式生效）',
        `包 +${volumeDelta.toFixed(1)}MB 时峰值仅 +${peakDelta.toFixed(1)}MB（${ratio.toFixed(2)}×；` +
          `整包读进内存会 ≥ 1.00×；阈值 0.80。基线 ${r.deltaMB}MB → ${r2.deltaMB}MB）`
      )
    } else {
      bad(
        '内存峰值随包体积增长',
        `包 +${volumeDelta.toFixed(1)}MB 时峰值 +${peakDelta.toFixed(1)}MB（${ratio.toFixed(2)}×）` +
          ` —— 说明仍在内存里持有整包（基线 ${r.deltaMB}MB → ${r2.deltaMB}MB）`
      )
    }
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
