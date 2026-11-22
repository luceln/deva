/**
 * 验收者自建：#9 精确验证「统一刷 mtime」是否真的生效。
 *
 * 他们的 E8a 判据是 mtime > oldTime + 1 天 —— 太宽松：`cp` 不保留 mtime 时
 * 拷出来的就是"现在"，本来就远大于 oldTime，即使删掉 utimes 也会通过（我实测过：删掉 utimes 后
 * 他们的 24 条仍全绿）。这里换更严的判据：
 *   - 源文件 mtime 设为很久以前（例如 60 天前，超过 checkpoints 的 30 天清扫线）
 *   - 还原后 mtime 必须接近"现在"，且**不能**接近 60 天前
 * 然后反向注入（删掉 utimes）确认这条判据能抓住。
 *
 * 跑法：node .deva/qa/qa-mine-mtime.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mtime-'))
const stubPath = path.resolve(__dirname, 'stubs', 'electron.cjs')
process.env.HOME = BASE
process.env.USERPROFILE = BASE
process.env.APPDATA = path.join(BASE, 'appdata')

let pass = 0, fail = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' :: ' + e : ''}`) }
const bad = (n, e = '') => { fail++; console.log(`FAIL ${n}${e ? ' :: ' + e : ''}`) }
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e))
const note = (n, e) => console.log(`NOTE ${n} :: ${e}`)

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
  await esbuild.build({ entryPoints: [entry], bundle: true, outfile, platform: 'node', format: 'cjs', alias: { electron: stubPath }, logLevel: 'silent' })
  return outfile
}
function freshRequire(f) {
  for (const k of Object.keys(require.cache)) if (k.includes('code.cjs')) delete require.cache[k]
  return require(f)
}

async function main() {
  const OLD = path.join(BASE, 'old')
  const cpDir = path.join(OLD, 'data', 'checkpoints', 's-1')
  const mediaDir = path.join(OLD, 'data', 'media')
  fs.mkdirSync(cpDir, { recursive: true })
  fs.mkdirSync(mediaDir, { recursive: true })
  fs.mkdirSync(path.join(OLD, 'data', 'chats'), { recursive: true })
  fs.writeFileSync(path.join(OLD, 'config.json'), JSON.stringify({ version: 1 }))
  fs.writeFileSync(path.join(cpDir, 'cp1.json'), JSON.stringify({ id: 'cp1', note: 'OLD checkpoint' }))
  fs.writeFileSync(path.join(mediaDir, 'blob1.bin'), Buffer.from('OLD media bytes'))

  // ★ 把源文件 mtime 设成 60 天前（超过 checkpoints 30 天清扫线）
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(cpDir, 'cp1.json'), sixtyDaysAgo, sixtyDaysAgo)
  fs.utimesSync(path.join(mediaDir, 'blob1.bin'), sixtyDaysAgo, sixtyDaysAgo)
  const srcMtime = fs.statSync(path.join(cpDir, 'cp1.json')).mtimeMs
  note('M0 源 checkpoint mtime', new Date(srcMtime).toISOString() + '（60 天前）')

  const outfile = await loadCode()
  process.env.DEVA_HOME = OLD
  let mod = freshRequire(outfile)
  const pkg = path.join(BASE, 'p.dbk')
  const exp = await mod.exportBundle({ targetPath: pkg })
  check('M1 导出成功（源 mtime 很旧）', exp.ok === true, JSON.stringify(exp).slice(0, 100))

  const NEW = path.join(BASE, 'new')
  fs.mkdirSync(NEW, { recursive: true })
  process.env.DEVA_HOME = NEW
  mod = freshRequire(outfile)
  const r = await mod.restoreBundle({ bundlePath: pkg, overwriteConfirmed: true })
  check('M2 还原成功', r.ok === true, JSON.stringify(r).slice(0, 120))

  const cp = path.join(NEW, 'data', 'checkpoints', 's-1', 'cp1.json')
  const blob = path.join(NEW, 'data', 'media', 'blob1.bin')
  const cpM = fs.statSync(cp).mtimeMs
  const blobM = fs.statSync(blob).mtimeMs
  const now = Date.now()
  const dayMs = 86400000

  note('M3 还原后 checkpoint mtime', new Date(cpM).toISOString())
  note('M4 还原后 media mtime', new Date(blobM).toISOString())

  // 严格判据：距现在不超过 1 分钟（真刷了）；且明显新于 30 天清扫线
  const freshOk = (m) => Math.abs(now - m) < 60 * 1000
  check('M5 checkpoint mtime 被刷成"刚刚"（严判据：距现在 <60s）', freshOk(cpM),
    `实际 ${new Date(cpM).toISOString()}，距现在 ${((now - cpM) / 1000).toFixed(1)}s`)
  check('M6 media mtime 被刷成"刚刚"（严判据）', freshOk(blobM),
    `实际 ${new Date(blobM).toISOString()}，距现在 ${((now - blobM) / 1000).toFixed(1)}s`)

  // 对照：若没刷，mtime 会等于源（60 天前）
  const unchanged = (m) => Math.abs(m - srcMtime) < 5 * 1000
  check('M7 checkpoint mtime 不等于源 mtime（证明确实重写过时间戳）', !unchanged(cpM),
    `源=${new Date(srcMtime).toISOString()} 还原后=${new Date(cpM).toISOString()}`)

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
