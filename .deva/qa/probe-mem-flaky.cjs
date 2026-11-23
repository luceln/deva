/**
 * 定位 verify-bundle-memory.cjs 偶发失败的探针（只读，不改被测源码）。
 *
 * 目的：把「媒体文件还原不完整 / checkpoint 缺失」背后的真实原因 dump 出来。
 * 原脚本只打印 PASS/FAIL，不打印第二次还原的返回值、失败码、以及 staging/home 的实际内容，
 * 所以看不出到底是产品少写了、还是脚本读早了。
 *
 * 关键改造：
 *  1. 复刻原脚本夹具（40×2MB media + 600×20KB checkpoint + 30 会话），再扩大到 2×
 *  2. 第二次还原**打印完整返回值**（ok / code / message），不再无条件 PASS
 *  3. 还原后立刻统计 home 里 media / checkpoint 的实际文件数与字节数，和清单期望对比
 *  4. 若失败，把 staging 残留目录、自动备份目录一并列出
 *  5. 支持并发压力：环境变量 PROBE_IO_STRESS=1 时同时起 N 个写盘进程制造 IO 压力
 *
 * 用法：
 *   node .deva/qa/probe-mem-flaky.cjs              # 单次
 *   node .deva/qa/probe-mem-flaky.cjs 10           # 连跑 10 次，统计失败率
 *   PROBE_IO_STRESS=1 node .deva/qa/probe-mem-flaky.cjs 10
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-memflaky')

/** 单次运行：造夹具 → 导出 → 还原 → 再导出 → 再还原 → 逐项核对。 */
async function oneRun(tag) {
  const root = path.join(os.tmpdir(), `deva-memflaky-${tag}-${Date.now()}`)
  const home = path.join(root, 'home')
  const lines = []
  const log = (s) => {
    lines.push(s)
    console.log(s)
  }

  const mediaDir = path.join(home, 'data/media')
  const cpDir = path.join(home, 'data/checkpoints/s-1')
  const chatsDir = path.join(home, 'data/chats')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.mkdirSync(cpDir, { recursive: true })
  fs.mkdirSync(chatsDir, { recursive: true })

  // 与 verify-bundle-memory.cjs 同形态：40×2MB 不可压缩 + 600×20KB
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(mediaDir, `img-${i}.bin`), crypto.randomBytes(2 * 1024 * 1024))
  }
  for (let i = 0; i < 600; i++) {
    fs.writeFileSync(path.join(cpDir, `cp-${i}.json`), JSON.stringify({ i, pad: 'x'.repeat(20000) }))
  }
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(
      path.join(chatsDir, `s-${i}.json`),
      JSON.stringify({
        id: `s-${i}`,
        messages: Array.from({ length: 50 }, (_, k) => ({ role: 'user', content: `m${k}` }))
      })
    )
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ theme: 'dark' }))
  fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({ version: 2, entries: [] }))

  /*
   * 每次运行独立编译：避免 dist 目录被并发运行的两个进程同时写坏
   * （原脚本所有运行共用 .deva/qa/dist/memverify.cjs，并发时那就是一个共享可写文件）。
   */
  const dist = path.join(DIST, `run-${tag}-${process.pid}`)
  fs.mkdirSync(dist, { recursive: true })
  const entry = path.join(dist, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
`
  )
  await new Promise((resolve, reject) => {
    const r = cp.spawnSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(path.join(REPO, 'node_modules/esbuild'))}).build(${JSON.stringify({
          entryPoints: [entry],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node20',
          outfile: path.join(dist, 'm.cjs'),
          alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
          logLevel: 'error'
        })}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`
      ],
      { stdio: 'inherit' }
    )
    r.status === 0 ? resolve() : reject(new Error('build failed'))
  })

  const script = path.join(dist, 'worker.cjs')
  fs.writeFileSync(
    script,
    `
process.env.DEVA_HOME = ${JSON.stringify(home)}
const api = require(${JSON.stringify(path.join(dist, 'm.cjs'))})
const fs = require('fs')
const path = require('path')
const out = (o) => { process.stdout.write('J:' + JSON.stringify(o) + '\\n') }
const countDir = (d) => {
  if (!fs.existsSync(d)) return { files: 0, bytes: 0 }
  let files = 0, bytes = 0
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { const s = countDir(p); files += s.files; bytes += s.bytes }
    else { files += 1; bytes += fs.statSync(p).size }
  }
  return { files, bytes }
}
;(async () => {
  // 第一次导出
  const exp = await api.exportBundle({ targetPath: ${JSON.stringify(path.join(root, 'a.dbk'))} })
  out({ step: 'export1', ok: exp.ok, files: exp.files, bytes: exp.bytes, code: exp.code, msg: exp.message })

  fs.rmSync(${JSON.stringify(home)}, { recursive: true, force: true })
  fs.mkdirSync(${JSON.stringify(home)}, { recursive: true })

  // 第一次还原
  const r1 = await api.restoreBundle({ bundlePath: ${JSON.stringify(path.join(root, 'a.dbk'))} })
  out({ step: 'restore1', ok: r1.ok, code: r1.code, msg: r1.message,
        media: countDir(${JSON.stringify(mediaDir)}), cps: countDir(${JSON.stringify(cpDir)}) })

  /*
   * 追加 40 个 media 造 2× 包（与 verify-bundle-memory.cjs:172-175 一致）。
   * 这里额外把「写之前 home 里到底是什么」记下来 —— 用来区分
   * 「我文件没写进去」和「导出/扫描漏了」。
   */
  for (let i = 40; i < 80; i++) {
    fs.mkdirSync(${JSON.stringify(mediaDir)}, { recursive: true })
    fs.writeFileSync(path.join(${JSON.stringify(mediaDir)}, 'img-' + i + '.bin'), require('crypto').randomBytes(2*1024*1024))
  }
  out({ step: 'beforeExport2', media: countDir(${JSON.stringify(mediaDir)}), cps: countDir(${JSON.stringify(cpDir)}) })
  const exp2 = await api.exportBundle({ targetPath: ${JSON.stringify(path.join(root, 'b.dbk'))} })
  out({ step: 'export2', ok: exp2.ok, files: exp2.files, bytes: exp2.bytes, code: exp2.code, msg: exp2.message,
        path: exp2.path, excluded: exp2.excluded })

  fs.rmSync(${JSON.stringify(home)}, { recursive: true, force: true })
  fs.mkdirSync(${JSON.stringify(home)}, { recursive: true })

  // 第二次还原 —— 这一步之后原脚本就断言，所以重点看它
  const r2 = await api.restoreBundle({ bundlePath: ${JSON.stringify(path.join(root, 'b.dbk'))} })
  const media = countDir(${JSON.stringify(mediaDir)})
  const cps = countDir(${JSON.stringify(cpDir)})
  const img0 = path.join(${JSON.stringify(mediaDir)}, 'img-0.bin')
  const cp599 = ${JSON.stringify(path.join(cpDir, 'cp-599.json'))}
  out({ step: 'restore2', ok: r2.ok, code: r2.code, msg: r2.message, media, cps,
        img0Exists: fs.existsSync(img0), img0Size: fs.existsSync(img0) ? fs.statSync(img0).size : -1,
        cp599Exists: fs.existsSync(cp599), cp599Size: fs.existsSync(cp599) ? fs.statSync(cp599).size : -1,
        homeTop: fs.readdirSync(${JSON.stringify(home)}) })
  // 落盘后再等一会儿重新统计一次，区分"读早了"与"真少写"
  await new Promise((r) => setTimeout(r, 1500))
  out({ step: 'recheck', media: countDir(${JSON.stringify(mediaDir)}), cps: countDir(${JSON.stringify(cpDir)}),
        img0Size: fs.existsSync(img0) ? fs.statSync(img0).size : -1,
        cp599Exists: fs.existsSync(cp599) })
})().catch((e) => out({ step: 'throw', err: String(e) }))
`
  )

  const ioStress = []
  if (process.env.PROBE_IO_STRESS === '1') {
    // 在同一个父目录里起几个写盘进程，制造磁盘压力
    for (let k = 0; k < 3; k++) {
      const p = cp.spawn(
        process.execPath,
        [
          '-e',
          `const fs=require('fs'),crypto=require('crypto'),path=require('path');
           const d=${JSON.stringify(path.join(root, 'stress'))};
           fs.mkdirSync(d,{recursive:true});
           const end=Date.now()+60000;
           while(Date.now()<end){fs.writeFileSync(path.join(d,'w'+Math.random()),crypto.randomBytes(1024*1024))}`
        ],
        { stdio: 'ignore' }
      )
      ioStress.push(p)
    }
  }

  const res = cp.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  for (const p of ioStress) p.kill()
  const parsed = []
  for (const line of (res.stdout || '').split('\n')) {
    if (line.startsWith('J:')) parsed.push(JSON.parse(line.slice(2)))
  }
  const get = (s) => parsed.find((x) => x.step === s) || { missing: true }
  const r2 = get('restore2')
  const re = get('recheck')

  /*
   * 定性判据：
   *   A 产品缺陷：r2.ok=true 但 home 里的 media/checkpoint 数量或字节不足，且等待后依然不足
   *   B 读早了：等待后数量补齐（说明是断言时机问题）
   *   C 还原本身报失败：看 code/msg
   */
  let verdict = 'PASS'
  let detail = ''
  const expectMedia = 80
  const expectCps = 600
  if (r2.ok !== true) {
    verdict = 'RESTORE_FAILED'
    detail = `ok=${r2.ok} code=${r2.code} msg=${String(r2.msg).slice(0, 200)}`
  } else if (r2.media?.files !== expectMedia || r2.cps?.files !== expectCps) {
    if (re.media?.files === expectMedia && re.cps?.files === expectCps) {
      verdict = 'LATE_READ'
      detail = `立刻统计 media=${r2.media?.files}/${expectMedia} cps=${r2.cps?.files}/${expectCps}，1.5s 后补齐`
    } else {
      verdict = 'MISSING_FILES'
      detail = `media=${r2.media?.files}/${expectMedia} cps=${r2.cps?.files}/${expectCps}（等待后仍 media=${re.media?.files} cps=${re.cps?.files}）`
    }
  }
  if (verdict !== 'PASS') {
    log(`  [${tag}] ${verdict} :: ${detail}`)
    log(`  [${tag}] img0Size=${r2.img0Size} cp599Exists=${r2.cp599Exists} 期望img0=2097152`)
    log(`  [${tag}] export2=${JSON.stringify(get('export2'))}`)
    log(`  [${tag}] beforeExport2=${JSON.stringify(get('beforeExport2'))}`)
    log(`  [${tag}] restore1=${JSON.stringify(get('restore1'))}`)
    // 列出 staging / 备份残留
    for (const d of fs.readdirSync(root)) {
      if (d.includes('restore-') || d.includes('backup')) log(`  [${tag}] 残留目录: ${d}`)
    }
  } else {
    log(`  [${tag}] PASS :: media=${r2.media?.files} cps=${r2.cps?.files} img0=${r2.img0Size} cp599=${r2.cp599Size}`)
  }
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dist, { recursive: true, force: true })
  return verdict
}

;(async () => {
  const n = Number(process.argv[2] || 1)
  const tally = {}
  for (let i = 1; i <= n; i++) {
    const v = await oneRun(String(i))
    tally[v] = (tally[v] || 0) + 1
  }
  console.log(`\n==TALLY== ${JSON.stringify(tally)}（共 ${n} 次，IO压力=${process.env.PROBE_IO_STRESS === '1'}）`)
  const failed = n - (tally.PASS || 0)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
