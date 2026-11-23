#!/usr/bin/env node
/**
 * 备份包导出 → 立刻用**独立实现**重解一次包，逐条验哈希。
 *
 * ## 这个判据守的是什么缺陷
 *
 * 曾经的真实缺陷（P0，8% 失败率）：
 *
 * fflate 的 `Zip` 写出侧固定写 data descriptor（本地头 csize 写 0、flag bit3 置位、
 * 条目末尾追加 `50 4b 07 08` + crc + csize + usize）。而它的**流式**读侧（`bundle-zip.ts`
 * 用的 `Unzip`）在 `store + data descriptor` 条目上**不按中央目录的 `compressedSize` 定界**，
 * 而是扫描数据里的 `50 4b 07 08` 来找 descriptor（`fflate/esm/browser.js:2511`）。
 *
 * 于是：媒体文件（`.bin` / `.jpg` 等随机二进制）里只要恰好出现那 4 个字节，读侧就提前认定
 * 条目结束，还原出的文件被截断 → 「备份包内容与清单不符」。
 *
 * 症状极具误导性，这是做这个判据的根本原因：
 *  - 用「按中央目录解析」的工具（`unzipSync`）读**完全正常** → 「包自检 712 条全对」；
 *  - 换新进程用同一个包重试**照样崩** → 看起来像产品缺陷而不是测试竞态（这个判断是对的）；
 *  - fflate 读侧 `browser.js:2485-2487` 在 `!ctr` 时报错后**漏了 `return`**，仍执行
 *    `new ctr(...)` → 真实错误被掩盖成 `ctr is not a constructor`，把排查引向无关方向。
 *
 * ## 为什么必须两种读法都跑
 *
 * 只跑一种会漏：
 *  - 只跑 `unzipSync`（按中央目录 csize 解）：旧实现**永远绿** —— 它根本看不见这个缺陷。
 *  - 只跑 `extractTo`（fflate 流式）：能抓到旧实现，但抓不到「中央目录与本地头不一致」
 *    这类结构错误（那种包流式读可能硬崩成别的错误，看不出根因）。
 *
 * 所以两种都跑，并额外检查**结构**（本地头必须带真实 crc/csize、全包不得出现 descriptor）。
 *
 * ## 毒药用例
 *
 * 夹具里**故意**造一批内容中密布 `50 4b 07 08` 的媒体文件。旧实现下这些文件必然被截断，
 * 因此这条用例不是「碰运气」，而是**确定性地**把缺陷暴露出来；修复后的实现再多撞车也不受影响。
 *
 * ## 用法
 *
 *   node .deva/qa/check-export-selfcheck.cjs [次数] [每个毒药文件MB]
 *
 * 默认 30 次（8% 失败率下，30 次全绿的可信度 >90%；如果实现退回去，几乎必然至少红一次）。
 * 退出码 0 = 全绿。
 */
'use strict'
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist', 'selfcheck')

const N = Number(process.argv[2] || 30)
const MB = Number(process.argv[3] || process.env.CHECK_MB || 2)

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass++
  console.log(`  PASS ${n}${d ? ' :: ' + d : ''}`)
}
const bad = (n, d) => {
  fail++
  console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`)
}

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}\n` +
      `export * from ${JSON.stringify(path.join(SRC, 'main/services/bundle-zip.ts'))}\n`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'e.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return path.join(DIST, 'e.cjs')
}

/** 造一个内容里密布 `50 4b 07 08` 的文件 —— 旧实现的读侧必然在这里翻车。 */
function poison(size) {
  const b = crypto.randomBytes(size)
  for (let i = 64; i + 4 <= size; i += 97) b.writeUInt32LE(0x08074b50, i)
  return b
}

function makeHome(home, mb) {
  fs.mkdirSync(path.join(home, 'data/media'), { recursive: true })
  fs.mkdirSync(path.join(home, 'data/chats'), { recursive: true })
  // 毒药媒体：大文件走 store（不压缩），正是历史上出问题的那条路径
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(home, 'data/media', `img-${i}.bin`), poison(mb * 1024 * 1024))
  // 普通随机媒体（不植入毒药）：覆盖「碰巧撞车」的自然概率
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(home, 'data/media', `plain-${i}.bin`), crypto.randomBytes(65536))
  // 文本（走 deflate）
  for (let i = 0; i < 40; i++)
    fs.writeFileSync(path.join(home, 'data/chats', `s-${i}.json`), JSON.stringify({ id: `s-${i}`, pad: 'x'.repeat(20000) }))
  // 空文件（零字节条目历来是独立的一类边界）
  fs.writeFileSync(path.join(home, 'data/chats', 'empty.json'), '')
  fs.writeFileSync(path.join(home, 'config.json'), '{"theme":"dark"}')
}

/**
 * 结构自检：确认包里**不存在 data descriptor**。
 *
 * 这是修复的**机制层**保证 —— 不靠「跑起来没崩」，而是直接断言「那种结构不许再出现」。
 * 只看 zh 不够：本地头 csize 写 0 + flag bit3 才是 descriptor 的判定条件，两者都要查。
 */
function inspectStructure(bundle) {
  const size = fs.statSync(bundle).size
  const fd = fs.openSync(bundle, 'r')
  const rd = (len, off) => {
    const b = Buffer.alloc(len)
    fs.readSync(fd, b, 0, len, off)
    return b
  }
  const tailLen = Math.min(22 + 0xffff, size)
  const tail = rd(tailLen, size - tailLen)
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    fs.closeSync(fd)
    return { ok: false, why: '没有 EOCD' }
  }
  const count = tail.readUInt16LE(eocd + 10)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOff = tail.readUInt32LE(eocd + 16)
  if (cdOff + cdSize > size) {
    fs.closeSync(fd)
    return { ok: false, why: '中央目录越界' }
  }
  const cd = rd(cdSize, cdOff)
  let q = 0
  let flag3 = 0
  let zeroCsize = 0
  let parsed = 0
  const offenders = []
  for (let i = 0; i < count && q + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(q) !== 0x02014b50) break
    const csize = cd.readUInt32LE(q + 20)
    const nameLen = cd.readUInt16LE(q + 28)
    const extraLen = cd.readUInt16LE(q + 30)
    const cmtLen = cd.readUInt16LE(q + 32)
    const lho = cd.readUInt32LE(q + 42)
    const name = cd.toString('utf8', q + 46, q + 46 + nameLen)
    q += 46 + nameLen + extraLen + cmtLen
    parsed++
    const lh = rd(30, lho)
    if (lh.readUInt16LE(6) & 8) {
      flag3++
      if (offenders.length < 3) offenders.push({ name, why: 'local header has bit3 (data descriptor)' })
    }
    if (csize > 0 && lh.readUInt32LE(18) === 0) {
      zeroCsize++
      if (offenders.length < 3) offenders.push({ name, why: 'local csize 0 while central says ' + csize })
    }
  }
  fs.closeSync(fd)
  return { ok: flag3 === 0 && zeroCsize === 0, count, parsed, flag3, zeroCsize, offenders }
}

async function main() {
  console.log('== 备份包导出自检（独立实现重解 + 结构断言）==')
  const modPath = await build()
  const fflate = require(path.join(REPO, 'node_modules/fflate'))

  /*
   * ── 0. 落盘保证的静态断言 ──
   *
   * `fsync` 防的是「断电 / 进程被杀之后 `rename` 出来的包内容不完整」。**进程内跑不出来**：
   * 正常退出时 OS 本来就会刷页，所以「去掉 fsync 再跑判据」仍然全绿 —— 这不是判据失灵，
   * 而是这类缺陷的观测窗口在进程之外。
   *
   * 因此用静态断言守住「`rename` 之前必须 sync」这件事：
   * `bundle-export.ts` 里 `.part → rename` 的协议要求 `writeZip` 返回时数据已落设备，
   * 而 `writeZip` 的唯一落盘点是 `ZipWriter.end()`，所以要求那里出现 `fh.sync()`。
   *
   * 这条不能替代运行时判据（改坏 sync 之外的东西它发现不了），但它是唯一能守住这一段的办法。
   */
  {
    const writerSrc = fs.readFileSync(path.join(SRC, 'main/services/bundle-zip-writer.ts'), 'utf8')
    const endIdx = writerSrc.indexOf('async end()')
    const body = endIdx >= 0 ? writerSrc.slice(endIdx, writerSrc.indexOf('async abort()', endIdx)) : ''
    const hasSync = /this\.fh\.sync\s*\(\s*\)/.test(body)
    if (hasSync) ok('S0 end() 在关闭前 fsync（静态断言，运行时测不出来）', '找到 this.fh.sync()')
    else bad('S0 end() 在关闭前 fsync（静态断言，运行时测不出来）', '没找到 this.fh.sync()，rename 可能早于落盘')
    const exportSrc = fs.readFileSync(path.join(SRC, 'main/services/bundle-export.ts'), 'utf8')
    const usesWriter = /ZipWriter\.create\s*\(/.test(exportSrc) && !/\bnew Zip\s*\(/.test(exportSrc)
    if (usesWriter) ok('S0b 导出走 ZipWriter，不再用 fflate 的 Zip（它固定写 descriptor）', 'ZipWriter.create 且无 new Zip')
    else bad('S0b 导出走 ZipWriter，不再用 fflate 的 Zip（它固定写 descriptor）', '仍在用 fflate Zip')
  }

  const root = path.join(os.tmpdir(), `deva-exp-selfcheck-${Date.now()}`)
  const home = path.join(root, 'home')
  makeHome(home, MB)
  console.log(`INFO 夹具 :: ${home}（毒药文件 12 × ${MB}MB，密布 504b0708）`)
  console.log(`INFO 次数 :: ${N}`)

  /* ── 1. 结构性断言（跑一次就够，与次数无关）── */
  {
    const script = path.join(root, 'once.cjs')
    const bundle = path.join(root, 'once.dbk')
    fs.writeFileSync(
      script,
      `process.env.DEVA_HOME = ${JSON.stringify(home)}
const api = require(${JSON.stringify(modPath)})
api.exportBundle({ targetPath: ${JSON.stringify(bundle)} }).then(r => process.stdout.write('J:' + JSON.stringify(r)))
`
    )
    const res = cp.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const line = (res.stdout || '').match(/J:(.+)/)
    if (!line) {
      bad('S1 单次导出有输出', (res.stderr || '').slice(-400))
    } else {
      const exp = JSON.parse(line[1])
      if (!exp.ok) bad('S1 单次导出成功', `${exp.code} ${exp.message}`)
      else {
        ok('S1 单次导出成功', `${(fs.statSync(exp.path).size / 1048576).toFixed(1)}MB`)
        const st = inspectStructure(exp.path)
        /*
         * 必须用「条件 → PASS/FAIL」的断言，不能写成 `ok(label, 详情)`。
         * 后者不管条件真假都记 PASS —— 这正是 `verify-bundle-memory.cjs` 里
         * 「runChild 后直接 ok() 不看返回值」那个把失败报成通过的毛病，
         * 本判据自己绝不能重犯，否则它守缺陷时会先自己假绿。
         */
        const detail = `条目 ${st.parsed}/${st.count}，bit3=${st.flag3}，csize0=${st.zeroCsize}${
          st.offenders && st.offenders.length ? ' 例：' + JSON.stringify(st.offenders[0]) : ''
        }`
        if (st.ok) ok('S2 包结构里没有 data descriptor（bit3 与本地 csize=0 均为 0）', detail)
        else bad('S2 包结构里没有 data descriptor（bit3 与本地 csize=0 均为 0）', detail)
      }
    }
    try {
      fs.rmSync(bundle, { force: true })
    } catch {}
    fs.rmSync(script, { force: true })
  }

  /*
   * ── 2. 反复导出 + 两种独立读法 ──
   *
   *   读法 A：`unzipSync`（按中央目录 csize 解，独立于 fflate 流式那条路）
   *   读法 B：还原侧真实的 `extractTo`（fflate 流式，历史上崩在这里）
   *
   * 少跑任何一种都会漏（见文件头说明）。
   */
  const M = require(modPath)
  let badRounds = 0
  let minEntries = Infinity
  for (let k = 1; k <= N; k++) {
    const bundle = path.join(root, `o-${k}.dbk`)
    const script = path.join(root, `e-${k}.cjs`)
    fs.writeFileSync(
      script,
      `process.env.DEVA_HOME = ${JSON.stringify(home)}
const api = require(${JSON.stringify(modPath)})
api.exportBundle({ targetPath: ${JSON.stringify(bundle)} }).then(r => process.stdout.write('J:' + JSON.stringify(r)))
`
    )
    const res = cp.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const line = (res.stdout || '').match(/J:(.+)/)
    if (!line) {
      badRounds++
      bad(`R${k} 导出有输出`, (res.stderr || '').slice(-300))
      continue
    }
    const exp = JSON.parse(line[1])
    if (!exp.ok) {
      badRounds++
      bad(`R${k} 导出成功`, `${exp.code} ${exp.message}`)
      continue
    }
    const bundlePath = exp.path || bundle

    /* 读法 A：unzipSync */
    const manifest = (() => {
      try {
        const ents = fflate.unzipSync(new Uint8Array(fs.readFileSync(bundlePath)))
        return JSON.parse(Buffer.from(ents['manifest.json']).toString('utf8'))
      } catch (e) {
        bad(`R${k} unzipSync 解包`, String((e && e.message) || e))
        return null
      }
    })()
    if (!manifest) {
      badRounds++
      continue
    }
    const mismA = []
    for (const f of manifest.files) {
      const buf = fflate.unzipSync(new Uint8Array(fs.readFileSync(bundlePath)))[`home/${f.path}`]
      if (!buf) {
        mismA.push({ path: f.path, why: 'entry missing' })
        continue
      }
      const got = crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex')
      if (got !== f.sha256) mismA.push({ path: f.path, declared: f.sha256.slice(0, 10), got: got.slice(0, 10) })
    }
    if (mismA.length) {
      badRounds++
      bad(`R${k} 读法A unzipSync 全对`, `${mismA.length} 条不符 ${JSON.stringify(mismA[0])}`)
    }
    /* 本轮到目前为止是否干净：任何一处报错都要让「全对」这条不成立 */
    let cleanRound = mismA.length === 0

    /* 读法 B：还原侧真实的 extractTo */
    const stage = path.join(root, `stage-${k}`)
    const want = new Set(manifest.files.map((f) => `home/${f.path}`))
    let mismB = 0
    let firstBad = null
    try {
      const r = await M.extractTo(bundlePath, stage, want)
      if (r.written !== want.size) {
        badRounds++
        cleanRound = false
        bad(`R${k} 读法B extractTo 条目数`, `写出 ${r.written} / 期望 ${want.size}`)
      }
      for (const f of manifest.files) {
        const abs = path.join(stage, 'home', f.path)
        if (!fs.existsSync(abs)) {
          mismB++
          if (!firstBad) firstBad = { path: f.path, why: 'missing' }
          continue
        }
        const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
        if (got !== f.sha256) {
          mismB++
          if (!firstBad)
            firstBad = {
              path: f.path,
              declared: f.sha256.slice(0, 10),
              got: got.slice(0, 10),
              sizeGot: fs.statSync(abs).size,
              sizeWant: f.size
            }
        }
      }
    } catch (e) {
      badRounds++
      cleanRound = false
      bad(`R${k} 读法B extractTo 不崩`, String((e && e.message) || e))
    }
    if (mismB) {
      badRounds++
      cleanRound = false
      bad(`R${k} 读法B extractTo 哈希全对`, `${mismB} 条不符 ${JSON.stringify(firstBad)}`)
    }
    /*
     * 只有整轮毫无问题时才记「全对」。用 `cleanRound` 而不是只看 mismA/mismB：
     * 「条目数不对」和「抛错」这两类不进 mism 计数，只靠它们判会漏，同一轮可能既 FAIL 又 PASS。
     */
    if (cleanRound) {
      ok(`R${k} 两种读法全对`, `${manifest.files.length} 条`)
      minEntries = Math.min(minEntries, manifest.files.length)
    }
    try {
      fs.rmSync(stage, { recursive: true, force: true })
    } catch {}
    try {
      fs.rmSync(bundlePath, { force: true })
    } catch {}
    fs.rmSync(script, { force: true })
  }

  console.log(`\n== 总结 ==`)
  console.log(`  次数 ${N}，出错轮次 ${badRounds}，每轮最少条目数 ${minEntries === Infinity ? 'n/a' : minEntries}`)
  if (badRounds === 0 && fail === 0) ok(`连续 ${N} 次导出均自洽且可被两种实现完整读出`)
  fs.rmSync(root, { recursive: true, force: true })
  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(1)
})