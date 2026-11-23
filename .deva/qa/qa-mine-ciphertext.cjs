/**
 * 验收者自建：#7 关键验证 —— 不带口令导出时，secrets.json 原密文是否被打进了包？
 *
 * 按设计意图：「未给口令 = 包里不含密钥段」，用户以为密钥没带出去、导入后重填。
 * 但 secrets.json 本身是 home 里的**普通文件**，scanHome 会把它当普通文件收进包。
 * 若如此，重装后还原会把「旧机器 DPAPI 密文」写回 → 新 key 解不开 → 全部 provider 401。
 *
 * 跑法：node .deva/qa/qa-mine-ciphertext.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cipher-'))
const stubPath = path.resolve(__dirname, 'stubs', 'electron.cjs')
process.env.HOME = BASE
process.env.USERPROFILE = BASE
process.env.APPDATA = path.join(BASE, 'appdata')
const stub = require(stubPath)

let pass = 0
let fail = 0
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
import { scanHome } from '${src}/main/services/bundle-manifest'
export { exportBundle, restoreBundle, scanHome }
`)
  const outfile = path.join(BASE, 'code.cjs')
  await esbuild.build({
    entryPoints: [entry], bundle: true, outfile, platform: 'node', format: 'cjs',
    alias: { electron: stubPath }, logLevel: 'silent'
  })
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
  const cipher = stub.safeStorage.encryptString('sk-SECRET-VALUE-XYZ').toString('base64')
  fs.writeFileSync(path.join(OLD, 'secrets.json'), JSON.stringify({ p1: cipher }, null, 2))

  const outfile = await loadCode()
  process.env.DEVA_HOME = OLD
  let mod = freshRequire(outfile)

  // scanHome 是否把 secrets.json 当普通文件收进来
  const scan = await mod.scanHome(OLD)
  const has = scan.files.some((f) => f.path === 'secrets.json')
  check('Q1 scanHome 把 secrets.json 当普通文件收进清单', has,
    `清单: ${scan.files.map((f) => f.path).join(', ')}`)

  // 无口令导出 → 包里有没有 home/secrets.json
  const pkg = path.join(BASE, 'nopass.dbk')
  const exp = await mod.exportBundle({ targetPath: pkg })
  check('Q2 无口令导出 hasSecrets=false（不含 secrets.enc）', exp.ok && exp.hasSecrets === false)

  const fflate = require('fflate')
  const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(pkg)))
  const entryNames = Object.keys(zip)
  const hasSecretsJson = entryNames.includes('home/secrets.json')
  const hasSecretsEnc = entryNames.includes('secrets.enc')
  check('Q3 包里**没有** secrets.enc（符合设计）', !hasSecretsEnc)
  check('Q4 包里**有** home/secrets.json（原密文被当普通文件带走）', hasSecretsJson,
    entryNames.join(', '))

  if (hasSecretsJson) {
    const packed = JSON.parse(Buffer.from(zip['home/secrets.json']).toString('utf8'))
    check('Q5 包内 home/secrets.json 就是旧机器密文（未解成明文）',
      packed.p1 === cipher, `包内=${String(packed.p1).slice(0, 24)}… 原=${cipher.slice(0, 24)}…`)
    // 关键：这份密文是否仍是"仅本机能解"的产物
    let decodableByNewMachine = false
    try {
      const plain = stub.safeStorage.decryptString(Buffer.from(packed.p1, 'base64'))
      decodableByNewMachine = plain === 'sk-SECRET-VALUE-XYZ'
    } catch { decodableByNewMachine = false }
    note('Q6 桩环境下能否解开（桩是同一把固定 key，所以必然能解；真实 DPAPI 换机解不开）',
      String(decodableByNewMachine))
  }

  // 还原到新 home → secrets.json 是否被旧密文覆盖
  const NEW = path.join(BASE, 'new')
  fs.mkdirSync(NEW, { recursive: true })
  const freshCipher = stub.safeStorage.encryptString('sk-NEWLY-ENTERED-BY-USER').toString('base64')
  fs.writeFileSync(path.join(NEW, 'secrets.json'), JSON.stringify({ p1: freshCipher }, null, 2))
  process.env.DEVA_HOME = NEW
  mod = freshRequire(outfile)
  const r = await mod.restoreBundle({ bundlePath: pkg, overwriteConfirmed: true })
  check('Q7 无口令包还原成功', r.ok === true, JSON.stringify(r).slice(0, 140))
  const after = JSON.parse(fs.readFileSync(path.join(NEW, 'secrets.json'), 'utf8'))
  note('Q8 还原后 secrets.json 的 p1 值',
    after.p1 === freshCipher ? '仍是用户新填的（未被覆盖）' : (after.p1 === cipher ? '被旧机器密文覆盖了' : '其它'))
  check('Q9 无口令还原**不应**覆盖用户新填的密钥（否则重装后 provider 全 401）',
    after.p1 === freshCipher,
    after.p1 === cipher ? 'FAIL: 旧机器密文覆盖了新填的密钥' : '')
  check('Q10 报告里 secrets.absent=true 但没说 secrets.json 被覆盖', r.ok && r.secrets.absent === true,
    `absent=true 同时旧密文被写盘 —— 用户看到「包里不含密钥」，实际密钥文件被换成了不可用的`)

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
