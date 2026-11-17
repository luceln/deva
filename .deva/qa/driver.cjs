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
const ALL = ['full', 'sweep', 'memidem', 'budget', 'broken', 'writefail', 'mcp', 'mcpsrc', 'mcptgt', 'mcpipc', 'mcpunsafe', 'keyless', 'locks', 'nosource', 'empty', 'gate', 'skills', 'resume', 'xproc', 'personas']

/**
 * 平台夹具不成立的场景：跳过，但**必须显式计数并打印**，不能静默当作通过。
 *
 * 两条都不是产品代码的差异，而是「造这个场景的前提在这台机器上没有」：
 *   full —— 拿真实 ~/.deva 当复制源；CI 与 WSL 里没有这个目录。
 *   gate —— 用 powershell.exe 独占文件模拟「另一个进程占着 lockfile」；非 Windows 无此命令。
 *
 * 跳过数是汇总里单独一行、非零时以非 0 退出码暴露：让人看见「这次少了什么」，
 * 而不是让 15/17 冒充 17/17。
 */
function skipReason(name) {
  const isWin = process.platform === 'win32'
  if (name === 'full' && !fs.existsSync(REAL_HOME)) {
    return `真实源 ${REAL_HOME} 不存在（该场景以它为复制源）`
  }
  if (name === 'gate' && !isWin) {
    return '该场景用 powershell.exe 独占文件造锁，非 Windows 无此命令'
  }
  return null
}


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
  const skipped = []
  for (const name of list) {
    const why = skipReason(name)
    if (why) {
      skipped.push({ name, why })
      continue
    }
    results.push(await runOne(name))
  }

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
  // 跳过项单独列，且写明原因：这部分覆盖这次没有发生，不能算进「全绿」。
  for (const s of skipped) console.log(`SKIP ${s.name.padEnd(9)} ${s.why}`)

  const ran = results.length
  const total = ran + skipped.length
  console.log(
    `\n共 ${total} 个场景：${ran} 个已跑，其中 ${failScenarios} 个有失败；${skipped.length} 个因平台夹具跳过。`
  )
  if (skipped.length > 0) {
    console.log(`本次未覆盖：${skipped.map((s) => s.name).join('、')} —— 这些场景的结论只能由别的平台给。`)
  }
  try {
    if (!KEEP) fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  // 有失败才算红；跳过不红但已在上面点名，且以 --strict 跑时视为未完成。
  const strict = process.argv.includes('--strict')
  process.exit(failScenarios > 0 || (strict && skipped.length > 0) ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
