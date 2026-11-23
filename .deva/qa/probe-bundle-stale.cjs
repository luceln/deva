/**
 * 备份包「残留清理 / 链接 / 幂等 / 会话不变式」的独立证伪脚本。
 *
 * 与 verify-bundle-real.cjs 的分工：那个脚本覆盖 E1–E14（导出、排除、哈希、zip slip、密钥段），
 * **没有**覆盖 findStaleEntries 的残留与误删、cpPreservingLinks 的各种链接形状、连还原三次的幂等性、
 * compacted.count 不变式。这里只打这些空档。
 *
 * 隔离：所有夹具在 os.tmpdir() 下，DEVA_HOME 指过去；safeStorage 用 QA 替身。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-stale')

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
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const exists = (p) => fs.existsSync(p)
const lsdir = (p) => (exists(p) ? fs.readdirSync(p).sort() : [])

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { restoreBundle, RestoreError } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-import.ts'))}
export { scanHome } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-manifest.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'stale.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'stale.cjs'))
}

/** 造一份「导出侧」home：含会话、compact 分片、media、personas、skills、profile、uploads、config 等。 */
function makeSourceHome(root) {
  const home = path.join(root, 'src-home')
  const w = (rel, body) => {
    const abs = path.join(home, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  fs.mkdirSync(home, { recursive: true })

  // 会话：一条普通 + 一条带 compacted 分片
  const s1 = {
    id: 's_ok',
    title: '正常会话',
    model: 'p/m',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'user', content: 'hi' }]
  }
  w('data/chats/s_ok.json', JSON.stringify(s1))
  const tail = [
    { role: 'user', content: 'after-1' },
    { role: 'assistant', content: 'ok-1' }
  ]
  const older = [{ role: 'user', content: 'before-1' }]
  w('data/chats/s_comp.json', JSON.stringify({ ...s1, id: 's_comp', compacted: { count: older.length, file: 's_comp.compacted-1.jsonl' }, messages: tail }))
  w('data/chats/s_comp.compacted-1.jsonl', older.map((m) => JSON.stringify(m)).join('\n') + '\n')

  // 媒体（内容寻址）
  const mediaBytes = Buffer.from('MEDIA-BYTES-0123456789')
  const mediaHash = crypto.createHash('sha256').update(mediaBytes).digest('hex')
  w(`data/media/${mediaHash}`, mediaBytes)

  // 其他用户数据
  w('personas/deva.md', '# deva\n')
  w('skills/demo/SKILL.md', '# demo\n')
  w('projects/p1/index.json', '{"p":1}')
  w('profile/avatar.png', Buffer.from([1, 2, 3]))
  w('uploads/up1.bin', Buffer.from('upload'))
  w('memory.json', JSON.stringify({ version: 2, entries: [{ id: 'm1', text: 'x' }] }))
  w('mcp.json', JSON.stringify({ mcpServers: {} }))
  w('tasks.json', JSON.stringify({ version: 1, tasks: [] }))
  w('read-state.json', JSON.stringify({ 's_1': 1 }))
  w('config.json', JSON.stringify({ fromBundle: true, theme: 'dark' }))
  // worktrees.json 与真实 worktrees 目录
  w('worktrees.json', JSON.stringify({ schemaVersion: 1, records: [] }))
  w('worktrees/abc/keep.txt', 'user-code\n')

  // 密钥段
  const stub = require(path.join(QA, 'stubs', 'electron.cjs'))
  w('secrets.json', JSON.stringify({ p1: stub.safeStorage.encryptString('sk-qa').toString('base64') }))

  // 排除项
  w('data/chats/_index.json', '{"stale":true}')
  w('data/chats/_index.dirty', '')
  w('import.lock', '')
  w('.magpie-agent.json', '{"providerId":"magpie"}')

  return { home, mediaHash, mediaBytes }
}

/**
 * 造「还原目标」home：模拟重装后的种子数据 + 各种残留形状。
 * 关键点：这批残留必须落在 RESTORE_SCOPE 之内，否则测不到清理逻辑。
 */
function makeTargetHome(root) {
  const home = path.join(root, 'dst-home')
  const w = (rel, body) => {
    const abs = path.join(home, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  fs.mkdirSync(home, { recursive: true })

  // 种子数据（包里没有 → 应被清掉）
  w('personas/lucy.md', '# lucy seed\n')
  w('skills/builtin/SKILL.md', '# builtin seed\n')
  w('data/chats/s_seed.json', JSON.stringify({ id: 's_seed', messages: [] }))
  // 深层残留（包里没有 → 应整棵被清）
  w('data/chats/nested/deep/gone.json', '{}')
  // 空目录残留
  fs.mkdirSync(path.join(home, 'data/tool-results'), { recursive: true })
  // 符号链接指向目录（包里没有 → 应被清，且不能顺着链接删到外面）
  const outside = path.join(root, 'outside-precious')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'DO-NOT-DELETE\n')
  let linkMade = false
  try {
    fs.symlinkSync(outside, path.join(home, 'data/chats/link-out'), process.platform === 'win32' ? 'junction' : 'dir')
    linkMade = true
  } catch (e) {
    info('目标侧链接夹具未建成', e.message)
  }

  // 不该被删的：worktrees 目录、magpie 状态
  w('worktrees/abc/local.txt', 'local code\n')
  w('.magpie-agent.json', '{"providerId":"magpie-local"}')

  // 让 hasAnyUserData() 返回 true，从而必须传 overwriteConfirmed
  w('memory.json', JSON.stringify({ version: 2, entries: [] }))

  return { home, outside, linkMade }
}

async function main() {
  const mode = process.argv[2]
  const root = mode ? process.env.PROBE_ROOT : path.join(os.tmpdir(), `deva-bundlestale-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  if (mode === 'export') {
    // 独立进程：getDevaHome() 有模块级缓存，导出与还原必须分开跑
    const src = makeSourceHome(root)
    const api = await build()
    process.env.DEVA_HOME = src.home
    const bundle = path.join(root, 'b.dbk')
    const exp = await api.exportBundle({ targetPath: bundle })
    console.log(JSON.stringify({ ok: exp.ok, files: exp.files, bytes: exp.bytes, excluded: exp.excluded, mediaHash: src.mediaHash, mediaBytesB64: src.mediaBytes.toString('base64') }))
    return
  }
  if (mode === 'restore') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_HOME
    const bundle = process.env.PROBE_BUNDLE
    const r = await api.restoreBundle({ bundlePath: bundle, overwriteConfirmed: true })
    console.log(JSON.stringify(r))
    return
  }

  // 主控：两次独立子进程 + 单进程内做断言
  const src = makeSourceHome(root)
  const bundle = path.join(root, 'b.dbk')
  const runChild = (m, extraEnv) =>
    require('child_process').spawnSync(process.execPath, [__filename, m], {
      encoding: 'utf8',
      env: { ...process.env, PROBE_ROOT: root, PROBE_HOME: '', PROBE_BUNDLE: bundle, ...extraEnv },
      windowsHide: true
    })
  const expRun = runChild('export', { DEVA_HOME: src.home })
  const expLine = (expRun.stdout || '').trim().split('\n').pop()
  let expInfo
  try {
    expInfo = JSON.parse(expLine)
  } catch {
    bad('导出子进程失败', `${expRun.stdout}${expRun.stderr}`.slice(-500))
    return done(root)
  }
  if (!expInfo.ok) {
    bad('导出失败，后续无法验证', JSON.stringify(expInfo))
    return done(root)
  }
  ok('导出成功', `${expInfo.files} 文件 / ${expInfo.bytes} 字节`)
  const { unzipSync } = require('fflate')
  const entries = unzipSync(new Uint8Array(fs.readFileSync(bundle)))
  const inBundle = Object.keys(entries).filter((k) => k.startsWith('home/')).map((k) => k.slice(5))
  info('包内条目（home 前缀）', `${inBundle.length} 条`)
  info('包内顶层', JSON.stringify([...new Set(inBundle.map((p) => p.split('/')[0]))].sort()))
  info('导出报告 excluded', JSON.stringify(expInfo.excluded))

  // ── S1：包内文件 vs 真实 home 应导集合（逐条比对，不只比数量） ──
  const scan = await (await build()).scanHome(src.home)
  const scanPaths = scan.files.map((f) => f.path).sort()
  const bundlePaths = inBundle.filter((p) => !p.endsWith('.symlink')).sort()
  const missingInBundle = scanPaths.filter((p) => !bundlePaths.includes(p))
  const extraInBundle = bundlePaths.filter((p) => !scanPaths.includes(p))
  check('S1 扫描集合与包内文件集合完全一致（逐条）', missingInBundle.length === 0 && extraInBundle.length === 0,
    `缺=${JSON.stringify(missingInBundle)} 多=${JSON.stringify(extraInBundle)}`)

  /*
   * S2：独立算出「真实 home 里哪些文件必须进包」，与包内集合比。
   * 不依赖被测的 scanHome —— 否则两侧同时漏同一类文件时仍然相等（E2b 只比数量的问题）。
   */
  const expected = []
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.name === '_index.json' || ent.name === '_index.dirty' || ent.name === 'import.lock') continue
      if (ent.name === 'secrets.json') continue
      if (ent.name.startsWith('.magpie-agent')) continue
      const st = fs.lstatSync(abs)
      if (st.isSymbolicLink()) {
        expected.push(`${rel}.symlink`)
        continue
      }
      if (st.isDirectory()) walk(abs, rel)
      else expected.push(rel)
    }
  }
  walk(src.home, '')
  const expSorted = expected.sort()
  const missed = expSorted.filter((p) => !inBundle.includes(p))
  check('S2 独立枚举与包内集合逐条一致', missed.length === 0, `漏掉=${JSON.stringify(missed)}`)

  // ── 还原到目标 home ──
  const tgt = makeTargetHome(root)
  process.env.DEVA_HOME = tgt.home
  const backupsBefore = lsdir(path.dirname(tgt.home)).filter((n) => n.includes('restore-backup'))
  const restoreOnce = () => {
    const run = runChild('restore', { PROBE_HOME: tgt.home })
    const line = (run.stdout || '').trim().split('\n').pop()
    try {
      return JSON.parse(line)
    } catch {
      return { ok: false, code: 'child-failed', message: `${run.stdout}${run.stderr}`.slice(-400) }
    }
  }
  const r1 = restoreOnce()
  info('第 1 次还原结果', JSON.stringify({ ok: r1.ok, code: r1.code, files: r1.files, removed: r1.removedStale?.length }))
  if (!r1.ok) {
    bad('第 1 次还原失败，后续无法验证', JSON.stringify(r1))
    return done(root)
  }
  ok('第 1 次还原成功', `files=${r1.files} removedStale=${r1.removedStale.length}`)

  // ── S3：残留清理 ──
  check('S3a 种子角色被清（personas/lucy.md 不存在）', !exists(path.join(tgt.home, 'personas/lucy.md')))
  check('S3b 种子技能被清（skills/builtin 不存在）', !exists(path.join(tgt.home, 'skills/builtin')))
  check('S3c 种子会话被清（s_seed 不存在）', !exists(path.join(tgt.home, 'data/chats/s_seed.json')))
  check('S3d 深层残留被整棵清（data/chats/nested 不存在）', !exists(path.join(tgt.home, 'data/chats/nested')))
  check('S3e 空目录残留被清（data/tool-results 不存在）', !exists(path.join(tgt.home, 'data/tool-results')))
  if (tgt.linkMade) {
    check('S3f 指向外部的目录链接被清', !exists(path.join(tgt.home, 'data/chats/link-out')))
    check('S3g 链接指向的外部内容未被误删', exists(path.join(tgt.outside, 'precious.txt')),
      exists(path.join(tgt.outside, 'precious.txt')) ? 'precious.txt 还在' : '外部目录被删了！')
  } else {
    info('S3f/S3g 跳过（链接夹具未建成）')
  }

  // ── S4：不该删的必须还在 ──
  check('S4a worktrees/ 用户代码未被删', exists(path.join(tgt.home, 'worktrees/abc/keep.txt')),
    lsdir(path.join(tgt.home, 'worktrees/abc')).join(',') || '(空)')
  check('S4b .magpie-agent.json 未被删', exists(path.join(tgt.home, '.magpie-agent.json')))

  // ── S5：还原内容正确 ──
  check('S5a 会话文件已还原', exists(path.join(tgt.home, 'data/chats/s_ok.json')))
  check('S5b compact 分片已还原', exists(path.join(tgt.home, 'data/chats/s_comp.compacted-1.jsonl')))
  const mediaAfter = path.join(tgt.home, `data/media/${src.mediaHash}`)
  check('S5c media 内容寻址文件还原且字节一致',
    exists(mediaAfter) && Buffer.compare(fs.readFileSync(mediaAfter), src.mediaBytes) === 0)
  check('S5d config.json 被替换为包内容', (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tgt.home, 'config.json'), 'utf8')).fromBundle === true
    } catch {
      return false
    }
  })())
  check('S5e uploads 目录还原', exists(path.join(tgt.home, 'uploads/up1.bin')))
  check('S5f profile 目录还原', exists(path.join(tgt.home, 'profile/avatar.png')))
  check('S5g _index.json 未被还原进来', !exists(path.join(tgt.home, 'data/chats/_index.json')))

  // ── S6：compacted.count 不变式 ──
  {
    const main = JSON.parse(fs.readFileSync(path.join(tgt.home, 'data/chats/s_comp.json'), 'utf8'))
    const lines = fs
      .readFileSync(path.join(tgt.home, 'data/chats/s_comp.compacted-1.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
    check('S6a compacted.count 等于分片行数', main.compacted?.count === lines.length,
      `count=${main.compacted?.count} 行数=${lines.length}`)
    check('S6b 主文件只存压缩边界之后的消息', Array.isArray(main.messages) && main.messages.length === 2,
      `messages=${main.messages?.length}`)
  }

  // ── S7：幂等性（连还原三次） ──
  const snap = () => {
    const out = {}
    const rec = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name
        const abs = path.join(dir, ent.name)
        const st = fs.lstatSync(abs)
        if (st.isSymbolicLink()) out[rel] = 'link'
        else if (st.isDirectory()) rec(abs, rel)
        else if (rel === 'secrets.json') {
          /*
           * 密文每次都会变（safeStorage 每次 encryptString 用新随机 IV），但**明文必须一致**。
           * 直接比密文哈希会把正常加密噪声当成幂等性缺陷——那是假红。
           */
          try {
            const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
            const stub = require(path.join(QA, 'stubs', 'electron.cjs'))
            const plain = {}
            for (const [k, v] of Object.entries(raw.secrets ?? raw)) {
              plain[k] = stub.safeStorage.decryptString(Buffer.from(v, 'base64'))
            }
            out[rel] = `plain:${JSON.stringify(plain)}`
          } catch (e) {
            out[rel] = `unreadable:${e.message}`
          }
        } else out[rel] = sha(abs)
      }
    }
    rec(tgt.home, '')
    return out
  }
  const secretsCipherHash = () => sha(path.join(tgt.home, 'secrets.json'))
  const snap1 = snap()
  const r2 = restoreOnce()
  const snap2 = snap()
  const r3 = restoreOnce()
  const snap3 = snap()
  info('第 2/3 次还原', JSON.stringify({ r2: r2.ok, r3: r3.ok }))
  const diffKeys = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    const d = []
    for (const k of keys) if (a[k] !== b[k]) d.push({ k, a: a[k], b: b[k] })
    return d
  }
  const d12 = diffKeys(snap1, snap2)
  const d23 = diffKeys(snap2, snap3)
  check('S7a 第 2 次还原后 home 内容与第 1 次完全一致（secrets 按明文比）', d12.length === 0, JSON.stringify(d12.slice(0, 5)))
  check('S7b 第 3 次还原后 home 内容与第 2 次完全一致（secrets 按明文比）', d23.length === 0, JSON.stringify(d23.slice(0, 5)))
  info('secrets.json 密文哈希（三次各不相同属正常：每次 encryptString 新 IV）', JSON.stringify([snap1['secrets.json'], snap2['secrets.json'], snap3['secrets.json']]).slice(0, 120))
  void secretsCipherHash

  const backupsAfter = lsdir(path.dirname(tgt.home)).filter((n) => n.includes('restore-backup'))
  info('restore-backup 目录', JSON.stringify(backupsAfter))
  check('S7c 每次覆盖前都留了备份（3 次还原 → 3 份）', backupsAfter.length === 3, `实际 ${backupsAfter.length} 份`)
  const bkSizes = backupsAfter.map((n) => {
    let c = 0
    const walkCount = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isSymbolicLink()) c++
        else if (e.isDirectory()) walkCount(p)
        else c++
      }
    }
    try {
      walkCount(path.join(path.dirname(tgt.home), n))
    } catch {
      return -1
    }
    return c
  })
  info('各备份条目数', JSON.stringify(bkSizes))

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
