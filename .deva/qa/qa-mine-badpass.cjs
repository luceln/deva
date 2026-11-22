/**
 * 验收者自建：#5 精确验证「错口令」时的破坏范围。
 *
 * 关注三件事（对应验收项 3）：
 *  1. 错口令是否在解压 600MB 之前就被拦住？（界面路径 vs 直接调 restoreBundle 路径）
 *  2. 如果拦不住，目标 home 被改到什么程度？还能不能退回去？
 *  3. 被拒时有没有留下临时目录 / 半个文件。
 *
 * 跑法：node .deva/qa/qa-mine-badpass.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-badpass-'))
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
const note = (n, e) => console.log(`NOTE ${n} :: ${e}`)

async function loadCode() {
  const esbuild = require('esbuild')
  const src = path.resolve(__dirname, '..', '..', 'apps', 'desktop', 'src').replace(/\\/g, '/')
  const entry = path.join(BASE, 'entry.ts')
  fs.writeFileSync(entry, `
import { exportBundle } from '${src}/main/services/bundle-export'
import { restoreBundle } from '${src}/main/services/bundle-import'
import { verifyPassphrase } from '${src}/main/services/bundle-crypto'
export { exportBundle, restoreBundle, verifyPassphrase }
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
  // ── 旧 home：用户卸载前的数据（要还原的东西）──
  const OLD = path.join(BASE, 'old-home')
  fs.mkdirSync(path.join(OLD, 'data', 'chats'), { recursive: true })
  fs.mkdirSync(path.join(OLD, 'personas'), { recursive: true })
  fs.writeFileSync(path.join(OLD, 'config.json'), JSON.stringify({ version: 1, theme: 'dark', providers: [{ id: 'old-p' }] }, null, 2))
  fs.writeFileSync(path.join(OLD, 'data', 'chats', 'old.json'), JSON.stringify({ id: 'old' }))
  fs.writeFileSync(path.join(OLD, 'personas', 'mine.md'), '# mine\n')
  fs.writeFileSync(path.join(OLD, 'secrets.json'), JSON.stringify({
    'old-p': require(stubPath).safeStorage.encryptString('sk-old').toString('base64')
  }))

  const outfile = await loadCode()
  process.env.DEVA_HOME = OLD
  let mod = freshRequire(outfile)
  const pkg = path.join(BASE, 'b.dbk')
  const exp = await mod.exportBundle({ targetPath: pkg, passphrase: 'the-right-one-123' })
  check('P1 导出带密钥的包', exp.ok === true && exp.hasSecrets === true, `hasSecrets=${exp.hasSecrets}`)

  // ── 目标 home：重装后，用户已经有了一点新数据（打开了应用、聊了几句）──
  const NEW = path.join(BASE, 'new-home')
  fs.mkdirSync(path.join(NEW, 'data', 'chats'), { recursive: true })
  fs.mkdirSync(path.join(NEW, 'personas'), { recursive: true })
  fs.writeFileSync(path.join(NEW, 'config.json'), JSON.stringify({ version: 1, theme: 'light', providers: [{ id: 'new-p' }] }, null, 2))
  fs.writeFileSync(path.join(NEW, 'data', 'chats', 'newchat.json'), JSON.stringify({ id: 'newchat', messages: ['important new stuff'] }))
  fs.writeFileSync(path.join(NEW, 'personas', 'newpersona.md'), '# new persona user made\n')

  // ── 场景 1：直接调 restoreBundle + 错口令 ──
  process.env.DEVA_HOME = NEW
  mod = freshRequire(outfile)
  const before = {
    theme: JSON.parse(fs.readFileSync(path.join(NEW, 'config.json'), 'utf8')).theme,
    newChat: fs.existsSync(path.join(NEW, 'data', 'chats', 'newchat.json')),
    newPersona: fs.existsSync(path.join(NEW, 'personas', 'newpersona.md'))
  }
  const r1 = await mod.restoreBundle({ bundlePath: pkg, passphrase: 'WRONG-PASS', overwriteConfirmed: true })
  check('P2 错口令被拒（code=bad-passphrase）', r1.ok === false && r1.code === 'bad-passphrase',
    r1.ok ? 'ok=true（没拦住！）' : `code=${r1.code}`)

  const after = {
    theme: (() => { try { return JSON.parse(fs.readFileSync(path.join(NEW, 'config.json'), 'utf8')).theme } catch { return null } })(),
    oldChat: fs.existsSync(path.join(NEW, 'data', 'chats', 'old.json')),
    oldPersona: fs.existsSync(path.join(NEW, 'personas', 'mine.md')),
    newChat: fs.existsSync(path.join(NEW, 'data', 'chats', 'newchat.json')),
    newPersona: fs.existsSync(path.join(NEW, 'personas', 'newpersona.md')),
    secrets: fs.existsSync(path.join(NEW, 'secrets.json'))
  }

  note('P3 错口令被拒后，目标 home 的实际状态（before vs after）',
    `theme ${before.theme}→${after.theme}; 新用户会话 ${before.newChat}→${after.newChat}; 新用户角色 ${before.newPersona}→${after.newPersona}`)
  note('P4 错口令被拒后，包里的旧数据是否已经写进去了',
    `旧会话=${after.oldChat} 旧角色=${after.oldPersona} secrets.json=${after.secrets}`)

  check('P5 错口令被拒时**不应**改动目标数据（这是验收项 3 的核心）',
    after.theme === before.theme && after.newChat === before.newChat && after.newPersona === before.newPersona,
    `theme ${before.theme}→${after.theme}, 新会话 ${before.newChat}→${after.newChat}, 新角色 ${before.newPersona}→${after.newPersona}`)

  check('P6 错口令被拒时**不应**把包内文件写进目标',
    !after.oldChat && !after.oldPersona,
    `旧会话=${after.oldChat} 旧角色=${after.oldPersona}`)

  // ── 场景 2：确认被拒后有没有留下 restore-backup ──
  const leftovers = fs.readdirSync(BASE).filter((n) => n.includes('restore-backup'))
  note('P7 覆盖前备份目录', leftovers.length ? leftovers.join(', ') : '（无 —— 说明在备份之前就中止了）')

  // ── 场景 3：临时 staging 目录是否清理 ──
  const staging = fs.readdirSync(BASE).filter((n) => n.startsWith('.deva-plus-restore-'))
  check('P8 临时 staging 目录已清理', staging.length === 0, staging.join(', ') || '（已清理）')

  // ── 场景 4：界面路径（先 checkPassphrase 再 restore）是否能避免写盘 ──
  const fflate = require('fflate')
  const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(pkg)))
  const man = JSON.parse(Buffer.from(zip['manifest.json']).toString('utf8'))
  const good = await mod.verifyPassphrase(Buffer.from(zip['secrets.enc']), 'the-right-one-123', man.secretsKdf)
  const wrong = await mod.verifyPassphrase(Buffer.from(zip['secrets.enc']), 'WRONG-PASS', man.secretsKdf)
  check('P9 verifyPassphrase 能在还原前判出口令对错（界面正是这么用的）', good === true && wrong === false,
    `对=${good} 错=${wrong}`)
  note('P10 界面路径的结论',
    '界面在 doRestore() 里先 checkPassphrase，若 code=bad-passphrase 就 return，不会调 restore。' +
    '所以走界面时错口令不会写盘。但直接调 backup:restore（例如别的调用方/将来复用）没有这层保护。')

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
