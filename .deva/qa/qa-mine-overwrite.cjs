/**
 * 验收者自建夹具 #3：验证「残留」在真实场景是否构成问题。
 *
 * 场景：用户重装后、还原**之前**，应用已经启动过 —— 于是 home 里已有
 *   ① 应用自动生成的种子 config.json（带新 provider）
 *   ② 应用自动建的内置角色 personas/*.md
 *   ③ 一个空 memory.json
 * 然后用户还原。检查：旧数据回来了没有、新装的种子数据有没有留下、memory 有没有被污染。
 *
 * 跑法：node .deva/qa/qa-mine-overwrite.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ow-'))
const stubPath = path.resolve(__dirname, 'stubs', 'electron.cjs')

let pass = 0
let fail = 0
const ok = (n, e = '') => { pass++; console.log(`PASS ${n}${e ? ' :: ' + e : ''}`) }
const bad = (n, e = '') => { fail++; console.log(`FAIL ${n}${e ? ' :: ' + e : ''}`) }
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e))
const note = (n, e) => { console.log(`NOTE ${n} :: ${e}`) }

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

/** 模拟"卸载前"的旧 home */
function seedOldHome(home) {
  fs.mkdirSync(path.join(home, 'data', 'chats'), { recursive: true })
  fs.mkdirSync(path.join(home, 'personas'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    version: 1, theme: 'dark', language: 'zh-CN',
    providers: [{ id: 'old-provider', name: 'Old' }], activeModelId: 'old-provider/m'
  }, null, 2))
  fs.writeFileSync(path.join(home, 'data', 'chats', 'old-session.json'),
    JSON.stringify({ id: 'old-session', messages: [{ role: 'user', content: 'OLD' }] }))
  fs.writeFileSync(path.join(home, 'personas', 'my-custom.md'), '# my custom persona\n')
  fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({
    version: 2, entries: [
      { id: 'mem-old-1', type: 'user', title: '旧记忆', body: 'OLD BODY' },
      { id: 'mem-old-2', type: 'project', title: '旧项目记忆', body: 'OLD PROJECT' }
    ]
  }, null, 2))
}

/** 模拟"重装后、还原前"的 home：应用已启动过，写了自己的种子数据 */
function seedFreshHome(home) {
  fs.mkdirSync(path.join(home, 'data', 'chats'), { recursive: true })
  fs.mkdirSync(path.join(home, 'personas'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    version: 1, theme: 'system', language: 'en',
    providers: [{ id: 'seed-provider', name: 'Seed' }], activeModelId: 'seed-provider/m'
  }, null, 2))
  fs.writeFileSync(path.join(home, 'personas', 'deva.md'), '# builtin deva\n')
  fs.writeFileSync(path.join(home, 'personas', 'lucy.md'), '# builtin lucy\n')
  fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({ version: 2, entries: [] }, null, 2))
}

async function main() {
  const OLD = path.join(BASE, 'old-home')
  const FRESH = path.join(BASE, 'fresh-home')
  seedOldHome(OLD)
  seedFreshHome(FRESH)

  const outfile = await loadCode()

  // 1. 用旧 home 导出
  process.env.DEVA_HOME = OLD
  process.env.HOME = OLD
  process.env.USERPROFILE = OLD
  process.env.APPDATA = path.join(BASE, 'appdata')
  let mod = freshRequire(outfile)
  const pkg = path.join(BASE, 'backup.dbk')
  const exp = await mod.exportBundle({ targetPath: pkg })
  check('O1 导出旧 home 成功', exp.ok === true, JSON.stringify(exp).slice(0, 110))

  // 2. 还原到"重装后的 home"（已有种子数据）
  process.env.DEVA_HOME = FRESH
  mod = freshRequire(outfile)
  const r = await mod.restoreBundle({ bundlePath: pkg, overwriteConfirmed: true })
  check('O2 还原成功', r.ok === true, JSON.stringify(r).slice(0, 200))

  // 3. 检查旧数据回来没
  const cfg = JSON.parse(fs.readFileSync(path.join(FRESH, 'config.json'), 'utf8'))
  check('O3 旧 config 被覆盖回来（theme=dark）', cfg.theme === 'dark', `theme=${cfg.theme}`)
  check('O4 旧 provider 在', cfg.providers.some((p) => p.id === 'old-provider'),
    JSON.stringify(cfg.providers.map((p) => p.id)))
  check('O5 新装的种子 provider 未被立刻清掉（config 是整份替换，应该没有它）',
    !cfg.providers.some((p) => p.id === 'seed-provider'),
    JSON.stringify(cfg.providers.map((p) => p.id)))
  check('O6 旧会话回来了', fs.existsSync(path.join(FRESH, 'data', 'chats', 'old-session.json')))
  check('O7 旧自定义角色回来了', fs.existsSync(path.join(FRESH, 'personas', 'my-custom.md')))

  // ★ 关键：新装的内置角色有没有留下（包里没有它们）
  const devaLeft = fs.existsSync(path.join(FRESH, 'personas', 'deva.md'))
  const lucyLeft = fs.existsSync(path.join(FRESH, 'personas', 'lucy.md'))
  note('O8 包里没有的内置角色在还原后是否残留', `deva.md=${devaLeft} lucy.md=${lucyLeft}`)

  // ★ 关键：memory.json 有没有被旧数据覆盖（它是个整文件，包里有所以会覆盖）
  const mem = JSON.parse(fs.readFileSync(path.join(FRESH, 'memory.json'), 'utf8'))
  note('O9 memory.json 内容', `entries=${mem.entries.length} ids=${mem.entries.map((e) => e.id).join(',')}`)
  check('O10 旧记忆回来了', mem.entries.some((e) => e.id === 'mem-old-1'))

  // 统计还原后 home 里的实际文件数 vs 包内文件数
  function countFiles(dir) {
    let n = 0
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) n += countFiles(p)
      else n += 1
    }
    return n
  }
  const after = countFiles(FRESH)
  note('O11 还原后 home 文件总数 vs 包内文件数', `还原后=${after} 包内=${r.ok ? r.files : '?'}`)
  if (r.ok && after > r.files) {
    note('O12 结论', `多出 ${after - r.files} 个包内没有的文件，说明是「覆盖」而不是「整份替换」`)
  }

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
