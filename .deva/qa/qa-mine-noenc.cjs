/**
 * 验收者自建：#8 目标机无加密能力（Linux 缺 libsecret）时，密钥文件会怎样。
 * 预期按设计：不写明文，报 noEncryption=true。要查的是：
 * 那份从包里带来的旧机器密文，会不会留在盘上冒充「密钥存在」。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-noenc-'))
const stubPath = path.resolve(__dirname, 'qa-mine-enc-stub.cjs')
process.env.HOME = BASE
process.env.USERPROFILE = BASE
process.env.APPDATA = path.join(BASE, 'appdata')
const stub = require(stubPath)

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
  fs.mkdirSync(OLD, { recursive: true })
  fs.writeFileSync(path.join(OLD, 'config.json'), JSON.stringify({ version: 1 }))
  const cipher = stub.safeStorage.encryptString('sk-OLD').toString('base64')
  fs.writeFileSync(path.join(OLD, 'secrets.json'), JSON.stringify({ p1: cipher }, null, 2))

  const outfile = await loadCode()
  process.env.DEVA_HOME = OLD
  let mod = freshRequire(outfile)
  const pkg = path.join(BASE, 'p.dbk')
  const exp = await mod.exportBundle({ targetPath: pkg, passphrase: 'passphrase-123' })
  check('R1 带口令导出成功', exp.ok === true && exp.hasSecrets === true)

  // 目标机：无加密能力
  const NEW = path.join(BASE, 'new')
  fs.mkdirSync(NEW, { recursive: true })
  process.env.DEVA_HOME = NEW
  mod = freshRequire(outfile)
  globalThis.__QA_ENC_AVAILABLE = false
  let r
  try {
    r = await mod.restoreBundle({ bundlePath: pkg, passphrase: 'passphrase-123', overwriteConfirmed: true })
  } finally {
    globalThis.__QA_ENC_AVAILABLE = undefined
  }

  check('R2 还原本身成功', r.ok === true, JSON.stringify(r).slice(0, 160))
  check('R3 报告 noEncryption=true', r.ok && r.secrets.noEncryption === true, JSON.stringify(r.ok && r.secrets))
  const secPath = path.join(NEW, 'secrets.json')
  const exists = fs.existsSync(secPath)
  let content = null
  if (exists) { try { content = JSON.parse(fs.readFileSync(secPath, 'utf8')) } catch { content = '<parse fail>' } }
  note('R4 无加密能力时 secrets.json 是否留在盘上', `存在=${exists} 内容=${JSON.stringify(content).slice(0, 80)}`)
  check('R5 没有写入明文（这是安全底线）',
    !exists || JSON.stringify(content).indexOf('sk-OLD') === -1,
    exists ? '未含明文' : '文件不存在')
  if (exists && content && content.p1 === cipher) {
    note('R6 结论', '盘上留的是包内带来的旧机器密文 —— 新环境解不开，但界面会显示"密钥已配置"')
  }

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
