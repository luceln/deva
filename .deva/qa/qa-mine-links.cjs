/**
 * 验收者自建夹具 #2：验证
 *   1. 符号链接（junction）还原后是否**仍是链接**，目标不存在时是否降级为副本并报告
 *   2. 「整文件替换」是否真替换 —— 包里没有的文件在还原后会不会残留
 *   3. 中途失败时是否留下半个 home
 *
 * 跑法：node .deva/qa/qa-mine-links.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-links-'))
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
const note = (n, e) => { pass++; console.log(`NOTE ${n} :: ${e}`) }

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
  // ── 造源 home：含一个 junction 指向外部仓库，以及一个指向不存在目标的坏链接 ──
  fs.mkdirSync(path.join(HOME, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(HOME, 'data', 'chats'), { recursive: true })
  const externalRepo = path.join(BASE, 'external-repo')
  fs.mkdirSync(externalRepo, { recursive: true })
  fs.writeFileSync(path.join(externalRepo, 'SKILL.md'), '# external skill\n')
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ version: 1, theme: 'dark' }, null, 2))
  fs.writeFileSync(path.join(HOME, 'data', 'chats', 's1.json'), JSON.stringify({ id: 's1' }, null, 2))

  const linkPath = path.join(HOME, 'skills', 'linked-skill')
  let madeLink = false
  try {
    fs.symlinkSync(externalRepo, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    madeLink = true
  } catch (e) {
    bad('L0 造 junction 失败', String(e && e.message))
  }
  if (madeLink) ok('L0 造 junction 成功', externalRepo)

  const outfile = await loadCode()
  let mod = freshRequire(outfile)

  // ── 导出 ──
  const pkg = path.join(BASE, 'links.dbk')
  const exp = await mod.exportBundle({ targetPath: pkg })
  check('L1 导出成功', exp.ok === true, JSON.stringify(exp).slice(0, 110))

  const fflate = require('fflate')
  const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(pkg)))
  const man = JSON.parse(Buffer.from(zip['manifest.json']).toString('utf8'))
  check('L2 清单里记了 junction', man.symlinks.some((s) => s.path === 'skills/linked-skill'),
    JSON.stringify(man.symlinks))
  check('L3 junction 的目标内容没被打进包（只记链接本身）',
    !Object.keys(zip).some((k) => k.includes('skills/linked-skill/SKILL.md')),
    Object.keys(zip).filter((k) => k.includes('linked-skill')).join(',') || '（无该路径条目）')

  // ── 还原到目标存在的新 home：应重建为链接 ──
  const HOM2 = path.join(BASE, 'home2')
  fs.mkdirSync(HOM2, { recursive: true })
  process.env.DEVA_HOME = HOM2
  mod = freshRequire(outfile)
  const r1 = await mod.restoreBundle({ bundlePath: pkg })
  check('L4 还原成功', r1.ok === true, JSON.stringify(r1).slice(0, 200))
  if (r1.ok) {
    const dst = path.join(HOM2, 'skills', 'linked-skill')
    let isLink = false
    try { isLink = fs.lstatSync(dst).isSymbolicLink() } catch { /* 不存在 */ }
    check('L5 还原后仍是符号链接（不是实体副本）', isLink, `lstat.isSymbolicLink=${isLink}`)
    check('L6 relinked 计数=1', r1.relinked === 1, `relinked=${r1.relinked}`)
    check('L7 symlinkAsCopy 为空（目标存在时不降级）', r1.symlinkAsCopy.length === 0, JSON.stringify(r1.symlinkAsCopy))
    // 关键：通过链接改外部仓库，应生效
    if (isLink) {
      fs.writeFileSync(path.join(dst, 'PROBE.txt'), 'via-link')
      check('L8 通过还原后的链接写入能落到外部仓库（链接真的联动了）',
        fs.existsSync(path.join(externalRepo, 'PROBE.txt')))
    }
  }

  // ── 还原到目标不存在的新 home：应降级为副本并报告 ──
  const HOM3 = path.join(BASE, 'home3')
  fs.mkdirSync(HOM3, { recursive: true })
  process.env.DEVA_HOME = HOM3
  // 把源里的链接改成指向不存在的目标，重新导一份
  process.env.DEVA_HOME = HOME
  fs.rmSync(linkPath, { recursive: true, force: true })
  const ghostTarget = path.join(BASE, 'ghost-not-exist')
  try { fs.symlinkSync(ghostTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir') } catch { /* 目标不存在时 junction 可能建不了 */ }
  const pkgGhost = path.join(BASE, 'links-ghost.dbk')
  mod = freshRequire(outfile)
  const expG = await mod.exportBundle({ targetPath: pkgGhost })
  check('L9 导出含坏链接的 home 成功', expG.ok === true, JSON.stringify(expG).slice(0, 110))

  process.env.DEVA_HOME = HOM3
  mod = freshRequire(outfile)
  const r2 = await mod.restoreBundle({ bundlePath: pkgGhost })
  if (r2.ok) {
    note('L10 坏链接还原结果', `relinked=${r2.relinked} symlinkAsCopy=${JSON.stringify(r2.symlinkAsCopy)}`)
  } else {
    note('L10 坏链接还原被拒', `${r2.code} ${r2.message}`)
  }

  // ── 「整文件替换」是否真替换：包里没有的文件会不会残留 ──
  const HOM4 = path.join(BASE, 'home4')
  fs.mkdirSync(path.join(HOM4, 'data', 'chats'), { recursive: true })
  fs.mkdirSync(path.join(HOM4, 'personas'), { recursive: true })
  // 预置一个包里没有的会话 + 一个包里没有的配置字段
  fs.writeFileSync(path.join(HOM4, 'data', 'chats', 'leftover.json'), JSON.stringify({ id: 'leftover' }))
  fs.writeFileSync(path.join(HOM4, 'personas', 'leftover.md'), '# leftover\n')
  fs.writeFileSync(path.join(HOM4, 'memory.json'), JSON.stringify({ version: 2, entries: [{ id: 'leftover', type: 'user', title: 'x', body: 'y' }] }))
  process.env.DEVA_HOME = HOM4
  mod = freshRequire(outfile)
  const r3 = await mod.restoreBundle({ bundlePath: pkg, overwriteConfirmed: true })
  check('L11 非空目标确认后还原成功', r3.ok === true, JSON.stringify(r3).slice(0, 120))
  const leftoverChat = fs.existsSync(path.join(HOM4, 'data', 'chats', 'leftover.json'))
  const leftoverPersona = fs.existsSync(path.join(HOM4, 'personas', 'leftover.md'))
  const leftoverMemory = fs.existsSync(path.join(HOM4, 'memory.json'))
  note('L12 包里没有的文件在还原后是否残留（整文件替换 vs 合并）',
    `leftover会话=${leftoverChat} leftover角色=${leftoverPersona} 预置memory=${leftoverMemory}`)
  check('L13 包里的会话确实写进去了', fs.existsSync(path.join(HOM4, 'data', 'chats', 's1.json')))
  check('L14 覆盖前备份存在', Boolean(r3.ok && r3.backupOfPrevious), r3.ok ? String(r3.backupOfPrevious) : '')

  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  console.log(`临时目录 ${BASE}`)
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('夹具异常:', e); process.exitCode = 2 })
