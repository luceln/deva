/** repro-2b.ts 的 runner：每个场景一个独立进程（被测模块有模块级缓存）。 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const ROOT = process.env.QA_SRC || path.resolve(QA, '..', '..')
const DIST = path.join(QA, 'dist')
const STUB = path.join(QA, 'stub-electron.cjs')
const TMP_ROOT = path.join(os.tmpdir(), 'deva-2b')
const ALL = ['stale', 'throwpath', 'merge', 'writefail', 'exclude']

const SCENARIOS = process.argv.slice(2).filter((a) => !a.startsWith('--'))

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(ROOT, '.deva', 'qa', 'repro-2b.ts')
  if (!fs.existsSync(entry)) throw new Error(`找不到被测入口：${entry}`)
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
    outfile: path.join(DIST, 'repro-2b.cjs'),
    alias: { electron: STUB },
    nodePaths,
    external: ['electron'],
    logLevel: 'warning'
  })
  console.log(`bundle ok → dist/repro-2b.cjs（源码树：${ROOT}）`)
}

function runOne(name) {
  return new Promise((resolve) => {
    const root = path.join(TMP_ROOT, `${name}-${Date.now()}`)
    for (const d of ['home', 'appdata', 'scratch']) fs.mkdirSync(path.join(root, d), { recursive: true })
    const env = {
      ...process.env,
      TEST_HOME: path.join(root, 'home'),
      TEST_APPDATA: path.join(root, 'appdata'),
      TEST_TMP: root,
      USERPROFILE: path.join(root, 'home'),
      HOME: path.join(root, 'home'),
      DEVA_HOME: path.join(root, 'dst'),
      QA_SCRATCH: path.join(root, 'scratch')
    }
    const child = spawn(process.execPath, [path.join(DIST, 'repro-2b.cjs'), name], {
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
      } catch {}
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
    console.log(
      `${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.name.padEnd(10)} pass=${String(passCount).padStart(3)} fail=${failLines.length} exit=${r.code}`
    )
    for (const f of failLines) console.log(`        ✗ ${f.slice(5)}`)
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {}
  process.exit(bad > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
