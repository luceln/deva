/**
 * 验证顶层**单文件**白名单（RESTORE_SCOPE_FILES）的清理与替换语义。
 * 覆盖：包里也有的单文件（应被替换）、包里有而目标没有（应创建）、包里没有的（应清掉）。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-files')

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
const read = (p) => (exists(p) ? fs.readFileSync(p, 'utf8') : null)

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'f.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'f.cjs'))
}

function w(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

async function main() {
  const mode = process.argv[2]
  const root = mode ? process.env.PROBE_ROOT : path.join(os.tmpdir(), `deva-files-${Date.now()}`)
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
    const r = await api.restoreBundle({ bundlePath: process.env.PROBE_BUNDLE, overwriteConfirmed: true })
    console.log(JSON.stringify(r))
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

  // 源 home：只有部分单文件
  const srcHome = path.join(root, 'src-home')
  fs.mkdirSync(srcHome, { recursive: true })
  w(srcHome, 'config.json', JSON.stringify({ fromBundle: true }))
  w(srcHome, 'tasks.json', JSON.stringify({ version: 1, tasks: [{ id: 'fromBundle' }] }))
  w(srcHome, 'memory.json', JSON.stringify({ version: 2 }))
  w(srcHome, 'data/chats/a.json', JSON.stringify({ id: 'a', messages: [] }))

  const bundle = path.join(root, 'f.dbk')
  const exp = runChild('export', { PROBE_SRC: srcHome, PROBE_BUNDLE: bundle })
  if (!exp.ok) {
    bad('导出失败', JSON.stringify(exp))
    return done(root)
  }
  ok('导出成功', `${exp.files} 文件`)

  // 目标 home：单文件各种情况
  const dst = path.join(root, 'dst')
  w(dst, 'config.json', JSON.stringify({ local: true })) // 包里也有 → 应被替换
  w(dst, 'tasks.json', JSON.stringify({ version: 1, tasks: [{ id: 'localOnly' }] })) // 包里也有 → 应被替换
  w(dst, 'read-state.json', JSON.stringify({ old: 1 })) // 包里没有 → 应清掉
  w(dst, 'worktrees.json', JSON.stringify({ records: [] })) // 包里没有 → 应清掉
  w(dst, 'mcp.json', JSON.stringify({ mcpServers: { local: 1 } })) // 包里没有 → 应清掉
  w(dst, 'memory.json', JSON.stringify({ version: 2 }))
  w(dst, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
  // 范围外的根文件：不该被删
  w(dst, 'notes.txt', 'user file outside scope')
  w(dst, 'deva-something.log', 'log')

  const r = runChild('restore', { PROBE_HOME: dst, PROBE_BUNDLE: bundle })
  info('还原结果', JSON.stringify({ ok: r.ok, removed: r.removedStale }))

  check('F1 还原成功', r.ok === true, String(r.ok))
  check('F2 config.json 被替换为包内容', (() => {
    try {
      return JSON.parse(read(path.join(dst, 'config.json'))).fromBundle === true
    } catch {
      return false
    }
  })(), read(path.join(dst, 'config.json')))
  check('F3 tasks.json 被替换为包内容（不是保留本地）', (() => {
    try {
      return JSON.parse(read(path.join(dst, 'tasks.json'))).tasks[0].id === 'fromBundle'
    } catch {
      return false
    }
  })(), read(path.join(dst, 'tasks.json')))
  check('F4 read-state.json（包内没有）被清掉', !exists(path.join(dst, 'read-state.json')))
  check('F5 worktrees.json（包内没有）被清掉', !exists(path.join(dst, 'worktrees.json')))
  check('F6 mcp.json（包内没有）被清掉', !exists(path.join(dst, 'mcp.json')))
  check('F7 范围外的根文件 notes.txt 未被删', exists(path.join(dst, 'notes.txt')), '用户杂项文件')
  check('F8 范围外的根文件 deva-something.log 未被删', exists(path.join(dst, 'deva-something.log')))

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
