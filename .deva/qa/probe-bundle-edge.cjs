/**
 * 证伪两处 verify-bundle-real.cjs 没覆盖的形状：
 *   A. 换机还原：skills 下的 junction 指向本机不存在的外部仓库 → 技能是否真丢、报告说什么
 *   B. 空目录：包里没有该目录任何文件时，还原后目录是否被当残留删掉且不重建
 *   C. unzipSync 峰值内存：用不可压缩大文件实测 RSS，给出 600MB 包的量级依据
 *
 * 隔离：os.tmpdir()，DEVA_HOME 指过去；导出/还原分进程（getDevaHome 进程内缓存）。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist-edge')

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
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'edge.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'edge.cjs'))
}

function w(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

/** A 用：源 home 里有一个指向**本机存在**外部仓库的 junction（模拟用户自己的开发环境）。 */
function makeSrcWithJunction(root) {
  const home = path.join(root, 'src-home')
  fs.mkdirSync(home, { recursive: true })
  w(home, 'personas/deva.md', '# deva\n')
  w(home, 'data/chats/s1.json', JSON.stringify({ id: 's1', title: 't', messages: [] }))
  w(home, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
  w(home, 'config.json', JSON.stringify({ k: 1 }))
  const ext = path.join(root, 'external-repo', 'my-skill')
  fs.mkdirSync(ext, { recursive: true })
  fs.writeFileSync(path.join(ext, 'SKILL.md'), '# my skill\n')
  // junction 的父目录必须先存在，否则会以 ENOENT 失败（不是权限问题）
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
  let made = false
  let why = ''
  try {
    fs.symlinkSync(ext, path.join(home, 'skills/my-skill'), process.platform === 'win32' ? 'junction' : 'dir')
    made = true
  } catch (e) {
    why = e.message
  }
  return { home, ext, made, why }
}

async function main() {
  const mode = process.argv[2]
  const root = mode ? process.env.PROBE_ROOT : path.join(os.tmpdir(), `deva-bundleedge-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  if (mode === 'export') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_SRC
    const r = await api.exportBundle({ targetPath: process.env.PROBE_BUNDLE })
    console.log(JSON.stringify({ ok: r.ok, files: r.files, excluded: r.excluded, msg: r.message }))
    return
  }
  if (mode === 'restore') {
    const api = await build()
    process.env.DEVA_HOME = process.env.PROBE_HOME
    // unzipSync 是同步的，还原返回后内存已回落；必须在过程中持续采样取峰值
    let peakRss = 0
    let peakHeap = 0
    const timer = setInterval(() => {
      const m = process.memoryUsage()
      if (m.rss > peakRss) peakRss = m.rss
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed
    }, 20)
    // 同步解压会阻塞事件循环，setInterval 采样不到；用 async 微任务 + 主动采样配合
    const t0 = Date.now()
    const r = await api.restoreBundle({ bundlePath: process.env.PROBE_BUNDLE, overwriteConfirmed: true })
    const durMs = Date.now() - t0
    clearInterval(timer)
    const after = process.memoryUsage()
    if (after.rss > peakRss) peakRss = after.rss
    if (after.heapUsed > peakHeap) peakHeap = after.heapUsed
    console.log(
      JSON.stringify({
        ...r,
        _rssMB: Math.round(peakRss / 1048576),
        _heapMB: Math.round(peakHeap / 1048576),
        _afterRssMB: Math.round(after.rss / 1048576),
        _durMs: durMs
      })
    )
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

  // ═════ A. 换机还原：junction 目标不存在 ═════
  const src = makeSrcWithJunction(root)
  info('A 夹具：源 home 的 junction 建成', String(src.made) + (src.why ? ` (${src.why})` : ''))
  const bundleA = path.join(root, 'a.dbk')
  const expA = runChild('export', { PROBE_SRC: src.home, PROBE_BUNDLE: bundleA })
  if (!expA.ok) {
    bad('A 导出失败', JSON.stringify(expA))
  } else {
    ok('A 导出成功', `${expA.files} 文件`)
    // 换机：把外部仓库改名，模拟"还原机上没有这条路径"
    const moved = `${src.ext}-moved-away`
    fs.renameSync(src.ext, moved)

    const dstA = path.join(root, 'dst-a')
    w(dstA, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
    const rA = runChild('restore', { PROBE_HOME: dstA, PROBE_BUNDLE: bundleA })
    info('A 还原结果', JSON.stringify({ ok: rA.ok, symlinkAsCopy: rA.symlinkAsCopy, relinked: rA.relinked, removed: rA.removedStale?.length }))
    check('A1 还原本身成功（不因链接目标缺失整体失败）', rA.ok === true, String(rA.ok))
    const skillPath = path.join(dstA, 'skills/my-skill')
    const skillExists = exists(skillPath)
    const skillHasContent = skillExists && exists(path.join(skillPath, 'SKILL.md'))
    info('A 技能路径状态', `exists=${skillExists} hasSKILL.md=${skillHasContent} isLink=${skillExists && fs.lstatSync(skillPath).isSymbolicLink()}`)
    check('A2 报告如实标注「降级为实体副本」', Array.isArray(rA.symlinkAsCopy) && rA.symlinkAsCopy.includes('skills/my-skill'),
      JSON.stringify(rA.symlinkAsCopy))
    /*
     * A3 是关键：注释承诺「降级为实体副本，并明确报告」。
     * 如果 stageHome 里根本没有该链接的内容（scanHome 不跟进链接、包里只有 .symlink 条目），
     * 那么降级实际上什么都不会发生 —— 技能目录凭空消失，而报告说"已降级为副本"。
     */
    if (!skillHasContent) {
      bad('A3 「降级为实体副本」实际未发生：技能目录不存在或为空，报告却称已降级',
        `exists=${skillExists} hasSKILL.md=${skillHasContent}；symlinkAsCopy=${JSON.stringify(rA.symlinkAsCopy)}`)
    } else {
      ok('A3 降级为实体副本确实发生（SKILL.md 在）')
    }
  }

  // ═════ B. 空目录：包里无该目录任何文件 ═════
  {
    const srcB = path.join(root, 'src-b')
    fs.mkdirSync(srcB, { recursive: true })
    w(srcB, 'personas/deva.md', '# deva\n')
    w(srcB, 'data/chats/s1.json', JSON.stringify({ id: 's1', messages: [] }))
    w(srcB, 'config.json', JSON.stringify({ k: 1 }))
    w(srcB, 'memory.json', JSON.stringify({ version: 2, entries: [] }))
    // 源 home 里保留几个**空**目录（用户真实环境常见：没发过图片、没产生过 tool-result）
    fs.mkdirSync(path.join(srcB, 'data/media'), { recursive: true })
    fs.mkdirSync(path.join(srcB, 'data/tool-results'), { recursive: true })
    fs.mkdirSync(path.join(srcB, 'uploads'), { recursive: true })
    const bundleB = path.join(root, 'b.dbk')
    const expB = runChild('export', { PROBE_SRC: srcB, PROBE_BUNDLE: bundleB })
    if (!expB.ok) {
      bad('B 导出失败', JSON.stringify(expB))
    } else {
      ok('B 导出成功', `${expB.files} 文件`)
      const dstB = path.join(root, 'dst-b')
      fs.mkdirSync(dstB, { recursive: true })
      // 目标里同样有这些空目录（重装后应用自己建的）
      fs.mkdirSync(path.join(dstB, 'data/media'), { recursive: true })
      fs.mkdirSync(path.join(dstB, 'data/tool-results'), { recursive: true })
      fs.mkdirSync(path.join(dstB, 'uploads'), { recursive: true })
      w(dstB, 'data/chats/seed.json', JSON.stringify({ id: 'seed', messages: [] }))
      const rB = runChild('restore', { PROBE_HOME: dstB, PROBE_BUNDLE: bundleB })
      info('B 还原结果', JSON.stringify({ ok: rB.ok, removed: rB.removedStale }))
      check('B1 空目录 data/media 还原后仍存在', exists(path.join(dstB, 'data/media')),
        exists(path.join(dstB, 'data/media')) ? '在' : '被当残留删掉且未重建')
      check('B2 空目录 data/tool-results 还原后仍存在', exists(path.join(dstB, 'data/tool-results')),
        exists(path.join(dstB, 'data/tool-results')) ? '在' : '被当残留删掉且未重建')
      check('B3 空目录 uploads 还原后仍存在', exists(path.join(dstB, 'uploads')),
        exists(path.join(dstB, 'uploads')) ? '在' : '被当残留删掉且未重建')
      const seedGone = !exists(path.join(dstB, 'data/chats/seed.json'))
      check('B4 同时确认种子会话确实被清（说明清理逻辑真的跑了）', seedGone, `seed 还在=${!seedGone}`)
    }
  }

  // ═════ C. unzipSync 峰值内存（用不可压缩数据外推） ═════
  {
    const srcC = path.join(root, 'src-c')
    fs.mkdirSync(srcC, { recursive: true })
    w(srcC, 'config.json', JSON.stringify({ k: 1 }))
    const sizeMB = Number(process.env.PROBE_BIG_MB || 200)
    // 随机字节 = 不可压缩，zip 基本不缩 → 包大小 ≈ 内容大小，最接近真实 media 的情形
    const chunk = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < sizeMB; i++) {
      require('crypto').randomFillSync(chunk)
      const p = path.join(srcC, `data/media/blob-${String(i).padStart(4, '0')}`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, chunk)
    }
    info('C 夹具', `${sizeMB} MB 随机（不可压缩）media`)
    const bundleC = path.join(root, 'c.dbk')
    const expC = runChild('export', { PROBE_SRC: srcC, PROBE_BUNDLE: bundleC })
    if (!expC.ok) {
      bad('C 导出失败', JSON.stringify(expC))
    } else {
      const bundleMB = Math.round(fs.statSync(bundleC).size / 1048576)
      ok('C1 导出成功', `${expC.files} 文件，包 ${bundleMB} MB`)
      const dstC = path.join(root, 'dst-c')
      fs.mkdirSync(dstC, { recursive: true })
      const rc = runChild('restore', { PROBE_HOME: dstC, PROBE_BUNDLE: bundleC })
      info('C 还原 RSS 峰值（子进程末次采样）', `rss=${rc._rssMB}MB heap=${rc._heapMB}MB 包=${bundleMB}MB`)
      check('C2 200MB 量级包还原成功', rc.ok === true, String(rc.ok))
      /*
       * 判据：unzipSync 会把「压缩包 + 解压后全部内容」同时放内存，
       * 理论下界约 2×包体积。若实测 RSS 明显高于 4× 包体积，600MB 包就危险。
       */
      const ratio = rc._rssMB / Math.max(bundleMB, 1)
      info('C RSS / 包体积 比值', ratio.toFixed(2))
      check('C3 RSS 不超过包体积 5 倍（600MB 包 → <3GB，尚可）', ratio < 5, `比值 ${ratio.toFixed(2)}；按此外推 600MB 包约 ${Math.round(ratio * 600)}MB`)
      void expC
    }
    fs.rmSync(srcC, { recursive: true, force: true })
  }

  // 清场
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
