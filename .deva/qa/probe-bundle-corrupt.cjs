/**
 * 证伪「旧密钥库损坏时仍能还原」。
 *
 * 设计意图（secrets.ts:248-264）：用户正是因为旧库坏了才来还原，
 * resetForRestore() 清内存守卫，好让 replaceAllSecrets 写得进去。
 *
 * 但 restoreBundle 第 6 步把 secrets.json 加进 keepSet（**不删**），
 * 所以磁盘上那份坏库原封不动；resetForRestore 只清内存，
 * 紧接着 replaceAllSecrets → ensureLoaded() 会**重新读盘**，又把 loadKind 判成 corrupt，
 * 于是拒绝写入 → 抛 RestoreError('write-failed') → 整个还原返回 ok:false。
 *
 * 而这时第 6/7 步（替换文件 + 重建链接）**已经执行完了** —— 用户数据已被覆盖。
 * 要验证的就是这个：坏旧库 → 还原失败，但数据已经变了。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const crypto = require('crypto')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-corrupt')

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
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12) : 'missing')
const exists = (p) => fs.existsSync(p)

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
export * as secrets from ${JSON.stringify(path.join(SRC, 'main/services/secrets.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'c.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'c.cjs'))
}

function w(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

async function main() {
  const mode = process.argv[2]
  const root = mode ? process.env.PROBE_ROOT : path.join(os.tmpdir(), `deva-corrupt-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  if (mode === 'export') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_SRC
    const r = await api.exportBundle({ targetPath: process.env.PROBE_BUNDLE })
    console.log(JSON.stringify({ ok: r.ok, files: r.files, msg: r.message }))
    return
  }
  if (mode === 'restore') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_HOME
    const r = await api.restoreBundle({ bundlePath: process.env.PROBE_BUNDLE, overwriteConfirmed: true })
    // 还原结束后，在同一进程里读一次密钥 —— 检查内存态与会话是否可用
    let readBack = null
    try {
      readBack = await api.secrets.readSecret('p1')
    } catch (e) {
      readBack = { error: e.message }
    }
    // 还原后再写一次密钥，看是否还能正常保存（时序问题的观测点）
    let writeAfter = null
    try {
      writeAfter = await api.secrets.setSecret('p2', 'sk-after-restore')
    } catch (e) {
      writeAfter = { error: e.message }
    }
    console.log(JSON.stringify({ restore: r, readBack, writeAfter }))
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
      return { ok: false, _raw: `${(r.stdout || '').slice(-500)}${(r.stderr || '').slice(-500)}` }
    }
  }

  // 源 home（正常、有密钥）
  const srcHome = path.join(root, 'src-home')
  fs.mkdirSync(srcHome, { recursive: true })
  w(srcHome, 'personas/deva.md', '# deva\n')
  w(srcHome, 'data/chats/s1.json', JSON.stringify({ id: 's1', messages: [] }))
  w(srcHome, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
  w(srcHome, 'config.json', JSON.stringify({ fromBundle: true }))
  const stub = require(path.join(QA, 'stubs', 'electron.cjs'))
  w(srcHome, 'secrets.json', JSON.stringify({ p1: stub.safeStorage.encryptString('sk-from-bundle').toString('base64') }))

  const bundle = path.join(root, 'c.dbk')
  const exp = runChild('export', { PROBE_SRC: srcHome, PROBE_BUNDLE: bundle })
  if (!exp.ok) {
    bad('导出失败', JSON.stringify(exp))
    return done(root)
  }
  ok('导出成功', `${exp.files} 文件`)

  // ═════ C1：目标里的旧密钥库是**损坏**的（用户正是因此来还原） ═════
  {
    const dst = path.join(root, 'dst-corrupt')
    w(dst, 'personas/lucy.md', '# lucy seed\n')
    w(dst, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
    w(dst, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
    w(dst, 'config.json', JSON.stringify({ local: true }))
    // 坏密钥库：不是合法 JSON
    w(dst, 'secrets.json', '{ this is not valid json')

    const cfgBefore = sha(path.join(dst, 'config.json'))
    const seedBefore = exists(path.join(dst, 'data/chats/seed.json'))
    const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: bundle })
    const restore = r.restore || {}
    info('C1 还原结果', JSON.stringify({ ok: restore.ok, code: restore.code, msg: restore.message }))
    const cfgAfter = sha(path.join(dst, 'config.json'))
    const seedAfter = exists(path.join(dst, 'data/chats/seed.json'))
    const secretsAfter = fs.existsSync(path.join(dst, 'secrets.json'))
      ? fs.readFileSync(path.join(dst, 'secrets.json'), 'utf8').slice(0, 40)
      : 'missing'

    check('C1a 旧密钥库损坏时还原仍然成功', restore.ok === true,
      `ok=${restore.ok} code=${restore.code} msg=${String(restore.message).slice(0, 120)}`)
    /*
     * 关键：如果还原失败，必须**没有动过**用户数据。否则用户陷入死局：
     * 数据已被覆盖、还原报失败、退路只剩自动备份。
     */
    if (restore.ok !== true) {
      const dataUnchanged = cfgBefore === cfgAfter && seedBefore === seedAfter
      check('C1b 还原失败时用户数据保持原样（未半途覆盖）', dataUnchanged,
        `config ${cfgBefore}→${cfgAfter}；种子会话 ${seedBefore}→${seedAfter}`)
      info('C1 失败后 secrets.json 内容开头', secretsAfter)
      /*
       * 半途失败后唯一的退路是 restore-backup-*。
       * 验证它是否真的在：如果连备份都没有，这个失败就是不可恢复的。
       */
      const parent = path.dirname(dst)
      const backups = fs.readdirSync(parent).filter((n) => n.includes('restore-backup'))
      info('C1 失败后自动备份目录', JSON.stringify(backups))
      for (const b of backups) {
        const bp = path.join(parent, b)
        const hasSeed = exists(path.join(bp, 'data/chats/seed.json'))
        const hasLucy = exists(path.join(bp, 'personas/lucy.md'))
        info(`  备份 ${b} 内容`, `seed=${hasSeed} lucy=${hasLucy}`)
      }
      check('C1c 失败时至少留下了可回退的自动备份', backups.length > 0, `${backups.length} 份`)
    } else {
      info('C1 还原成功，secrets.json 开头', secretsAfter)
      info('C1 同进程内读密钥', JSON.stringify(r.readBack))
      info('C1 同进程内再写密钥', JSON.stringify(r.writeAfter))
    }
  }

  // ═════ C2：对照组——旧密钥库正常时应成功 ═════
  {
    const dst = path.join(root, 'dst-ok')
    w(dst, 'personas/lucy.md', '# lucy seed\n')
    w(dst, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
    w(dst, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
    w(dst, 'secrets.json', JSON.stringify({ old: stub.safeStorage.encryptString('sk-old').toString('base64') }))
    const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: bundle })
    const restore = r.restore || {}
    info('C2 还原结果', JSON.stringify({ ok: restore.ok, code: restore.code, secrets: restore.secrets }))
    check('C2a 旧密钥库正常时还原成功', restore.ok === true, `ok=${restore.ok} code=${restore.code}`)
    check('C2b 还原后同进程内能读到包里的密钥', r.readBack && r.readBack.ok !== false && !r.readBack.error,
      JSON.stringify(r.readBack))
    check('C2c 还原后同进程内还能写入新密钥（resetForRestore 未造成时序问题）',
      r.writeAfter && r.writeAfter.ok !== false && !r.writeAfter.error, JSON.stringify(r.writeAfter))
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
