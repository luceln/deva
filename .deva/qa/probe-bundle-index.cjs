/**
 * 证伪「还原完立刻进会话列表会不会缺项」（任务书第 7 点）。
 *
 * _index.json 被排除在包外是正确的（派生索引），但还原后必须能自愈重建。
 * 直接调 chat-store 的 listSessions / ensureIndex 看索引是否真的重建出来。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-index')

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
export * as chatStore from ${JSON.stringify(path.join(SRC, 'main/services/chat-store.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'i.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'i.cjs'))
}

function w(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

async function main() {
  const mode = process.argv[2]
  const root = mode ? process.env.PROBE_ROOT : path.join(os.tmpdir(), `deva-index-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  if (mode === 'export') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_SRC
    const r = await api.exportBundle({ targetPath: process.env.PROBE_BUNDLE })
    console.log(JSON.stringify({ ok: r.ok, files: r.files }))
    return
  }
  if (mode === 'restore') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_HOME
    // 还原前先把会话列一遍，模拟「用户在旧数据上开着列表」→ sessionCache/indexCache 都被暖过
    let before = null
    try {
      before = (await api.chatStore.listSessions()).map((s) => s.id)
    } catch (e) {
      before = { error: e.message }
    }
    const r = await api.restoreBundle({ bundlePath: process.env.PROBE_BUNDLE, overwriteConfirmed: true })
    // 还原后立刻（同一进程）再列一次
    let after = null
    try {
      after = (await api.chatStore.listSessions()).map((s) => s.id)
    } catch (e) {
      after = { error: e.message }
    }
    const idxPath = path.join(process.env.PROBE_HOME, 'data/chats/_index.json')
    const idxExists = exists(idxPath)
    let idxIds = null
    if (idxExists) {
      try {
        idxIds = JSON.parse(fs.readFileSync(idxPath, 'utf8')).map((x) => x.id)
      } catch (e) {
        idxIds = { error: e.message }
      }
    }
    // 再列一次，看是否稳定（第二次走缓存）
    let again = null
    try {
      again = (await api.chatStore.listSessions()).map((s) => s.id)
    } catch (e) {
      again = { error: e.message }
    }
    console.log(JSON.stringify({ restore: { ok: r.ok, code: r.code }, before, after, again, idxExists, idxIds }))
    return
  }

  const runChild = (m, env) => {
    const r = cp.spawnSync(process.execPath, [__filename, m], {
      encoding: 'utf8',
      env: { ...process.env, PROBE_ROOT: root, ...env },
      windowsHide: true,
      timeout: 600000
    })
    const line = (r.stdout || '').trim().split('\n').pop()
    try {
      return JSON.parse(line)
    } catch {
      return { ok: false, _raw: `${(r.stdout || '').slice(-400)}${(r.stderr || '').slice(-400)}` }
    }
  }

  const srcHome = path.join(root, 'src-home')
  fs.mkdirSync(srcHome, { recursive: true })
  w(srcHome, 'personas/deva.md', '# deva\n')
  const ids = ['s_alpha', 's_beta', 's_gamma']
  for (const id of ids) {
    w(srcHome, `data/chats/${id}.json`, JSON.stringify({ id, title: `t-${id}`, model: 'p/m', createdAt: 1, updatedAt: 2, messages: [] }))
  }
  w(srcHome, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
  w(srcHome, 'config.json', JSON.stringify({ k: 1 }))

  const bundle = path.join(root, 'i.dbk')
  const exp = runChild('export', { PROBE_SRC: srcHome, PROBE_BUNDLE: bundle })
  if (!exp.ok) {
    bad('导出失败', JSON.stringify(exp))
    return done(root)
  }
  ok('导出成功', `${exp.files} 文件`)

  const dst = path.join(root, 'dst')
  // 旧数据：两条会话 + 一份过期的 _index.json（模拟"卸载前留下的索引"）
  w(dst, 'data/chats/s_old1.json', JSON.stringify({ id: 's_old1', title: 'old1', messages: [] }))
  w(dst, 'data/chats/s_old2.json', JSON.stringify({ id: 's_old2', title: 'old2', messages: [] }))
  w(dst, 'data/chats/_index.json', JSON.stringify([{ id: 's_old1', title: 'old1' }, { id: 's_old2', title: 'old2' }]))
  w(dst, 'memory.json', JSON.stringify({ version: 2, entries: [] }))

  const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: bundle })
  info('还原结果', JSON.stringify(r.restore))
  info('还原前列表（暖缓存）', JSON.stringify(r.before))
  info('还原后立刻列表', JSON.stringify(r.after))
  info('再列一次', JSON.stringify(r.again))
  info('_index.json 存在', String(r.idxExists))
  info('_index.json 内容 id', JSON.stringify(r.idxIds))

  check('I1 还原成功', r.restore.ok === true, JSON.stringify(r.restore))
  check('I2 还原后列表恰好是包内 3 条（无缺项、无旧项）',
    Array.isArray(r.after) && r.after.length === ids.length && ids.every((i) => r.after.includes(i)),
    JSON.stringify(r.after))
  check('I3 旧会话没混进列表', Array.isArray(r.after) && !r.after.includes('s_old1') && !r.after.includes('s_old2'),
    JSON.stringify(r.after))
  check('I4 索引已自愈重建到磁盘', r.idxExists === true, `_index.json=${r.idxExists}`)
  check('I5 重建的索引内容与列表一致',
    Array.isArray(r.idxIds) && r.idxIds.length === ids.length, JSON.stringify(r.idxIds))
  check('I6 第二次列表与第一次一致（缓存稳定，不是靠每次现扫）',
    JSON.stringify(r.after) === JSON.stringify(r.again), `${JSON.stringify(r.after)} vs ${JSON.stringify(r.again)}`)

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
