/**
 * 任务书第 1 点：E2b 只比数量，两侧同时漏掉同一类文件仍会 PASS。
 * 这里在**真实 ~/.deva-plus**（只读）上做逐条比对：
 *   独立 walk（自己实现排除规则）+ scanHome 结果，逐条 diff。
 * 不跟 junction（真实 skills 下 3 条 junction 指向 E:\toolkit 等外部仓库）。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const OUT = path.join(os.tmpdir(), 'scanreal-cmp.cjs')

const HOME = process.argv[2] || 'C:/Users/lucel/.deva-plus'

;(async () => {
  await esbuild.build({
    entryPoints: [path.join(SRC, 'main/services/bundle-manifest.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: OUT,
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  const { scanHome } = require(OUT)

  const t0 = Date.now()
  const scan = await scanHome(HOME)
  const scanMs = Date.now() - t0
  const scanPaths = new Set(scan.files.map((f) => f.path))
  const scanLinks = new Set(scan.symlinks.map((s) => s.path))

  // 独立实现：自己按真实排除规则走一遍，不复用被测代码
  const EXCLUDED_FILES = new Set([
    '_index.json',
    '_index.dirty',
    'import.lock',
    'secrets.json',
    '.magpie-agent.json',
    '.magpie-agent.state.json',
    '.magpie-agent.config-backup.json'
  ])
  const mine = new Set()
  const myLinks = new Set()
  const skipped = []
  const walk = (dir, prefix) => {
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      skipped.push({ dir, error: e.message })
      return
    }
    for (const ent of ents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (EXCLUDED_FILES.has(ent.name)) continue
      let st
      try {
        st = fs.lstatSync(abs)
      } catch (e) {
        skipped.push({ rel, error: e.message })
        continue
      }
      if (st.isSymbolicLink()) {
        myLinks.add(rel)
        continue // 不跟进：真实 skills 下 3 条 junction 指向外部仓库
      }
      if (st.isDirectory()) walk(abs, rel)
      else mine.add(rel)
    }
  }
  walk(HOME, '')

  const onlyInScan = [...scanPaths].filter((p) => !mine.has(p))
  const onlyInMine = [...mine].filter((p) => !scanPaths.has(p))
  const linkOnlyScan = [...scanLinks].filter((p) => !myLinks.has(p))
  const linkOnlyMine = [...myLinks].filter((p) => !scanLinks.has(p))

  const topOf = (s) => {
    const m = {}
    for (const p of s) {
      const t = p.split('/')[0]
      m[t] = (m[t] || 0) + 1
    }
    return m
  }

  console.log(
    JSON.stringify(
      {
        home: HOME,
        scanMs,
        scanFiles: scanPaths.size,
        mineFiles: mine.size,
        scanLinks: scanLinks.size,
        mineLinks: myLinks.size,
        onlyInScan: onlyInScan.slice(0, 20),
        onlyInScanCount: onlyInScan.length,
        onlyInMine: onlyInMine.slice(0, 20),
        onlyInMineCount: onlyInMine.length,
        linkOnlyScan,
        linkOnlyMine,
        excludedReported: scan.excluded,
        topsScan: topOf(scanPaths),
        topsMine: topOf(mine),
        skipped
      },
      null,
      1
    )
  )
  fs.rmSync(OUT, { force: true })
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
