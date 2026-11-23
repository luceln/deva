/**
 * 真机验证 runner：工作区页「根目录设置」的 IPC 往返。
 *
 * 分阶段起多次 Electron（真实重启，验证配置持久化）：
 *
 *   main          1/2/3/4 项 —— root() 往返、setRoot 自定义、setRoot(undefined)、非法路径拒绝
 *   write-custom  设自定义根，然后退出
 *   verify-custom 新进程只读，核对自定义根还在（= 重启后仍在）
 *   write-reset   恢复默认，然后退出
 *   verify-reset  新进程只读，核对已回到默认
 *
 * 为什么必须分进程：`getConfig()` / `getDevaHome()` / worktree store 全是**模块级缓存**，
 * 同一进程里「写完再读」读的是缓存，证明不了持久化。分进程才是真的重启。
 *
 * 隔离：见 main-runner.ts 头部。这里额外负责
 *   · 在 Electron 起来**之前**设 DEVA_HOME（`getDevaHome()` 第一次读就缓存）
 *   · 预置 `worktrees.json`（`store.ts` 在模块加载时把它读进内存，进程内再写看不见）
 *
 * 截图：由 `shot.cjs` 单独跑（需要真窗口 + `--remote-debugging-port`），本 runner 不截图。
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..', '..')
const DIST = path.join(QA, 'dist')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 临时根：全部隔离产物都在这里面，跑完只删这一个目录。 */
const ROOT = process.env.QA_KEEP_ROOT || path.join(os.tmpdir(), `deva-wtroot-${Date.now()}`)
const RESULT = path.join(ROOT, 'result.txt')
const DEVA_HOME = path.join(ROOT, 'deva-home')
const CUSTOM_ROOT = path.join(ROOT, 'custom-worktrees')

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(QA, 'main-runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'main-runner.cjs'),
    external: ['electron'],
    logLevel: 'warning'
  })
  console.log('bundle ok → dist/main-runner.cjs')
}

/**
 * 预置 `worktrees.json`：登记一个仓库（本仓库），让「根落在仓库内」能被 `isInsideRepo` 识别。
 *
 * 必须在 Electron 启动前写 —— `store.ts` 的 `ensureLoaded()` 在模块首次使用时把文件读进内存，
 * 之后再写文件不会被看见（这就是为什么第 4 项要放在单独一轮，而不是同进程里先写再测）。
 *
 * **字段必须齐全**：`ensureLoaded()` 逐条校验 `path` / `compareKey` / `branch` / `baseSha` /
 * `phase`，缺一个就 `continue` **静默跳过**（不报错、不影响其余记录）。第一版少了
 * `compareKey` / `baseSha` / `phase`，于是 `listRecords()` 返回 0 条，`rejectReason()` 的
 * 仓库集合是空的，任何「根落在仓库内」都不再被拒 —— 实测表现为 `setRoot('E:\deva\apps')`
 * 返回 `ok:true`，看起来像实现漏了校验，其实是夹具不合格。
 */
function seedRecords() {
  fs.mkdirSync(DEVA_HOME, { recursive: true })
  const relPath = path.join('worktrees', 'deva', 'probe-zzzz')
  const rec = {
    schemaVersion: 1,
    records: [
      {
        path: path.join(DEVA_HOME, relPath),
        // compareKey 是「同一个路径」的归一化键；store 以它为主键查表
        compareKey: relPath.replace(/\\/g, '/').toLowerCase(),
        branch: 'probe-zzzz',
        baseSha: '0000000000000000000000000000000000000000',
        phase: 'active',
        repoRoot: REPO,
        baseBranch: 'dev',
        createdAt: Date.now()
      }
    ]
  }
  fs.writeFileSync(path.join(DEVA_HOME, 'worktrees.json'), JSON.stringify(rec, null, 2))
}

function runPhase(phase) {
  return new Promise((resolve) => {
    /*
     * 每个阶段用**独立的 result 文件**。
     *
     * 第一版共用一份，结果 `runPhase` 每次都把整份文件读回来，
     * 第 2 阶段会把第 1 阶段的 FAIL 再算一遍 —— 实测 5 条真 FAIL 被报成 15 条。
     */
    const phaseResult = path.join(ROOT, `result-${phase}.txt`)
    fs.writeFileSync(phaseResult, '')
    const env = {
      ...process.env,
      DEVA_HOME,
      QA_RESULT: phaseResult,
      QA_ROOT: ROOT,
      QA_PHASE: phase,
      QA_REPO_ROOT: REPO,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
    const child = spawn(ELECTRON, [path.join(DIST, 'main-runner.cjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let buf = ''
    child.stdout.on('data', (d) => {
      const s = String(d)
      buf += s
      process.stdout.write(s)
    })
    child.stderr.on('data', (d) => {
      const s = String(d)
      // 过滤 GPU/sandbox 之类的无意义噪音
      if (!/GPU|gpu_|sandbox|DevTools|Fontconfig|libva|Vulkan|d3d11|angle|Network service|disk_cache|CreateInstance|dxgi|vulkan/i.test(s)) {
        process.stderr.write(s)
      }
    })
    child.on('close', (code) => {
      console.log(`--- 阶段 ${phase} 退出码 ${code} ---`)
      const txt = fs.existsSync(phaseResult) ? fs.readFileSync(phaseResult, 'utf8') : ''
      const fails = txt.split('\n').filter((l) => l.startsWith('FAIL '))
      const passes = txt.split('\n').filter((l) => l.startsWith('PASS '))
      resolve({ code, fails, passes, txt })
    })
  })
}

async function main() {
  console.log(`临时根: ${ROOT}`)
  console.log(`DEVA_HOME: ${DEVA_HOME}`)
  console.log('')
  fs.mkdirSync(ROOT, { recursive: true })
  fs.writeFileSync(RESULT, '')
  seedRecords()

  const phases = ['main', 'write-custom', 'verify-custom', 'write-reset', 'verify-reset']
  const allFails = []
  let totalPass = 0
  for (const p of phases) {
    console.log(`\n===== 阶段 ${p} =====`)
    const { code, fails, passes } = await runPhase(p)
    allFails.push(...fails)
    totalPass += passes.length
    if (code !== 0 && fails.length === 0) {
      allFails.push(`FAIL 阶段 ${p} 异常退出（code=${code}）且没有失败行 —— 可能没跑到脚本`)
    }
  }

  const passCount = totalPass
  console.log(`\n===== 汇总：PASS=${passCount} FAIL=${allFails.length} =====`)
  for (const f of allFails) console.log(`  ✗ ${f.slice(5)}`)

  if (process.env.QA_KEEP) {
    console.log(`\n（QA_KEEP=1，保留 ${ROOT} 供检查）`)
    return allFails.length === 0 ? 0 : 1
  }
  // 只删自己建的那一个临时目录
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
    console.log(`已清理临时目录: ${ROOT}`)
  } catch (e) {
    console.log(`清理失败（请手动删）: ${ROOT} —— ${e.message}`)
  }
  return allFails.length === 0 ? 0 : 1
}

build()
  .then(main)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e)
    process.exit(3)
  })