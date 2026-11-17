/**
 * P0 复现脚本的运行器：打包 repro-p0.ts → 每个场景一个独立进程（被测模块有模块级缓存）。
 *
 *   node .deva/qa/repro-p0.cjs            # 两个场景都跑
 *   node .deva/qa/repro-p0.cjs p0race     # 只跑竞态
 *   QA_SRC=/path/to/tree node ...         # 指定被测源码树（用于「修前/修后」对比）
 *
 * 环境与 driver.cjs 同一套契约：USERPROFILE/HOME 指向临时 home（os.homedir() 跟随它）、DEVA_HOME 指向临时目标。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const ROOT = process.env.QA_SRC || path.resolve(QA, '..', '..')
const DIST = path.join(QA, 'dist')
const STUB = path.join(QA, 'stub-electron.cjs')
const TMP_ROOT = path.join(os.tmpdir(), 'deva-p0')

const SCENARIOS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const ALL = ['p0fail', 'p0race', 'p0home']

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(ROOT, '.deva', 'qa', 'repro-p0.ts')
  if (!fs.existsSync(entry)) throw new Error(`找不到被测入口：${entry}`)
  // 被测源码树可能是 git worktree（没有 node_modules）：把本仓的依赖目录也放进解析路径，
  // 否则 fflate 这类三方依赖会解析不到。本仓优先，保证与现状一致。
  const selfRepo = path.resolve(QA, '..', '..')
  const nodePaths = [
    path.join(selfRepo, 'node_modules'),
    path.join(selfRepo, 'apps', 'desktop', 'node_modules'),
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, 'apps', 'desktop', 'node_modules')
  ].filter((p) => fs.existsSync(p))
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'repro-p0.cjs'),
    alias: { electron: STUB },
    nodePaths,
    logLevel: 'warning',
    external: ['electron']
  })
  console.log(`bundle ok → dist/repro-p0.cjs（源码树：${ROOT}）`)
}

function runOne(name) {
  return new Promise((resolve) => {
    const root = path.join(TMP_ROOT, `${name}-${Date.now()}`)
    const home = path.join(root, 'home')
    const appdata = path.join(root, 'appdata')
    const dst = path.join(root, 'dst')
    const scratch = path.join(root, 'scratch')
    for (const d of [home, appdata, scratch]) fs.mkdirSync(d, { recursive: true })

    const env = {
      ...process.env,
      TEST_HOME: home,
      TEST_APPDATA: appdata,
      TEST_TMP: root,
      USERPROFILE: home,
      HOME: home,
      DEVA_HOME: dst,
      QA_SCRATCH: scratch
    }
    const child = spawn(process.execPath, [path.join(DIST, 'repro-p0.cjs'), name], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
      process.stdout.write(String(d))
    })
    child.stderr.on('data', (d) => {
      out += String(d)
      process.stderr.write(String(d))
    })
    child.on('close', (code) => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      resolve({ name, code, out })
    })
  })
}

async function main() {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  await build()
  const list = SCENARIOS.length ? SCENARIOS : ALL
  const results = []
  for (const n of list) results.push(await runOne(n))
  console.log('\n================ 汇总 ================')
  let bad = 0
  for (const r of results) {
    const failLines = r.out.split('\n').filter((l) => l.startsWith('FAIL '))
    const passCount = r.out.split('\n').filter((l) => l.startsWith('PASS ')).length
    if (r.code !== 0) bad++
    console.log(`${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.name.padEnd(8)} pass=${String(passCount).padStart(3)} fail=${failLines.length} exit=${r.code}`)
    for (const f of failLines) console.log(`        ✗ ${f.slice(5)}`)
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(bad > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
