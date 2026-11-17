/**
 * 导入功能独立验证——运行器。
 *
 * 每个场景一个独立进程（被测模块里有模块级缓存：config / secrets / home，同进程无法重置）。
 * 全部临时目录建在 os.tmpdir() 下，真实 ~/.deva 只作为「复制源」被读，绝不被写。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const DIST = path.join(QA, 'dist')
const STUB = path.join(QA, 'stub-electron.cjs')
const REAL_HOME = path.join(os.homedir(), '.deva')
const TMP_ROOT = path.join(os.tmpdir(), 'deva-qa')

const SCENARIOS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const KEEP = process.argv.includes('--keep')
const SEEDED = process.argv.includes('--seeded')
const ALL = ['full', 'sweep', 'memidem', 'budget', 'broken', 'writefail', 'mcp', 'mcpsrc', 'mcptgt', 'locks', 'nosource', 'empty', 'gate', 'skills', 'resume', 'xproc', 'personas']

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(QA, 'test-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'test.cjs'),
    alias: { electron: STUB },
    logLevel: 'warning',
    // 只外置 node 内置模块；其余全部打进 bundle
    external: ['electron']
  })
  console.log('bundle ok → dist/test.cjs')
}

function runOne(name) {
  return new Promise((resolve) => {
    const root = path.join(TMP_ROOT, `${name}-${Date.now()}`)
    const home = path.join(root, 'home')
    const appdata = path.join(root, 'appdata')
    const dst = path.join(root, 'dst')
    const scratch = path.join(root, 'scratch')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appdata, { recursive: true })
    fs.mkdirSync(scratch, { recursive: true })

    const env = {
      ...process.env,
      TEST_HOME: home,
      TEST_APPDATA: appdata,
      TEST_TMP: root,
      USERPROFILE: home, // os.homedir() 跟着走
      HOME: home,
      DEVA_HOME: dst,
      QA_REAL: REAL_HOME,
      QA_SEEDED: SEEDED ? '1' : '0',
      QA_SCRATCH: scratch
    }
    const label = SEEDED && name === 'full' ? 'full(seeded)' : name
    const child = spawn(process.execPath, [path.join(DIST, 'test.cjs'), name], {
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
      if (!KEEP) {
        try {
          fs.rmSync(root, { recursive: true, force: true })
        } catch (e) {
          console.log(`（临时目录清理失败：${root}）`)
        }
      }
      resolve({ name: label, code, out })
    })
  })
}

async function main() {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  await build()
  const list = SCENARIOS.length ? SCENARIOS : ALL
  const results = []
  for (const name of list) results.push(await runOne(name))

  console.log('\n================ 汇总 ================')
  let failScenarios = 0
  for (const r of results) {
    const failLines = r.out
      .split('\n')
      .filter((l) => l.startsWith('FAIL '))
      .map((l) => l.slice(5))
    const passCount = r.out.split('\n').filter((l) => l.startsWith('PASS ')).length
    if (r.code !== 0) failScenarios++
    console.log(
      `${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.name.padEnd(9)} pass=${String(passCount).padStart(3)} fail=${failLines.length} exit=${r.code}`
    )
    for (const f of failLines) console.log(`        ✗ ${f}`)
  }
  console.log(`\n共 ${results.length} 个场景，其中 ${failScenarios} 个有失败。`)
  try {
    if (!KEEP) fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(failScenarios > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
