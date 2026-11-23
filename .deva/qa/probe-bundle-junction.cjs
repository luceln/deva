/**
 * 专门证伪「真实 junction 形状」在还原时的行为，以及技能内容会不会丢。
 *
 * 真实 ~/.deva-plus/skills 里 3 条是 <JUNCTION>（指向 E:\toolkit、E:\game、E:\xfg-coding-map-skills）。
 * scanHome 对 lstat.isSymbolicLink() 的条目**只记链接**、不跟进去收文件，
 * 所以包里这三个技能目录**没有任何文件条目**，只有一个 .symlink 条目。
 *
 * 这里验证两种还原场景：
 *   J1 目标路径在这台机器上存在（同机重装 / 外部仓库还在）
 *   J2 目标路径不存在（换机 / 外部仓库没带过来）
 * 看技能内容在还原后是否还在、报告怎么说。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-junction')

let pass = 0
let fail = 0
const ok = (n, d = '') => {
  pass++
  console.log(`  PASS ${n}${d ? ` :: ${d}` : ''}`)
}
const bad = (n, d = '') => {
  fail++
  console.log(`  FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const info = (n, d = '') => console.log(`  INFO ${n}${d ? ` :: ${d}` : ''}`)
const check = (n, c, d = '') => (c ? ok(n, d) : bad(n, d), !!c)
const exists = (p) => fs.existsSync(p)

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
export { scanHome } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-manifest.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'j.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'j.cjs'))
}

function w(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

async function main() {
  const mode = process.argv[2]
  const root = mode ? process.env.PROBE_ROOT : path.join(os.tmpdir(), `deva-junc-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  if (mode === 'export') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_SRC
    const r = await api.exportBundle({ targetPath: process.env.PROBE_BUNDLE })
    const scan = await api.scanHome(process.env.PROBE_SRC)
    console.log(
      JSON.stringify({ ok: r.ok, files: r.files, symlinks: scan.symlinks.map((s) => s.path), msg: r.message })
    )
    return
  }
  if (mode === 'restore') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_HOME
    const r = await api.restoreBundle({ bundlePath: process.env.PROBE_BUNDLE, overwriteConfirmed: true })
    console.log(JSON.stringify(r))
    return
  }

  const runChild = (m, env) => {
    const r = cp.spawnSync(process.execPath, [__filename, m], {
      encoding: 'utf8',
      env: { ...process.env, PROBE_ROOT: root, ...env },
      windowsHide: true,
      timeout: 900000
    })
    const line = (r.stdout || '').trim().split('\n').pop()
    try {
      return JSON.parse(line)
    } catch {
      return { ok: false, _raw: `${(r.stdout || '').slice(-400)}${(r.stderr || '').slice(-400)}` }
    }
  }

  // 源 home：一个真实技能目录（普通文件）+ 3 个 junction（对齐真实环境的 3/4）
  const srcHome = path.join(root, 'src-home')
  fs.mkdirSync(srcHome, { recursive: true })
  w(srcHome, 'personas/deva.md', '# deva\n')
  w(srcHome, 'data/chats/s1.json', JSON.stringify({ id: 's1', messages: [] }))
  w(srcHome, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
  w(srcHome, 'config.json', JSON.stringify({ k: 1 }))
  w(srcHome, 'skills/plain-skill/SKILL.md', '# plain\n')
  const extRoot = path.join(root, 'ext-repos')
  const extNames = ['repo-a', 'repo-b', 'repo-c']
  const made = []
  fs.mkdirSync(path.join(srcHome, 'skills'), { recursive: true })
  for (const n of extNames) {
    const p = path.join(extRoot, n)
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'SKILL.md'), `# ${n}\n`)
    try {
      fs.symlinkSync(p, path.join(srcHome, 'skills', n), process.platform === 'win32' ? 'junction' : 'dir')
      made.push(n)
    } catch (e) {
      info(`junction ${n} 未建成`, e.message)
    }
  }
  info('源 home 的 junction', JSON.stringify(made))

  const bundle = path.join(root, 'j.dbk')
  const exp = runChild('export', { PROBE_SRC: srcHome, PROBE_BUNDLE: bundle })
  if (!exp.ok) {
    bad('导出失败', JSON.stringify(exp))
    return done(root)
  }
  ok('导出成功', `${exp.files} 文件；记录的 symlinks=${JSON.stringify(exp.symlinks)}`)
  check('J0 三个 junction 都被记录为链接（未跟进去收文件）', exp.symlinks.length === made.length,
    `记录 ${exp.symlinks.length} / 实建 ${made.length}`)

  // ═════ J1：目标路径仍存在（同机重装，外部仓库还在） ═════
  {
    const dst = path.join(root, 'dst-j1')
    w(dst, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
    w(dst, 'skills/builtin-skill/SKILL.md', '# builtin\n')
    const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: bundle })
    info('J1 还原结果', JSON.stringify({ ok: r.ok, relinked: r.relinked, symlinkAsCopy: r.symlinkAsCopy }))
    check('J1a 还原成功', r.ok === true, String(r.ok))
    check('J1b 三个 junction 都被重建为链接', r.relinked === made.length, `relinked=${r.relinked}/${made.length}`)
    const isLink = (n) => {
      const p = path.join(dst, 'skills', n)
      try {
        return fs.lstatSync(p).isSymbolicLink()
      } catch {
        return false
      }
    }
    check('J1c 重建的确实是链接而不是实体目录', made.every(isLink), JSON.stringify(made.map((n) => [n, isLink(n)])))
    check('J1d 通过链接能读到技能内容', made.every((n) => exists(path.join(dst, 'skills', n, 'SKILL.md'))))
    check('J1e 普通技能目录也还原了', exists(path.join(dst, 'skills/plain-skill/SKILL.md')))
    check('J1f 种子技能被清', !exists(path.join(dst, 'skills/builtin-skill')))
  }

  // ═════ J2：目标路径不存在（换机，外部仓库没带过来） ═════
  {
    const moved = []
    for (const n of made) {
      const from = path.join(extRoot, n)
      const to = `${from}-moved`
      fs.renameSync(from, to)
      moved.push([from, to])
    }
    const dst = path.join(root, 'dst-j2')
    w(dst, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
    const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: bundle })
    info('J2 还原结果', JSON.stringify({ ok: r.ok, relinked: r.relinked, symlinkAsCopy: r.symlinkAsCopy }))
    check('J2a 还原本身成功（不因链接目标缺失整体失败）', r.ok === true, String(r.ok))
    check('J2b 报告标注了降级', Array.isArray(r.symlinkAsCopy) && r.symlinkAsCopy.length === made.length,
      JSON.stringify(r.symlinkAsCopy))
    const skillGone = made.filter((n) => !exists(path.join(dst, 'skills', n)))
    const skillEmpty = made.filter((n) => exists(path.join(dst, 'skills', n)) && !exists(path.join(dst, 'skills', n, 'SKILL.md')))
    info('J2 技能目录状态', `不存在=${JSON.stringify(skillGone)} 存在但无内容=${JSON.stringify(skillEmpty)}`)
    /*
     * 核心判据：注释承诺「降级为实体副本」。
     * 若包里没有该目录的文件条目（scanHome 不跟进链接），stageHome 里也没有内容，
     * 那么"降级"什么都不会发生 —— 技能消失，而报告说"已降级为副本"。
     */
    check('J2c 降级后技能内容真的还在（SKILL.md 可读）',
      made.every((n) => exists(path.join(dst, 'skills', n, 'SKILL.md'))),
      `实际：不存在=${JSON.stringify(skillGone)} 空目录=${JSON.stringify(skillEmpty)}`)
    // 还原回去，避免影响后续
    for (const [from, to] of moved) fs.renameSync(to, from)
  }

  /*
   * ═════ J3：部分成功 —— 副本只落地了一部分，**不许报成「已降级为副本」** ═════
   *
   * 构造「清单说要 3 个文件、包里只有 1 个」的包：
   *   - `copyLinkTreeFromStage` 里另外 2 条会走 `!existsSync(src)` 分支；
   *   - 以前那条分支是 `continue`（静默），结果 `copied=1 > 0` → 报 `symlinkAsCopy`；
   *   - 用户看到「已降级为副本」，实际 3 个里只有 1 个，另外 2 个静默消失。
   *
   * 判据：`symlinkAsCopy` **不得**包含它；`symlinkIncomplete` 必须包含它并报出缺多少。
   * 这就是 M1「读失败/写失败不许伪装成没有/成功」在链接副本这条路径上的对应物。
   */
  {
    const { zipSync, strToU8 } = require('fflate')
    const partialBundle = path.join(root, 'partial.dbk')
    const mkFile = (rel, body) => ({ path: rel, size: strToU8(body).length })
    const only1 = 'SKILL.md'
    const manifestPartial = {
      format: 'devaplus-backup',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: 'probe',
      platform: process.platform,
      files: [{ path: 'config.json', size: strToU8('{}').length, sha256: '0'.repeat(64) }],
      dirs: [],
      symlinks: [{ path: 'skills/repo-p', target: path.join(root, 'ext-repos', 'repo-p') }],
      links: [
        {
          path: 'skills/repo-p',
          // 清单说有 3 个文件
          files: [mkFile(only1, '# p\n'), mkFile('a.md', 'aaa\n'), mkFile('b.md', 'bbb\n')].map((f) => ({
            ...f,
            sha256: '0'.repeat(64)
          })),
          dirs: []
        }
      ],
      excluded: [],
      hasSecrets: false
    }
    /*
     * 包里只放 1 个链接文件（+ 一个占位 config.json，让正常文件路径也有东西）。
     * `config.json` 的 sha256 用真值，避免在验哈希那步就先失败 —— 我们要验的是链接副本这条路径。
     */
    const crypto = require('crypto')
    const cfgBody = strToU8('{}')
    manifestPartial.files[0].sha256 = crypto.createHash('sha256').update(Buffer.from(cfgBody)).digest('hex')
    manifestPartial.links[0].files[0].sha256 = crypto
      .createHash('sha256')
      .update(strToU8('# p\n'))
      .digest('hex')

    fs.writeFileSync(partialBundle, Buffer.from(zipSync({
      'manifest.json': strToU8(JSON.stringify(manifestPartial)),
      'home/config.json': cfgBody,
      'links/skills/repo-p/SKILL.md': strToU8('# p\n')
      // a.md / b.md 故意不放 —— 复现「包里缺条目」
    })))

    // 目标不存在 repo-p 这个外部目录 → 走「降级为副本」分支
    const dst = path.join(root, 'dst-j3')
    w(dst, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
    const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: partialBundle })
    info(
      'J3 还原结果',
      JSON.stringify({
        ok: r.ok,
        symlinkAsCopy: r.symlinkAsCopy,
        symlinkIncomplete: r.symlinkIncomplete,
        symlinkUnrecovered: r.symlinkUnrecovered
      })
    )
    check('J3a 还原本身成功（部分失败不升级为整体失败）', r.ok === true,
      `ok=${r.ok} code=${r.code} msg=${String(r.message ?? '').slice(0, 120)}`)
    const asCopy = Array.isArray(r.symlinkAsCopy) ? r.symlinkAsCopy : []
    check('J3b 部分成功**不得**被报成「已降级为副本」', !asCopy.includes('skills/repo-p'),
      `symlinkAsCopy=${JSON.stringify(asCopy)}`)
    const incomplete = Array.isArray(r.symlinkIncomplete) ? r.symlinkIncomplete : []
    const rec = incomplete.find((x) => x && x.path === 'skills/repo-p')
    check('J3c 必须进 symlinkIncomplete 并报出条目', !!rec, JSON.stringify(incomplete))
    if (rec) {
      check('J3d 如实报缺多少个（3 条里成 1 条，缺 2）', rec.total === 3 && rec.copied === 1 && rec.missing === 2,
        `total=${rec.total} copied=${rec.copied} missing=${rec.missing}`)
    } else {
      bad('J3d 如实报缺多少个（3 条里成 1 条，缺 2）', 'J3c 未通过，无记录可比')
    }
    check('J3e 已成功的那 1 个文件确实落地了（不因部分失败而丢弃）',
      exists(path.join(dst, 'skills/repo-p', 'SKILL.md')),
      exists(path.join(dst, 'skills/repo-p', 'SKILL.md')) ? 'SKILL.md 在' : 'SKILL.md 不在')
  }

  return done(root)
}

function done(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(DIST, { recursive: true, force: true })
    console.log(`  （已清理临时目录 ${root}）`)
  } catch {}
  console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR', e)
  fail++
  console.log(`\n==RESULT== ${pass} PASS / ${fail} FAIL（异常中止）`)
  process.exit(1)
})
