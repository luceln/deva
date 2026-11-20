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
/** 仓库里的 Electron 二进制：密钥重加密的 helper 必须以它为可执行文件（见 secret-rekey.ts）。 */
const ELECTRON_BIN = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

const SCENARIOS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const KEEP = process.argv.includes('--keep')
const SEEDED = process.argv.includes('--seeded')
const ALL = ['memberwt', 'full', 'sweep', 'memidem', 'budget', 'broken', 'writefail', 'mcp', 'mcpsrc', 'mcptgt', 'mcpipc', 'mcpunsafe', 'keyless', 'keytri', 'keydecrypt', 'keynoenc', 'cfgcorrupt', 'cfgabsent', 'swapfail', 'kindcopy', 'swapws', 'blockedturn', 'secretscorrupt', 'secretsabsent', 'swapcand', 'blockedlist', 'wtpaths', 'wtstore', 'wtprecheck', 'wtcreate', 'wtremove', 'wtbrief', 'wtsweep', 'wtlock', 'worktree', 'insatt', 'rekey', 'plugmgr', 'sessync', 'memcond', 'wtmerge', 'dangclass', 'locks', 'nosource', 'empty', 'gate', 'skills', 'resume', 'xproc', 'personas']

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

/** 场景名 → 实际场景 + 该场景需要的环境变量（同一段代码在不同环境下各跑一遍）。 */
const ENV_OF = {
  keydecrypt: { scenario: 'keytri', env: { TEST_DECRYPT_FAILS: '1' } },
  keynoenc: { scenario: 'keytri', env: { TEST_NO_ENCRYPTION: '1' } },
  cfgcorrupt: { scenario: 'cfgcorrupt', env: { P13_KIND: 'corrupt' } },
  cfgabsent: { scenario: 'cfgcorrupt', env: { P13_KIND: 'absent' } },
  secretscorrupt: { scenario: 'secretskind', env: { S42_KIND: 'corrupt' } },
  secretsabsent: { scenario: 'secretskind', env: { S42_KIND: 'absent' } },
  /*
   * 反向验证：假装没装插件（托管集判空），跑同一段 full。
   * 期望结果是**变红**——证明「插件托管豁免」不是放行所有悬空，这条断言真的在守东西。
   *
   * 它不该出现在 ALL 里（默认必须全绿），要单独跑：
   *   node .deva/qa/driver.cjs noplugin   → 期望非 0 退出码 + 那几条 FAIL
   */
  noplugin: { scenario: 'full', env: { QA_NO_PLUGIN: '1' } }
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

    const spec = ENV_OF[name] ?? { scenario: name, env: {} }
    const env = {
      ...process.env,
      ...spec.env,
      TEST_HOME: home,
      TEST_APPDATA: appdata,
      TEST_TMP: root,
      USERPROFILE: home, // os.homedir() 跟着走
      HOME: home,
      DEVA_HOME: dst,
      QA_REAL: REAL_HOME,
      QA_SEEDED: SEEDED ? '1' : '0',
      QA_SCRATCH: scratch,
      /*
       * 记忆压缩场景要真的发 HTTP（用本地服务当模型）。`http.ts` 默认走 Electron 的请求池
       * （`session.fromPartition`，Chromium 网络栈），QA 进程里没有那个运行时。
       * 产品代码本来就有这个开关，这里只是打开它——不是为测试加的分叉。
       *
       * 必须在**起进程时**设：`USE_NODE` 是模块顶层的 const，运行时再改环境变量已经晚了。
       */
      ...(name === 'memcond' ? { DEVA_HTTP: 'node' } : {}),
      /*
       * rekey 场景要起一个**真的 Electron**子进程去解原版密文（`safeStorage` 在 QA 里是桩，
       * 造不出真 v10 密文）。但 QA 进程自己跑在 node 下，`process.execPath` 是 node.exe，
       * 所以显式把仓库里的 Electron 二进制传下去。
       */
      /*
       * 密钥导入要起**真的 Electron** 子进程去解原版密文（`safeStorage` 在 QA 里是桩，造不出真 v10
       * 密文；而跨应用重加密这条链路本来就依赖真 Electron）。所有场景都传：`full` 拿真实 ~/.deva
       * 当源时，里面正是原版密文，传了才是真机路径的验证；没传则一律落 unrecoverable。
       *
       * 只在二进制存在时传：CI / 未装 electron 依赖时退化成「起不来 → 降级」，断言会如实反映，
       * 而不是让 spawn 抛一个和产品逻辑无关的 ENOENT。
       */
      ...(fs.existsSync(ELECTRON_BIN) ? { DEVA_ELECTRON_BIN: ELECTRON_BIN } : {})
    }
    const label = SEEDED && name === 'full' ? 'full(seeded)' : name
    const child = spawn(process.execPath, [path.join(DIST, 'test.cjs'), spec.scenario], {
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
