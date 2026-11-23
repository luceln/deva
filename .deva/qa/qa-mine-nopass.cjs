/**
 * 验收者自建夹具：验证 / verify-bundle-real.cjs 没覆盖的几条用户可感知行为。
 *
 * 只读产品代码、不改；用 os.tmpdir() 造 home，DEVA_HOME 指向那里。
 * 用 .deva/qa/stubs/electron.cjs 顶替 safeStorage（与候选脚本同口径，DPAPI 真实行为测不到）。
 *
 * 跑法：node .deva/qa/qa-mine-no-pass.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

// ── 1. 造 home ──
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-nopass-'))
const HOME = path.join(BASE, 'home')
process.env.DEVA_HOME = HOME
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.APPDATA = path.join(BASE, 'appdata')

// ── 2. 顶替 electron ──
const stubPath = path.resolve(__dirname, 'stubs', 'electron.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return stubPath
  return origResolve.call(this, req, ...rest)
}
const stub = require(stubPath)

let pass = 0
let fail = 0
const ok = (n, extra = '') => { pass++; console.log(`PASS ${n}${extra ? ' :: ' + extra : ''}`) }
const bad = (n, extra = '') => { fail++; console.log(`FAIL ${n}${extra ? ' :: ' + extra : ''}`) }
const check = (n, cond, extra = '') => (cond ? ok(n, extra) : bad(n, extra))

// 建一个最小 home
function seedHome() {
  fs.mkdirSync(path.join(HOME, 'data', 'chats'), { recursive: true })
  fs.mkdirSync(path.join(HOME, 'personas'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    version: 1,
    theme: 'dark',
    language: 'zh-CN',
    providers: [{ id: 'p1', name: 'P1' }],
    activeModelId: 'p1/model'
  }, null, 2))
  fs.writeFileSync(path.join(HOME, 'memory.json'), JSON.stringify({ version: 2, entries: [] }, null, 2))
  fs.writeFileSync(path.join(HOME, 'data', 'chats', 's1.json'), JSON.stringify({ id: 's1', messages: [{ role: 'user', content: 'hi' }] }, null, 2))
  fs.writeFileSync(path.join(HOME, 'personas', 'deva.md'), '# Deva\n')
  // 密钥库：用桩封装
  const enc = stub.safeStorage.encryptString('sk-real-api-key-123')
  fs.writeFileSync(path.join(HOME, 'secrets.json'), JSON.stringify({ p1: enc.toString('base64') }, null, 2))
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true })
  seedHome()

  // 懒加载产品模块（必须在 electron 顶替之后）
  const buildDir = path.resolve(__dirname, '..', '..', 'apps', 'desktop', 'src')
  // 产品代码是 TS，用 esbuild 现场打包
  const esbuild = require('esbuild')
  const entry = path.join(BASE, 'entry.ts')
  fs.writeFileSync(entry, `
import { exportBundle } from '${buildDir.replace(/\\/g, '/')}/main/services/bundle-export'
import { restoreBundle } from '${buildDir.replace(/\\/g, '/')}/main/services/bundle-import'
import { verifyPassphrase } from '${buildDir.replace(/\\/g, '/')}/main/services/bundle-crypto'
export { exportBundle, restoreBundle, verifyPassphrase }
`)
  const outfile = path.join(BASE, 'bundle-code.cjs')
  await esbuild.build({
    entryPoints: [entry], bundle: true, outfile, platform: 'node', format: 'cjs',
    alias: { electron: stubPath }, logLevel: 'silent'
  })
  const { exportBundle, restoreBundle } = require(outfile)

  // ══ 场景 A：不带口令导出 → 包里没有字符段，正常可还原，密钥不会回来 ══
  const pkgNoPass = path.join(BASE, 'nopass.dbk')
  const expA = await exportBundle({ targetPath: pkgNoPass })
  check('A1 无口令导出成功', expA.ok === true, JSON.stringify(expA).slice(0, 120))
  check('A2 无口令导出 hasSecrets=false', expA.ok && expA.hasSecrets === false, `hasSecrets=${expA.hasSecrets}`)

  const fflate = require('fflate')
  const zipA = fflate.unzipSync(new Uint8Array(fs.readFileSync(pkgNoPass)))
  check('A3 包里没有 secrets.enc', !('secrets.enc' in zipA), Object.keys(zipA).filter(k => k.endsWith('.enc')).join(',') || '（无 .enc）')
  check('A4 manifest.hasSecrets=false', (() => {
    const m = JSON.parse(Buffer.from(zipA['manifest.json']).toString('utf8'))
    return m.hasSecrets === false
  })())

  // 还原到全新 home（模拟重装）
  const HOM2 = path.join(BASE, 'home2')
  fs.mkdirSync(HOM2, { recursive: true })
  process.env.DEVA_HOME = HOM2
  // config 模块缓存了 home，需清 require 缓存
  for (const k of Object.keys(require.cache)) if (k.includes('bundle-code')) delete require.cache[k]
  const mod2 = require(outfile)
  const resA = await mod2.restoreBundle({ bundlePath: pkgNoPass })
  check('A5 无口令包可还原（不报错）', resA.ok === true, JSON.stringify(resA).slice(0, 160))
  check('A6 无口令还原后 secrets.absent=true', resA.ok && resA.secrets.absent === true, JSON.stringify(resA.ok && resA.secrets))
  check('A7 无口令还原后会话/配置/角色都在', (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(HOM2, 'config.json'), 'utf8'))
      return cfg.theme === 'dark' && fs.existsSync(path.join(HOM2, 'data', 'chats', 's1.json')) &&
        fs.existsSync(path.join(HOM2, 'personas', 'deva.md'))
    } catch { return false }
  })())
  const secAfter = fs.existsSync(path.join(HOM2, 'secrets.json'))
  check('A8 无口令还原后密钥库状态（记录实际行为）', true, `secrets.json 存在=${secAfter}`)

  // ══ 场景 B：needsRestart 到底是不是恒为 true ══
  check('B1 needsRestart 恒为 true（无论配置重读成败）', resA.ok && resA.needsRestart === true, `needsRestart=${resA.ok && resA.needsRestart}`)

  // ══ 场景 C：界面偏好回来没（主题/语言）══
  check('C1 主题回来了', (() => {
    try { return JSON.parse(fs.readFileSync(path.join(HOM2, 'config.json'), 'utf8')).theme === 'dark' } catch { return false }
  })())
  check('C2 语言回来了', (() => {
    try { return JSON.parse(fs.readFileSync(path.join(HOM2, 'config.json'), 'utf8')).language === 'zh-CN' } catch { return false }
  })())
  check('C3 窗口大小在 config.json 里有对应字段（若没有则说明未持久化）', (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(HOM2, 'config.json'), 'utf8'))
      const keys = Object.keys(cfg).join(',')
      return /window|bounds|width|height/i.test(keys)
    } catch { return false }
  })(), (() => {
    try { return 'config 顶层键: ' + Object.keys(JSON.parse(fs.readFileSync(path.join(HOM2, 'config.json'), 'utf8'))).join(',') } catch { return '' }
  })())

  // ══ 场景 D：口令错时是否在解压前拦（check-passphrase 的行为）══
  // 用带口令的包
  process.env.DEVA_HOME = HOME
  const pkgPass = path.join(BASE, 'withpass.dbk')
  const expD = await exportBundle({ targetPath: pkgPass, passphrase: 'correct-horse-battery' })
  check('D1 带口令导出成功', expD.ok === true, JSON.stringify(expD).slice(0, 100))
  check('D2 带口令导出 hasSecrets=true', expD.ok && expD.hasSecrets === true)

  // 用 verifyPassphrase 验证（等价界面 checkPassphrase 的底层）
  const zipD = fflate.unzipSync(new Uint8Array(fs.readFileSync(pkgPass)))
  const manifestD = JSON.parse(Buffer.from(zipD['manifest.json']).toString('utf8'))
  const { verifyPassphrase } = require(outfile)
  const wrong = await verifyPassphrase(Buffer.from(zipD['secrets.enc']), 'wrong-pass', manifestD.secretsKdf)
  const right = await verifyPassphrase(Buffer.from(zipD['secrets.enc']), 'correct-horse-battery', manifestD.secretsKdf)
  check('D3 错口令 verifyPassphrase=false（可在解压前拦住）', wrong === false)
  check('D4 对的口令 verifyPassphrase=true', right === true)

  // ══ 场景 E：错口令走完整还原 → 会不会已经写了文件 ══
  const HOM3 = path.join(BASE, 'home3')
  fs.mkdirSync(HOM3, { recursive: true })
  process.env.DEVA_HOME = HOM3
  for (const k of Object.keys(require.cache)) if (k.includes('bundle-code')) delete require.cache[k]
  const mod3 = require(outfile)
  const resE = await mod3.restoreBundle({ bundlePath: pkgPass, passphrase: 'wrong-pass' })
  check('E1 错口令还原被拒', resE.ok === false, `code=${resE.ok === false ? resE.code : 'ok'}`)
  // 关键：被拒时是否已经把会话/配置写进目标了
  const wroteChats = fs.existsSync(path.join(HOM3, 'data', 'chats', 's1.json'))
  const wroteCfg = fs.existsSync(path.join(HOM3, 'config.json'))
  const wroteSecrets = fs.existsSync(path.join(HOM3, 'secrets.json'))
  check('E2 错口令被拒时目标是否已被写入（记录实际行为）', true,
    `会话=${wroteChats} config=${wroteCfg} secrets=${wroteSecrets}`)

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
