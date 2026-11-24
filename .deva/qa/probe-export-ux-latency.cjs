/**
 * 实测导出各阶段耗时与「点击到第一个进度事件」的延迟。
 *
 * 背景：用户报「点导出后约 1 分钟毫无反应，然后才在按钮上有进度」。
 * 这个脚本用来量化那段空白期到底花在哪、修完之后是否真的消失。
 *
 * 用法：
 *   node .deva/qa/probe-export-ux-latency.cjs
 *   UX_ATTACH=200 UX_ATTACH_MB=4 UX_SESSIONS=260 node .deva/qa/probe-export-ux-latency.cjs
 *
 * 退出码：任何一条验收判据 FAIL 时为 1。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist', 'ux')

/** 规模：可用环境变量调，默认贴近用户真实规模。 */
const SESSIONS = Number(process.env.UX_SESSIONS || 220)
const MSG_PER_SESSION = Number(process.env.UX_MSGS || 60)
const ATTACH_COUNT = Number(process.env.UX_ATTACH || 90)
const ATTACH_MB = Number(process.env.UX_ATTACH_MB || 4)
const CP_COUNT = Number(process.env.UX_CP || 900)
const TOOL_COUNT = Number(process.env.UX_TOOL || 700)
const SKILLS = Number(process.env.UX_SKILLS || 40)
const PROJECTS = Number(process.env.UX_PROJ || 25)

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { exportBundle } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-export.ts'))}
export { scanHome, hashFiles } from ${JSON.stringify(path.join(SRC, 'main/services/bundle-manifest.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'export-ux.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'export-ux.cjs'))
}

/** 造一份贴近真实的 home。 */
function makeHome(root) {
  const home = path.join(root, 'home')
  const dirs = {
    chats: path.join(home, 'data/chats'),
    media: path.join(home, 'data/media'),
    cp: path.join(home, 'data/checkpoints'),
    tool: path.join(home, 'data/tool-results'),
    skills: path.join(home, 'skills'),
    projects: path.join(home, 'projects')
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })

  // 会话：每节 60 条消息，带工具调用
  for (let i = 0; i < SESSIONS; i++) {
    const msgs = Array.from({ length: MSG_PER_SESSION }, (_, k) => ({
      role: k % 2 ? 'user' : 'assistant',
      content: 'x'.repeat(400) + ` #${i}-${k}`,
      at: Date.now() - k * 60000,
      ...(k % 7 === 0 ? { toolCalls: [{ id: `t${i}-${k}`, name: 'read_file', args: { path: 'a.ts' } }] } : {})
    }))
    fs.writeFileSync(
      path.join(dirs.chats, `s-${i}.json`),
      JSON.stringify({ id: `s-${i}`, title: `会话 ${i}`, messages: msgs, updatedAt: Date.now() })
    )
  }

  // 附件：MB 级随机字节（模拟图片，不可压缩）
  for (let i = 0; i < ATTACH_COUNT; i++) {
    fs.writeFileSync(path.join(dirs.media, `img-${i}.bin`), crypto.randomBytes(ATTACH_MB * 1024 * 1024))
  }

  // checkpoint：多而小
  for (let i = 0; i < CP_COUNT; i++) {
    fs.mkdirSync(path.join(dirs.cp, `s-${i % SESSIONS}`), { recursive: true })
    fs.writeFileSync(
      path.join(dirs.cp, `s-${i % SESSIONS}`, `cp-${i}.json`),
      JSON.stringify({ i, pad: 'y'.repeat(20000) })
    )
  }

  // 工具结果：中量、小文件
  for (let i = 0; i < TOOL_COUNT; i++) {
    fs.writeFileSync(path.join(dirs.tool, `tr-${i}.json`), JSON.stringify({ i, out: 'z'.repeat(8000) }))
  }

  // 技能
  for (let i = 0; i < SKILLS; i++) {
    const d = path.join(dirs.skills, `skill-${i}`)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), `# skill ${i}\n` + 'a'.repeat(2000))
  }

  // 项目
  for (let i = 0; i < PROJECTS; i++) {
    const d = path.join(dirs.projects, `p-${i}`)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ i, root: `E:/p/${i}` }))
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ i, pad: 'b'.repeat(3000) }))
  }

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ theme: 'dark', locale: 'zh-CN' }))
  fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({ version: 2, entries: [] }))

  return home
}

const now = () => Number(process.hrtime.bigint()) / 1e6
const round = (n) => Math.round(n)

async function main() {
  const M = await build()
  const root = path.join(os.tmpdir(), `deva-ux-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })

  const tMake = now()
  const home = makeHome(root)
  process.env.DEVA_HOME = home
  const makeMs = now() - tMake
  const totalBytes = (() => {
    let b = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else b += fs.statSync(p).size
      }
    }
    walk(home)
    return b
  })()
  console.log(
    `夹具：${SESSIONS} 会话 × ${MSG_PER_SESSION} 条，附件 ${ATTACH_COUNT}×${ATTACH_MB}MB，` +
      `checkpoint ${CP_COUNT}，tool-results ${TOOL_COUNT}，技能 ${SKILLS}，项目 ${PROJECTS}`
  )
  console.log(`  总字节 ${(totalBytes / 1048576).toFixed(1)}MB，造数据 ${round(makeMs)}ms\n`)

  /* ── 逐阶段单独计时（不看 exportBundle 总和） ── */
  console.log('阶段耗时（单独跑，用于对照）：')
  let tA = now()
  let scanTicks = 0
  const scan = await M.scanHome(home, () => {
    scanTicks += 1
  })
  const scanMs = now() - tA
  console.log(
    `  1. scanHome（递归 lstat）              ${round(scanMs).toString().padStart(6)}ms  ` +
      `${scan.files.length} 文件 / ${(scan.bytes / 1048576).toFixed(1)}MB，tick ${scanTicks} 次`
  )

  tA = now()
  let hashTicks = 0
  const totalHash = scan.files.length
  await M.hashFiles(home, scan, (d, t) => {
    hashTicks += 1
    if (d === t) hashTicks = hashTicks // 收尾也算在内
  })
  const hashMs = now() - tA
  console.log(
    `  2. hashFiles（逐文件算 sha256）        ${round(hashMs).toString().padStart(6)}ms  ` +
      `tick ${hashTicks} 次 / ${totalHash} 文件（已节流）`
  )

  /* ── 全流程 + 进度事件时间线 ── */
  const tClick = now()
  let firstEvent = null
  const log = []
  const exp = await M.exportBundle({
    targetPath: path.join(root, 'o.dbk'),
    onProgress: (p) => {
      const at = now() - tClick
      log.push({ step: p.step, done: p.done, total: p.total, at })
      if (firstEvent === null) firstEvent = at
    }
  })
  const fullMs = now() - tClick

  console.log(`  3. exportBundle 全流程                ${round(fullMs).toString().padStart(6)}ms`)
  console.log(`     结果 ok=${exp.ok}，文件 ${exp.files}，包 ${(exp.bytes / 1048576).toFixed(1)}MB`)

  console.log('\n进度事件时间线：')
  console.log(`  事件总数 ${log.length}`)
  const byStep = new Map()
  for (const e of log) {
    if (!byStep.has(e.step)) byStep.set(e.step, { count: 0, firstAt: e.at, lastAt: e.at, first: e })
    const s = byStep.get(e.step)
    s.count += 1
    s.lastAt = e.at
    s.last = e
  }
  for (const [step, s] of byStep) {
    console.log(
      `    ${step.padEnd(6)} 首次 ${round(s.firstAt).toString().padStart(5)}ms  ` +
        `${String(s.count).padStart(4)} 次  跨度 ${round(s.lastAt - s.firstAt)}ms`
    )
  }
  console.log(
    `  首个进度事件：${firstEvent === null ? '**从未到达**' : round(firstEvent) + 'ms'}` +
      (firstEvent === null ? '' : `（总耗时 ${round(fullMs)}ms 的 ${((firstEvent / fullMs) * 100).toFixed(1)}%）`)
  )

  /* ── 验收判据 ── */
  console.log('\n验收：')
  let fails = 0
  const check = (label, cond, detail) => {
    if (!cond) fails += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label} :: ${detail}`)
  }

  check(
    '首个进度事件 < 1000ms',
    firstEvent !== null && firstEvent < 1000,
    firstEvent === null ? '从未到达' : `${round(firstEvent)}ms`
  )
  check(
    '三段（scan / hash / write）都出现',
    byStep.has('scan') && byStep.has('hash') && byStep.has('write'),
    [...byStep.keys()].join(' / ')
  )
  const scanEvents = log.filter((e) => e.step === 'scan')
  check(
    'scan 报计数而非百分比（total 恒为 0）',
    scanEvents.length > 0 && scanEvents.every((e) => e.total === 0),
    scanEvents.length ? `首个 total=${scanEvents[0].total}，共 ${scanEvents.length} 次` : '无 scan 事件'
  )
  const hashLast = log.filter((e) => e.step === 'hash').pop()
  check(
    'hash 收尾 done === total',
    !!hashLast && hashLast.done === hashLast.total,
    hashLast ? `${hashLast.done}/${hashLast.total}` : '无 hash 事件'
  )
  const writeLast = log.filter((e) => e.step === 'write').pop()
  check(
    'write 收尾 done === total',
    !!writeLast && writeLast.done === writeLast.total,
    writeLast ? `${writeLast.done}/${writeLast.total}` : '无 write 事件'
  )
  /*
   * 全局上限：任何一步都不能 done > total。
   *
   * 防的是「total 漏算某一类文件」：`write` 段的 total 曾经漏了符号链接目标副本，
   * 而循环里每个副本都 tick() —— 有链接时 done 就会超过 total，界面显示「2003/2002」。
   * 上面那条「收尾 done === total」在**没有链接**的夹具上照样 PASS，抓不到它。
   */
  const overrun = log.filter((e) => e.total > 0 && e.done > e.total)
  check(
    '任何步骤都没有 done > total（total 没漏算某类文件）',
    overrun.length === 0,
    overrun.length ? overrun.map((e) => `${e.step} ${e.done}/${e.total}`).join(', ') : `共 ${log.length} 个事件`
  )
  const hashCount = log.filter((e) => e.step === 'hash').length
  check(
    'hash 的 tick 已节流（事件数远少于文件数）',
    hashCount < scan.files.length,
    `${hashCount} 次事件 / ${scan.files.length} 个文件`
  )

  fs.rmSync(root, { recursive: true, force: true })
  console.log(fails === 0 ? '\n==RESULT== ALL PASS' : `\n==RESULT== ${fails} FAIL`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})