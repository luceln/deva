/**
 * 验收者自建：#6 无口令包 + 已有密钥库时的行为。
 *
 * 用户场景：不带口令导出（A6 已证包里没有 secrets.enc）→ 重装 → 还原。
 * 关心：还原后 secrets.json 是被清掉、还是留着新装环境自己的空/旧密钥？
 * 若留着，「跟卸载前一样」就不成立（旧密钥没回来，但也没有明确告知）。
 *
 * 跑法：node .deva/qa/qa-mine-nosecrets.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-nosec-'))
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
export { exportBundle, restoreBundle }
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
  fs.mkdirSync(path.join(OLD, 'data', 'chats'), { recursive: true })
  fs.writeFileSync(path.join(OLD, 'config.json'), JSON.stringify({ version: 1, theme: 'dark' }))
  fs.writeFileSync(path.join(OLD, 'data', 'chats', 'old.json'), JSON.stringify({ id: 'old' }))
  fs.writeFileSync(path.join(OLD, 'secrets.json'), JSON.stringify({
    'old-provider': stub.safeStorage.encryptString('sk-OLD-KEY').toString('base64')
  }, null, 2))

  const outfile = await loadCode()
  process.env.DEVA_HOME = OLD
  let mod = freshRequire(outfile)
  const pkgNoPass = path.join(BASE, 'nopass.dbk')
  const exp = await mod.exportBundle({ targetPath: pkgNoPass })
  check('N1 无口令导出成功', exp.ok === true && exp.hasSecrets === false)

  // 目标：重装后应用自己建了一份 secrets.json（空对象或带别的条目）
  const NEW = path.join(BASE, 'new')
  fs.mkdirSync(path.join(NEW, 'data', 'chats'), { recursive: true })
  fs.writeFileSync(path.join(NEW, 'config.json'), JSON.stringify({ version: 1, theme: 'light' }))
  fs.writeFileSync(path.join(NEW, 'secrets.json'), JSON.stringify({
    'seed-provider': stub.safeStorage.encryptString('sk-SEED').toString('base64')
  }, null, 2))

  process.env.DEVA_HOME = NEW
  mod = freshRequire(outfile)
  const r = await mod.restoreBundle({ bundlePath: pkgNoPass, overwriteConfirmed: true })
  check('N2 无口令包还原成功', r.ok === true, JSON.stringify(r).slice(0, 150))
  check('N3 报告里 secrets.absent=true（明确告知没带密钥）', r.ok && r.secrets.absent === true)

  // 关键：还原后 secrets.json 是谁的？
  let keys = []
  let exists = fs.existsSync(path.join(NEW, 'secrets.json'))
  if (exists) {
    try { keys = Object.keys(JSON.parse(fs.readFileSync(path.join(NEW, 'secrets.json'), 'utf8'))) } catch { keys = ['<解析失败>'] }
  }
  note('N4 还原后 secrets.json', `存在=${exists} 键=${keys.join(',') || '（空）'}`)
  check('N5 目标原有密钥**没有**被静默删掉（这算好事，但用户需知道旧密钥没回来）',
    exists, exists ? `仍有 ${keys.join(',')}` : 'secrets.json 被删了')

  // 旧密钥在不在包里？
  const fflate = require('fflate')
  const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(pkgNoPass)))
  check('N6 无口令包里确实没有 secrets.enc', !('secrets.enc' in zip))

  // 界面文案：absent 时显示什么
  console.log('')
  note('N7 界面在 absent 时显示的文案（cf.backup.secretsAbsent）',
    (() => {
      const fork = fs.readFileSync(path.join(__dirname, '..', '..', 'apps/desktop/src/renderer/src/i18n/fork.ts'), 'utf8')
      const m = /secretsAbsent: '([^']*)'/.exec(fork)
      return m ? m[1] : '（找不到）'
    })())

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
