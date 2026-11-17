/**
 * 真机验证 runner（方案 C）：完整导入 + 导入期间发消息。
 *
 * 隔离手段（全部在 Electron 内部完成，不改源码）：
 *   - electron 用真实 USERPROFILE/APPDATA 启动（覆盖会让 Electron 33 静默退出 0x80000003）
 *   - 启动后 main-runner 里改写 process.env.USERPROFILE → upstreamHome() 指向临时目录
 *   - app.setPath('appData', 临时) → upstreamLockPath() 不再碰真实原版的锁
 *   - DEVA_HOME → 临时目标目录
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

function main() {
  const root = path.join(os.tmpdir(), `deva-real-${Date.now()}`)
  const dst = path.join(root, 'dst')
  const resultFile = path.join(root, 'result.txt')
  fs.mkdirSync(dst, { recursive: true })
  fs.writeFileSync(resultFile, '')

  const env = { ...process.env, DEVA_HOME: dst, QA_RESULT: resultFile, QA_ROOT: root, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  console.log(`临时根: ${root}`)
  console.log('启动 electron.exe …')

  const child = spawn(ELECTRON, [path.join(DIST, 'main-runner.cjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += String(d)
    process.stdout.write(String(d))
  })
  child.stderr.on('data', (d) => {
    const s = String(d)
    out += s
    if (!/GPU|gpu_|sandbox|DevTools|Fontconfig|libva|Vulkan|d3d11|angle|Network service|disk_cache/i.test(s)) {
      process.stderr.write(s)
    }
  })
  child.on('close', (code) => {
    console.log(`\n--- electron 退出码 ${code} ---`)
    let txt = ''
    try {
      txt = fs.readFileSync(resultFile, 'utf8')
    } catch {}
    const failLines = txt.split('\n').filter((l) => l.startsWith('FAIL '))
    const passCount = txt.split('\n').filter((l) => l.startsWith('PASS ')).length
    console.log(`真机结果：PASS=${passCount} FAIL=${failLines.length}`)
    for (const f of failLines) console.log(`  ✗ ${f.slice(5)}`)
    if (!txt.trim()) console.log('（结果文件为空：Electron 没跑到脚本）')
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
    process.exit(code === 0 && failLines.length === 0 ? 0 : 1)
  })
}

build()
  .then(main)
  .catch((e) => {
    console.error(e)
    process.exit(3)
  })
