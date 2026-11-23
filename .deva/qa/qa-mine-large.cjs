/**
 * 验收者自建：#4 验证大包（接近真实 600MB）下的行为。
 * 关心两件事：
 *  1. 导出是否真的流式（内存不爆）
 *  2. 还原用 unzipSync 全读进内存 —— 峰值内存多少、600MB 包会不会失败
 *
 * 跑法：node .deva/qa/qa-mine-large.cjs [MB]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const MB = Number(process.argv[2] || 200)
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-large-'))
const HOME = path.join(BASE, 'home')
const stubPath = path.resolve(__dirname, 'stubs', 'electron.cjs')
process.env.DEVA_HOME = HOME
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.APPDATA = path.join(BASE, 'appdata')

let pass = 0
let fail = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' :: ' + e : ''}`) }
const bad = (n, e = '') => { fail++; console.log(`FAIL ${n}${e ? ' :: ' + e : ''}`) }
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e))
const peak = () => process.memoryUsage().rss / 1024 / 1024

async function loadCode() {
  const esbuild = require('esbuild')
  const src = path.resolve(__dirname, '..', '..', 'apps', 'desktop', 'src').replace(/\\/g, '/')
  const entry = path.join(BASE, 'entry.ts')
  fs.writeFileSync(entry, `
import { exportBundle } from '${src}/main/services/bundle-export'
import { restoreBundle } from '${src}/main/services/bundle-import'
export { exportBundle, restoreBundle }
`)
  const outfile = path.join(BASE, 'code.cjs')
  await esbuild.build({
    entryPoints: [entry], bundle: true, outfile, platform: 'node', format: 'cjs',
    alias: { electron: stubPath }, logLevel: 'silent'
  })
  return outfile
}
function freshRequire(outfile) {
  for (const k of Object.keys(require.cache)) if (k.includes('code.cjs')) delete require.cache[k]
  return require(outfile)
}

async function main() {
  // 造一个媒体目录：MB 大小的不可压缩二进制（模拟 jpeg/mp4）
  const mediaDir = path.join(HOME, 'data', 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.mkdirSync(path.join(HOME, 'data', 'chats'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ version: 1, theme: 'dark' }))
  fs.writeFileSync(path.join(HOME, 'data', 'chats', 's1.json'), JSON.stringify({ id: 's1' }))

  const chunk = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < MB; i++) {
    require('crypto').randomFillSync(chunk)
    fs.writeFileSync(path.join(mediaDir, `blob-${i}.bin`), chunk)
  }
  const totalMB = MB
  console.log(`\n造了 ${totalMB} MB 媒体文件（不可压缩），开始测\n`)

  const outfile = await loadCode()
  let mod = freshRequire(outfile)

  const baseRss = peak()
  console.log(`基线 RSS: ${baseRss.toFixed(0)} MB`)

  // 导出
  const pkg = path.join(BASE, 'large.dbk')
  let maxRss = baseRss
  const timer = setInterval(() => { maxRss = Math.max(maxRss, peak()) }, 50)
  const t0 = Date.now()
  const exp = await mod.exportBundle({ targetPath: pkg })
  clearInterval(timer)
  const dt = Date.now() - t0
  check('G1 大包导出成功', exp.ok === true, exp.ok ? `${exp.files} 文件, ${(exp.bytes / 1024 / 1024).toFixed(1)} MB, 用时 ${dt}ms` : JSON.stringify(exp).slice(0, 150))
  console.log(`NOTE 导出期间峰值 RSS: ${maxRss.toFixed(0)} MB（增量 ${(maxRss - baseRss).toFixed(0)} MB，源数据 ${totalMB} MB）`)
  check('G2 导出不是把全部内容读进内存（峰值增量应远小于源大小）',
    maxRss - baseRss < totalMB * 0.8,
    `增量 ${(maxRss - baseRss).toFixed(0)} MB vs 源 ${totalMB} MB`)

  // 还原
  const HOM2 = path.join(BASE, 'home2')
  fs.mkdirSync(HOM2, { recursive: true })
  process.env.DEVA_HOME = HOM2
  mod = freshRequire(outfile)
  maxRss = peak()
  const timer2 = setInterval(() => { maxRss = Math.max(maxRss, peak()) }, 50)
  const t1 = Date.now()
  let r
  let restoreErr = null
  try {
    r = await mod.restoreBundle({ bundlePath: pkg })
  } catch (e) {
    restoreErr = e
  }
  clearInterval(timer2)
  const dt2 = Date.now() - t1
  if (restoreErr) {
    bad('G3 大包还原抛异常', String(restoreErr && restoreErr.message).slice(0, 200))
  } else {
    check('G3 大包还原成功', r.ok === true, r.ok ? `${r.files} 文件, 用时 ${dt2}ms` : JSON.stringify(r).slice(0, 200))
  }
  console.log(`NOTE 还原期间峰值 RSS: ${maxRss.toFixed(0)} MB（源数据 ${totalMB} MB）`)
  const ratio = totalMB ? (maxRss / totalMB) : 0
  console.log(`NOTE 峰值 RSS / 源大小 = ${ratio.toFixed(2)}×（unzipSync 全读进内存会接近或超过 1×）`)

  // 校验还原内容
  if (!restoreErr && r && r.ok) {
    const f0 = path.join(HOM2, 'data', 'media', 'blob-0.bin')
    const fLast = path.join(HOM2, 'data', 'media', `blob-${MB - 1}.bin`)
    check('G4 还原后媒体文件在', fs.existsSync(f0) && fs.existsSync(fLast))
    if (fs.existsSync(f0)) {
      check('G5 还原后媒体内容一致', Buffer.compare(fs.readFileSync(f0), fs.readFileSync(path.join(mediaDir, 'blob-0.bin'))) === 0)
    }
  }

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
