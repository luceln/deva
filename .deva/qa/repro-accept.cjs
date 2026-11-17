/** repro-accept.ts 的 runner：每个场景一个独立进程（被测模块有模块级缓存）。 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const ROOT = process.env.QA_SRC || path.resolve(QA, '..', '..')
const DIST = path.join(QA, 'dist')
const STUB = path.join(QA, 'stub-electron.cjs')
const TMP_ROOT = path.join(os.tmpdir(), 'deva-accept')
const ALL = [
  'p0turn', 'p0ckpt', 'skipsess', 'skipsec', 'unread', 'stalem', 'writefail', 'reason2',
  'assocblk', 'assocprt', 'compbad', 'memread', 'readabsent', 'guardpath', 'srcread', 'srcdir',
  'gatepartial',
  // getSecret 三态：三种环境各跑一次（同一份代码，环境变量不同）
  'secret@TEST_NOTHING=1',
  'secret@TEST_DECRYPT_FAILS=1',
  'secret@TEST_NO_ENCRYPTION=1',
  'skilllex',
  'srcfile',
  'secinvalid',
  'writereason',
  'mcp',
  'skillbrk'
]

const SCENARIOS = process.argv.slice(2).filter((a) => !a.startsWith('--'))

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(ROOT, '.deva', 'qa', 'repro-accept.ts')
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
    outfile: path.join(DIST, 'repro-accept.cjs'),
    alias: { electron: STUB },
    nodePaths,
    external: ['electron'],
    logLevel: 'warning'
  })
  console.log(`bundle ok → dist/repro-accept.cjs（源码树：${ROOT}）`)
}

function runOne(name) {
  return new Promise((resolve) => {
    const root = path.join(TMP_ROOT, `${name}-${Date.now()}`)
    for (const d of ['home', 'appdata', 'scratch']) fs.mkdirSync(path.join(root, d), { recursive: true })
    /*
     * 场景名支持 `name@ENV=VAL,ENV2=VAL2` 后缀：同一份代码要在**不同环境变量**下各跑一次
     * （getSecret 三态要靠 TEST_DECRYPT_FAILS / TEST_NO_ENCRYPTION 区分，同进程里改不了——
     * stub 的值是进程级常量，而且 secrets 模块还把 store 缓存在内存里）。
     */
    const [base, envSpec] = name.split('@')
    const extra = {}
    if (envSpec) {
      for (const kv of envSpec.split(',')) {
        const [k, v] = kv.split('=')
        if (k) extra[k] = v ?? '1'
      }
    }
    const env = {
      ...process.env,
      ...extra,
      TEST_HOME: path.join(root, 'home'),
      TEST_APPDATA: path.join(root, 'appdata'),
      TEST_TMP: root,
      USERPROFILE: path.join(root, 'home'),
      HOME: path.join(root, 'home'),
      DEVA_HOME: path.join(root, 'dst'),
      QA_SCRATCH: path.join(root, 'scratch')
    }
    const child = spawn(process.execPath, [path.join(DIST, 'repro-accept.cjs'), base], {
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
      `${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.name.padEnd(9)} pass=${String(passCount).padStart(3)} fail=${failLines.length} exit=${r.code}`
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
