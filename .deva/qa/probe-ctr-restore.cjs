/**
 * 抓「restore 报 ctr is not a constructor」与「还原后文件缺失」。
 *
 * ⚠️ 踩过的坑（写在这里避免重犯）：
 *   `getDevaHome()` 有**模块级缓存**（config.ts:28-39），一个进程里只能算一次。
 *   导出与还原本探针必须在**两个独立子进程**里跑，各自设 DEVA_HOME，
 *   否则第二次设的 DEVA_HOME 不生效 —— 还原会落到第一个 home 上，
 *   于是出现「ok=true 但 dst 里一个文件都没有」这种假象（那是探针的错，不是产品的）。
 *
 * 结构：
 *   P1: DEVA_HOME=<src>  导出 → 得到包
 *   P2: DEVA_HOME=<dst>  还原该包（overwriteConfirmed: true）→ 统计 dst 内实际文件数
 * 失败时：保留包，并用 P2 再跑一次（同包）判断是包坏了还是环境问题。
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
const DIST = path.join(QA, 'dist-ctr2')
const KEEP = path.join(os.tmpdir(), 'deva-ctr-kept')

const N = Number(process.argv[2] || 8)
const root = path.join(os.tmpdir(), `deva-ctr3-${Date.now()}`)
const srcHome = path.join(root, 'src-home')

function makeHome(dir) {
  fs.mkdirSync(path.join(dir, 'data/media'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'data/checkpoints/s-1'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'data/chats'), { recursive: true })
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, 'data/media', `img-${i}.bin`), crypto.randomBytes(2 * 1024 * 1024))
  for (let i = 0; i < 600; i++)
    fs.writeFileSync(path.join(dir, 'data/checkpoints/s-1', `cp-${i}.json`), JSON.stringify({ i, pad: 'x'.repeat(20000) }))
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, 'data/chats', `s-${i}.json`), JSON.stringify({ id: `s-${i}` }))
  fs.writeFileSync(path.join(dir, 'config.json'), '{"theme":"dark"}')
  fs.writeFileSync(path.join(dir, 'memory.json'), '{"version":2}')
}

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
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
    outfile: path.join(DIST, 'x.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return path.join(DIST, 'x.cjs')
}

/** 独立子进程执行一段逻辑，DEVA_HOME 在 require 之前设好。 */
function runWorker(modPath, devaHome, body) {
  const script = path.join(root, `w-${crypto.randomBytes(4).toString('hex')}.cjs`)
  fs.writeFileSync(
    script,
    `
process.env.DEVA_HOME = ${JSON.stringify(devaHome)}
const api = require(${JSON.stringify(modPath)})
const fs = require('fs'), path = require('path')
const out = (o) => process.stdout.write('J:' + JSON.stringify(o) + '\\n')
const count = (d) => { if(!fs.existsSync(d)) return { files:0, bytes:0 }; let files=0, bytes=0;
  const walk=(x)=>{ for(const e of fs.readdirSync(x,{withFileTypes:true})){ const p=path.join(x,e.name);
    if(e.isDirectory()) walk(p); else { files++; bytes+=fs.statSync(p).size } } };
  walk(d); return { files, bytes } }
;(async () => { ${body} })().catch(e => out({ step:'throw', err: String(e && e.stack || e) }))
`
  )
  const res = cp.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const parsed = (res.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('J:'))
    .map((l) => JSON.parse(l.slice(2)))
  fs.rmSync(script, { force: true })
  return { parsed, stderr: (res.stderr || '').slice(-600), status: res.status }
}

const doExport = (modPath, devaHome, target) =>
  runWorker(
    modPath,
    devaHome,
    `const r = await api.exportBundle({ targetPath: ${JSON.stringify(target)} })
     out({ step:'export', ok:r.ok, files:r.files, bytes:r.bytes, code:r.code, msg:r.message, path:r.path })`
  )

const doRestore = (modPath, devaHome, bundle, mediaDir, cpDir) =>
  runWorker(
    modPath,
    devaHome,
    `const r = await api.restoreBundle({ bundlePath: ${JSON.stringify(bundle)}, overwriteConfirmed: true })
     out({ step:'restore', ok:r.ok, code:r.code, msg:r.message, secrets:r.secrets,
           media: count(${JSON.stringify(mediaDir)}), cps: count(${JSON.stringify(cpDir)}),
           srcFiles: r.files, removed: Array.isArray(r.removedStale) ? r.removedStale.length : null })`
  )

;(async () => {
  fs.mkdirSync(root, { recursive: true })
  makeHome(srcHome)
  const modPath = await build()
  fs.mkdirSync(KEEP, { recursive: true })

  const tally = {}
  const EXPECT_MEDIA = 40
  const EXPECT_CP = 600

  for (let i = 1; i <= N; i++) {
    const bundle = path.join(root, `b-${i}.dbk`)
    const dst = path.join(root, `dst-${i}`)
    fs.mkdirSync(dst, { recursive: true })

    const e = doExport(modPath, srcHome, bundle)
    const exp = e.parsed.find((x) => x.step === 'export') || { ok: false, _e: e }
    if (!exp.ok) {
      console.log(`  [${i}] 导出失败 :: ${exp.code} ${String(exp.msg).slice(0, 120)}`)
      tally['EXPORT_FAIL'] = (tally['EXPORT_FAIL'] || 0) + 1
      continue
    }

    const r = doRestore(modPath, dst, exp.path || bundle, path.join(dst, 'data/media'), path.join(dst, 'data/checkpoints'))
    const res = r.parsed.find((x) => x.step === 'restore') || { ok: false, _e: r }
    const thrown = r.parsed.find((x) => x.step === 'throw')

    if (!res.ok) {
      const key = `FAIL:${res.code || 'throw'}`
      tally[key] = (tally[key] || 0) + 1
      const kept = path.join(KEEP, `fail-${Date.now()}-${i}.dbk`)
      try {
        fs.copyFileSync(exp.path || bundle, kept)
      } catch {}
      console.log(`  [${i}] 还原失败 :: ${res.code} ${String(res.msg || res.err || thrown?.err || '').slice(0, 200)}`)
      if (thrown) console.log(`      throw: ${String(thrown.err).slice(0, 300)}`)
      console.log(`      包已保留：${kept}`)
      // 同包再还原一次（不同空目录）—— 判断包坏还是环境
      const retryDst = path.join(root, `retry-${i}`)
      fs.mkdirSync(retryDst, { recursive: true })
      const rr = doRestore(modPath, retryDst, kept, path.join(retryDst, 'data/media'), path.join(retryDst, 'data/checkpoints'))
      const rres = rr.parsed.find((x) => x.step === 'restore') || {}
      console.log(
        `      同包重试：ok=${rres.ok} code=${rres.code} media=${rres.media?.files} cps=${rres.cps?.files}`
      )
    } else {
      const mediaOk = res.media?.files === EXPECT_MEDIA
      const cpOk = res.cps?.files === EXPECT_CP
      const key = mediaOk && cpOk ? 'OK' : 'OK_BUT_MISSING'
      tally[key] = (tally[key] || 0) + 1
      console.log(
        `  [${i}] ${mediaOk && cpOk ? 'PASS' : '!! ok=true 但文件不全'} :: media=${res.media?.files}/${EXPECT_MEDIA} cps=${res.cps?.files}/${EXPECT_CP}`
      )
    }
    fs.rmSync(dst, { recursive: true, force: true })
    fs.rmSync(path.join(root, `retry-${i}`), { recursive: true, force: true })
    try {
      fs.rmSync(exp.path || bundle, { force: true })
    } catch {}
  }

  console.log(`\n==TALLY== ${JSON.stringify(tally)}（共 ${N} 次）`)
  console.log(`保留的失败包：${KEEP}`)
  const bad = N - (tally.OK || 0)
  process.exit(bad === 0 ? 0 : 1)
})().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
